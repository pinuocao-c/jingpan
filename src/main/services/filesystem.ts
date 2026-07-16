import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TargetSpec } from './catalog'

export interface TaskController {
  cancelled: boolean
}

export interface WalkSummary {
  bytes: number
  files: number
  inaccessible: number
  visited: number
}

export interface DeleteSummary {
  bytes: number
  removed: number
  failed: number
  errors: string[]
}

export interface PathBoundary {
  lexicalRoot: string
  realRoot: string
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
}

export async function createPathBoundary(
  root: string,
  options: { allowLinkedRoot?: boolean } = {}
): Promise<PathBoundary | null> {
  const lexicalRoot = path.resolve(root)
  try {
    const stat = await fs.lstat(lexicalRoot)
    if (!stat.isDirectory()) return null
    if (stat.isSymbolicLink() && !options.allowLinkedRoot) return null
    const realRoot = await fs.realpath(lexicalRoot)
    return { lexicalRoot, realRoot }
  } catch {
    return null
  }
}

export async function isPathSafeWithinBoundary(
  boundary: PathBoundary,
  candidate: string,
  expectedType?: 'file' | 'directory'
): Promise<boolean> {
  try {
    const rootStat = await fs.lstat(boundary.lexicalRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const currentRoot = await fs.realpath(boundary.lexicalRoot)
    if (!samePath(currentRoot, boundary.realRoot)) return false

    const stat = await fs.lstat(candidate)
    if (stat.isSymbolicLink()) return false
    if (expectedType === 'file' && !stat.isFile()) return false
    if (expectedType === 'directory' && !stat.isDirectory()) return false
    const realCandidate = await fs.realpath(candidate)
    return isPathInsideOrEqual(boundary.realRoot, realCandidate)
  } catch {
    return false
  }
}

async function resolvesWithinBoundary(boundary: PathBoundary, candidate: string): Promise<boolean> {
  try {
    const realCandidate = await fs.realpath(candidate)
    return isPathInsideOrEqual(boundary.realRoot, realCandidate)
  } catch {
    return false
  }
}

function fileMatches(target: TargetSpec, name: string, modifiedMs: number, now: number): boolean {
  if (target.includeFile && !target.includeFile(name)) return false
  if (target.minAgeMs && modifiedMs > now - target.minAgeMs) return false
  return true
}

export async function scanTarget(
  target: TargetSpec,
  controller: TaskController,
  onTick?: (summary: WalkSummary) => void
): Promise<WalkSummary> {
  const summary: WalkSummary = { bytes: 0, files: 0, inaccessible: 0, visited: 0 }
  const boundary = await createPathBoundary(target.root)
  if (!boundary) {
    summary.inaccessible += 1
    return summary
  }
  const directories = [boundary.lexicalRoot]
  const now = Date.now()

  while (directories.length > 0 && !controller.cancelled) {
    const directory = directories.pop()!
    if (!(await isPathSafeWithinBoundary(boundary, directory, 'directory'))) {
      summary.inaccessible += 1
      continue
    }
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      summary.inaccessible += 1
      continue
    }

    for (const entry of entries) {
      if (controller.cancelled) break
      const candidate = path.join(directory, entry.name)
      if (!isPathInside(boundary.lexicalRoot, candidate)) continue
      summary.visited += 1

      try {
        const stat = await fs.lstat(candidate)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          if (await resolvesWithinBoundary(boundary, candidate)) directories.push(candidate)
          else summary.inaccessible += 1
        } else if (
          stat.isFile()
          && fileMatches(target, entry.name, stat.mtimeMs, now)
          && await resolvesWithinBoundary(boundary, candidate)
        ) {
          summary.bytes += stat.size
          summary.files += 1
        }
      } catch {
        summary.inaccessible += 1
      }

      if (summary.visited % 300 === 0) onTick?.(summary)
    }
  }
  onTick?.(summary)
  return summary
}

export async function cleanTarget(
  target: TargetSpec,
  controller: TaskController,
  onTick?: (summary: DeleteSummary) => void
): Promise<DeleteSummary> {
  const summary: DeleteSummary = { bytes: 0, removed: 0, failed: 0, errors: [] }
  const boundary = await createPathBoundary(target.root)
  if (!boundary) {
    summary.failed += 1
    summary.errors.push(`已跳过不安全或不可访问的清理目录：${target.root}`)
    return summary
  }
  const directories = [boundary.lexicalRoot]
  const now = Date.now()

  while (directories.length > 0 && !controller.cancelled) {
    const directory = directories.pop()!
    if (!(await isPathSafeWithinBoundary(boundary, directory, 'directory'))) {
      summary.failed += 1
      continue
    }

    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (controller.cancelled) break
      const candidate = path.join(directory, entry.name)
      if (!isPathInside(boundary.lexicalRoot, candidate)) continue

      try {
        const stat = await fs.lstat(candidate)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          if (await isPathSafeWithinBoundary(boundary, candidate, 'directory')) {
            directories.push(candidate)
          } else {
            summary.failed += 1
          }
          continue
        }
        if (!stat.isFile() || !fileMatches(target, entry.name, stat.mtimeMs, now)) continue
        if (!(await isPathSafeWithinBoundary(boundary, candidate, 'file'))) {
          summary.failed += 1
          continue
        }

        try {
          await fs.unlink(candidate)
        } catch (error) {
          summary.failed += 1
          if (summary.errors.length < 12) {
            const message = error instanceof Error ? error.message : String(error)
            summary.errors.push(`${candidate}: ${message}`)
          }
          continue
        }
        summary.bytes += stat.size
        summary.removed += 1
      } catch (error) {
        summary.failed += 1
        if (summary.errors.length < 12) {
          const message = error instanceof Error ? error.message : String(error)
          summary.errors.push(`${candidate}: ${message}`)
        }
      }

      if ((summary.removed + summary.failed) % 200 === 0) onTick?.(summary)
    }
  }
  onTick?.(summary)
  return summary
}
