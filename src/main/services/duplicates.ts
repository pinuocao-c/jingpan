import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  DuplicateFileGroup,
  DuplicateFileScanResult,
  TaskProgress,
  UserFileItem
} from '../../shared/types'
import { isPathInsideOrEqual, type TaskController } from './filesystem'
import {
  detectUserFileKind,
  getPersonalRoots,
  verifyUserFileSnapshot,
  type InternalUserFile,
  type PersonalRoot
} from './userFiles'

const MIN_DUPLICATE_BYTES = 1024 * 1024
const MAX_CANDIDATES = 30_000
const MAX_GROUPS = 500

export interface InternalDuplicateFile extends InternalUserFile {
  groupId: string
  contentHash: string
}

export interface DuplicateFileSnapshot {
  result: DuplicateFileScanResult
  internal: Map<string, InternalDuplicateFile>
}

export interface DuplicateFileScanOptions {
  roots?: PersonalRoot[]
}

function normalizePath(value: string): string {
  return path.resolve(value).toLocaleLowerCase('en-US')
}

function fileId(filePath: string): string {
  return createHash('sha256').update(normalizePath(filePath)).digest('hex').slice(0, 24)
}

async function hashFile(filePath: string, controller?: TaskController): Promise<string | null> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  try {
    for await (const chunk of stream) {
      if (controller?.cancelled) {
        stream.destroy()
        return null
      }
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
  } catch {
    stream.destroy()
    return null
  }
}

function publicFile(file: InternalDuplicateFile): UserFileItem {
  const {
    groupId: _groupId,
    contentHash: _contentHash,
    realPath: _realPath,
    approvedLexicalRoot: _approvedLexicalRoot,
    approvedRealRoot: _approvedRealRoot,
    device: _device,
    inode: _inode,
    modifiedMs: _modifiedMs,
    ...visible
  } = file
  return visible
}

async function collectCandidates(
  roots: PersonalRoot[],
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void
): Promise<{ candidates: InternalUserFile[]; totalCandidates: number; cloudFoldersSkipped: boolean }> {
  const candidates: InternalUserFile[] = []
  const seenRealPaths = new Set<string>()
  let visited = 0
  let totalCandidates = 0
  let cloudFoldersSkipped = false

  for (let rootIndex = 0; rootIndex < roots.length && !controller.cancelled; rootIndex += 1) {
    const root = roots[rootIndex]
    if (root.cloudBacked) {
      cloudFoldersSkipped = true
      continue
    }
    const directories = [root.lexicalRoot]
    while (directories.length > 0 && !controller.cancelled) {
      const directory = directories.pop()!
      try {
        const realDirectory = await fs.realpath(directory)
        if (!isPathInsideOrEqual(root.realRoot, realDirectory)) continue
      } catch {
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
        visited += 1
        try {
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            const stat = await fs.lstat(candidate)
            if (!stat.isDirectory() || stat.isSymbolicLink()) continue
            const realCandidate = await fs.realpath(candidate)
            if (isPathInsideOrEqual(root.realRoot, realCandidate)) directories.push(candidate)
            continue
          }
          if (!entry.isFile()) continue
          const kind = detectUserFileKind(entry.name)
          if (!kind) continue
          const stat = await fs.lstat(candidate)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < MIN_DUPLICATE_BYTES) continue
          const realCandidate = await fs.realpath(candidate)
          if (!isPathInsideOrEqual(root.realRoot, realCandidate)) continue
          const normalized = normalizePath(realCandidate)
          if (seenRealPaths.has(normalized)) continue
          seenRealPaths.add(normalized)
          totalCandidates += 1
          if (candidates.length >= MAX_CANDIDATES) continue
          candidates.push({
            id: fileId(realCandidate),
            kind,
            name: entry.name,
            path: candidate,
            extension: path.extname(entry.name).toLowerCase(),
            bytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            location: root.location,
            realPath: realCandidate,
            approvedLexicalRoot: root.lexicalRoot,
            approvedRealRoot: root.realRoot,
            cloudBacked: root.cloudBacked,
            linkCount: stat.nlink,
            device: stat.dev,
            inode: stat.ino,
            modifiedMs: stat.mtimeMs
          })
        } catch {
          // Files that change or become unavailable during scanning are omitted.
        }

        if (visited % 300 === 0) {
          onProgress({
            kind: 'analyze',
            percent: Math.min(58, Math.round(((rootIndex + 0.55) / Math.max(1, roots.length)) * 58)),
            title: '正在查找可能重复的文件',
            detail: `已检查 ${visited.toLocaleString('zh-CN')} 个项目`,
            filesVisited: visited
          })
        }
      }
    }
  }
  return { candidates, totalCandidates, cloudFoldersSkipped }
}

export async function scanDuplicateFiles(
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void,
  options: DuplicateFileScanOptions = {}
): Promise<DuplicateFileSnapshot> {
  const startedAt = Date.now()
  const roots = options.roots ?? await getPersonalRoots()
  const { candidates, totalCandidates, cloudFoldersSkipped } = await collectCandidates(roots, controller, onProgress)
  const bySize = new Map<number, InternalUserFile[]>()
  for (const file of candidates) {
    const list = bySize.get(file.bytes) ?? []
    list.push(file)
    bySize.set(file.bytes, list)
  }
  const hashCandidates = [...bySize.values()].filter((files) => files.length > 1).flat()
  const byHash = new Map<string, InternalUserFile[]>()
  let hashedFiles = 0

  for (const file of hashCandidates) {
    if (controller.cancelled) break
    const hash = await hashFile(file.realPath, controller)
    if (!hash) continue
    hashedFiles += 1
    const key = `${file.bytes}:${hash}`
    const list = byHash.get(key) ?? []
    list.push(file)
    byHash.set(key, list)
    if (hashedFiles % 5 === 0 || hashedFiles === hashCandidates.length) {
      onProgress({
        kind: 'analyze',
        percent: 60 + Math.min(38, Math.round((hashedFiles / Math.max(1, hashCandidates.length)) * 38)),
        title: '正在逐字节核对文件内容',
        detail: `已完成 ${hashedFiles.toLocaleString('zh-CN')} / ${hashCandidates.length.toLocaleString('zh-CN')} 个文件的 SHA-256 校验`,
        filesVisited: hashedFiles
      })
    }
  }

  const duplicateSets = [...byHash.entries()]
    .filter(([, files]) => files.length > 1)
    .sort((left, right) => right[1][0].bytes * (right[1].length - 1) - left[1][0].bytes * (left[1].length - 1))
  const keptSets = duplicateSets.slice(0, MAX_GROUPS)
  const internal = new Map<string, InternalDuplicateFile>()
  const groups: DuplicateFileGroup[] = keptSets.map(([key, files]) => {
    const separator = key.indexOf(':')
    const contentHash = key.slice(separator + 1)
    const groupId = createHash('sha256').update(key).digest('hex').slice(0, 20)
    const sorted = [...files].sort((left, right) => (
      new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime()
      || left.path.localeCompare(right.path, 'zh-CN')
    ))
    for (const file of sorted) internal.set(file.id, { ...file, groupId, contentHash })
    return {
      id: groupId,
      bytesPerFile: sorted[0].bytes,
      reclaimableBytes: sorted[0].bytes * (sorted.length - 1),
      files: sorted.map((file) => publicFile({ ...file, groupId, contentHash }))
    }
  })
  const reclaimableBytes = groups.reduce((sum, group) => sum + group.reclaimableBytes, 0)
  const duplicateFiles = groups.reduce((sum, group) => sum + group.files.length, 0)
  const truncated = totalCandidates > MAX_CANDIDATES || duplicateSets.length > MAX_GROUPS

  onProgress({
    kind: 'analyze',
    percent: 100,
    title: controller.cancelled ? '重复文件扫描已停止' : '重复文件核对完成',
    detail: controller.cancelled
      ? '已保留当前结果'
      : groups.length > 0
        ? `找到 ${groups.length.toLocaleString('zh-CN')} 组内容完全相同的文件`
        : '没有找到 1 MB 以上、内容完全相同的个人文件'
  })

  return {
    result: {
      groups,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cancelled: controller.cancelled,
      truncated,
      candidateFiles: totalCandidates,
      hashedFiles,
      duplicateFiles,
      reclaimableBytes,
      cloudFoldersSkipped
    },
    internal
  }
}

export async function verifyDuplicateFileSnapshot(file: InternalDuplicateFile): Promise<boolean> {
  if (!(await verifyUserFileSnapshot(file))) return false
  return await hashFile(file.realPath) === file.contentHash
}

export function getDuplicateGroupSurvivors(
  files: Iterable<InternalDuplicateFile>,
  selectedIds: ReadonlySet<string>
): InternalDuplicateFile[] {
  const membersByGroup = new Map<string, InternalDuplicateFile[]>()
  const affectedGroups = new Set<string>()
  for (const file of files) {
    const members = membersByGroup.get(file.groupId) ?? []
    members.push(file)
    membersByGroup.set(file.groupId, members)
    if (selectedIds.has(file.id)) affectedGroups.add(file.groupId)
  }
  const survivors: InternalDuplicateFile[] = []
  for (const groupId of affectedGroups) {
    const survivor = membersByGroup.get(groupId)?.find((file) => !selectedIds.has(file.id))
    if (!survivor) throw new Error('每组重复文件必须至少保留一份，请取消选择其中一个文件')
    survivors.push(survivor)
  }
  return survivors
}
