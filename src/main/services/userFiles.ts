import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  TaskProgress,
  UserFileItem,
  UserFileKind,
  UserFileLocation,
  UserFileScanResult
} from '../../shared/types'
import { isPathInsideOrEqual, type TaskController } from './filesystem'
import { getSystemDrive } from './system'

const MAX_RESULTS = 20_000

const EXTENSION_KIND = new Map<string, UserFileKind>([
  ['.jpg', 'image'], ['.jpeg', 'image'], ['.png', 'image'], ['.gif', 'image'],
  ['.bmp', 'image'], ['.webp', 'image'], ['.tif', 'image'], ['.tiff', 'image'],
  ['.heic', 'image'], ['.svg', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.avi', 'video'], ['.mkv', 'video'],
  ['.wmv', 'video'], ['.flv', 'video'], ['.webm', 'video'], ['.m4v', 'video'], ['.3gp', 'video'],
  ['.txt', 'text'], ['.text', 'text'], ['.md', 'text'], ['.markdown', 'text'],
  ['.log', 'text'], ['.nfo', 'text'],
  ['.doc', 'word'], ['.docx', 'word'], ['.rtf', 'word'], ['.odt', 'word'],
  ['.ppt', 'powerpoint'], ['.pptx', 'powerpoint'], ['.pps', 'powerpoint'],
  ['.ppsx', 'powerpoint'], ['.odp', 'powerpoint'],
  ['.xls', 'spreadsheet'], ['.xlsx', 'spreadsheet'], ['.csv', 'spreadsheet'],
  ['.ods', 'spreadsheet'],
  ['.pdf', 'pdf'],
  ['.zip', 'archive'], ['.rar', 'archive'], ['.7z', 'archive'], ['.tar', 'archive'], ['.gz', 'archive'],
  ['.msi', 'installer'], ['.msix', 'installer'], ['.msixbundle', 'installer'],
  ['.appx', 'installer'], ['.appxbundle', 'installer'], ['.appinstaller', 'installer'], ['.iso', 'installer']
])

interface PersonalRoot {
  lexicalRoot: string
  realRoot: string
  location: UserFileLocation
}

export interface InternalUserFile extends UserFileItem {
  realPath: string
  approvedLexicalRoot: string
  approvedRealRoot: string
  device: number
  inode: number
  modifiedMs: number
}

export interface PersonalFileSnapshot {
  result: UserFileScanResult
  internal: Map<string, InternalUserFile>
}

function normalizePath(value: string): string {
  return path.resolve(value).toLocaleLowerCase('en-US')
}

function fileId(filePath: string): string {
  return createHash('sha256').update(normalizePath(filePath)).digest('hex').slice(0, 24)
}

function isOnSystemDrive(candidate: string): boolean {
  const systemRoot = `${getSystemDrive().replace(/\\+$/, '')}\\`
  return path.parse(path.resolve(candidate)).root.toLocaleLowerCase('en-US')
    === systemRoot.toLocaleLowerCase('en-US')
}

async function getPersonalRoots(): Promise<PersonalRoot[]> {
  const profile = process.env.USERPROFILE ?? ''
  const candidates: Array<{ root: string | undefined; location: UserFileLocation }> = [
    { root: path.join(profile, 'Desktop'), location: 'desktop' },
    { root: path.join(profile, 'Downloads'), location: 'downloads' },
    { root: path.join(profile, 'Documents'), location: 'documents' },
    { root: path.join(profile, 'Pictures'), location: 'pictures' },
    { root: path.join(profile, 'Videos'), location: 'videos' },
    { root: process.env.OneDrive, location: 'onedrive' },
    { root: process.env.OneDriveConsumer, location: 'onedrive' },
    { root: process.env.OneDriveCommercial, location: 'onedrive' }
  ]

  const uniqueRealRoots = new Set<string>()
  const roots: PersonalRoot[] = []
  for (const candidate of candidates) {
    if (!candidate.root || !existsSync(candidate.root)) continue
    try {
      const lexicalRoot = path.resolve(candidate.root)
      const realRoot = await fs.realpath(lexicalRoot)
      const stat = await fs.stat(realRoot)
      if (!stat.isDirectory() || !isOnSystemDrive(realRoot)) continue
      const normalized = normalizePath(realRoot)
      if (uniqueRealRoots.has(normalized)) continue
      uniqueRealRoots.add(normalized)
      roots.push({ lexicalRoot, realRoot, location: candidate.location })
    } catch {
      // Redirected or unavailable known folders are safely omitted.
    }
  }
  return roots
}

export function detectUserFileKind(name: string): UserFileKind | undefined {
  const extension = path.extname(name).toLowerCase()
  return EXTENSION_KIND.get(extension)
    ?? (extension === '.exe' && /(?:^|[._\-\s])(setup|installer?|安装包)(?:[._\-\s]|$)/i.test(name)
      ? 'installer'
      : undefined)
}

function heapSwap(heap: InternalUserFile[], left: number, right: number): void {
  const current = heap[left]
  heap[left] = heap[right]
  heap[right] = current
}

function heapPush(heap: InternalUserFile[], item: InternalUserFile): void {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent].bytes <= heap[index].bytes) break
    heapSwap(heap, parent, index)
    index = parent
  }
}

function heapReplaceMinimum(heap: InternalUserFile[], item: InternalUserFile): void {
  heap[0] = item
  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && heap[left].bytes < heap[smallest].bytes) smallest = left
    if (right < heap.length && heap[right].bytes < heap[smallest].bytes) smallest = right
    if (smallest === index) break
    heapSwap(heap, index, smallest)
    index = smallest
  }
}

function keepLargest(heap: InternalUserFile[], item: InternalUserFile): void {
  if (heap.length < MAX_RESULTS) {
    heapPush(heap, item)
  } else if (item.bytes > heap[0].bytes) {
    heapReplaceMinimum(heap, item)
  }
}

function publicFile(file: InternalUserFile): UserFileItem {
  const {
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

export async function scanPersonalFiles(
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void
): Promise<PersonalFileSnapshot> {
  const startedAt = Date.now()
  const roots = await getPersonalRoots()
  const largestFiles: InternalUserFile[] = []
  const seenRealPaths = new Set<string>()
  let visited = 0
  let totalMatched = 0

  for (let rootIndex = 0; rootIndex < roots.length && !controller.cancelled; rootIndex += 1) {
    const root = roots[rootIndex]
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
          const direntKind = entry.isFile() ? detectUserFileKind(entry.name) : undefined
          if (entry.isFile() && !direntKind) continue
          const stat = await fs.lstat(candidate)
          if (stat.isSymbolicLink()) continue

          if (stat.isDirectory()) {
            const realCandidate = await fs.realpath(candidate)
            if (!isPathInsideOrEqual(root.realRoot, realCandidate)) continue
            directories.push(candidate)
          } else if (stat.isFile()) {
            const kind = direntKind ?? detectUserFileKind(entry.name)
            if (!kind) continue
            const realCandidate = await fs.realpath(candidate)
            if (!isPathInsideOrEqual(root.realRoot, realCandidate)) continue
            const normalizedRealPath = normalizePath(realCandidate)
            if (seenRealPaths.has(normalizedRealPath)) continue
            seenRealPaths.add(normalizedRealPath)
            totalMatched += 1
            keepLargest(largestFiles, {
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
              device: stat.dev,
              inode: stat.ino,
              modifiedMs: stat.mtimeMs
            })
          }
        } catch {
          // Files changed or became unavailable during scanning; omit them safely.
        }

        if (visited % 300 === 0) {
          onProgress({
            kind: 'analyze',
            percent: Math.min(96, Math.round(((rootIndex + 0.55) / Math.max(1, roots.length)) * 100)),
            title: '正在整理 C 盘个人文件',
            detail: `已找到 ${totalMatched.toLocaleString('zh-CN')} 个文件`,
            filesVisited: visited
          })
        }
      }
    }
  }

  largestFiles.sort((a, b) => b.bytes - a.bytes)
  const internal = new Map(largestFiles.map((file) => [file.id, file]))
  const files = largestFiles.map(publicFile)
  const truncated = totalMatched > MAX_RESULTS
  onProgress({
    kind: 'analyze',
    percent: 100,
    title: 'C 盘个人文件整理完成',
    detail: truncated
      ? `共找到 ${totalMatched.toLocaleString('zh-CN')} 项，已显示最大的 ${MAX_RESULTS.toLocaleString('zh-CN')} 项`
      : `共找到 ${files.length.toLocaleString('zh-CN')} 个文件`
  })

  return {
    result: {
      files,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cancelled: controller.cancelled,
      truncated,
      totalMatched
    },
    internal
  }
}

export async function verifyUserFileSnapshot(file: InternalUserFile): Promise<boolean> {
  try {
    const currentRoot = await fs.realpath(file.approvedLexicalRoot)
    if (normalizePath(currentRoot) !== normalizePath(file.approvedRealRoot)) return false

    const stat = await fs.lstat(file.path)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const realPath = await fs.realpath(file.path)
    if (normalizePath(realPath) !== normalizePath(file.realPath)) return false
    if (!isPathInsideOrEqual(file.approvedRealRoot, realPath)) return false

    return stat.dev === file.device
      && stat.ino === file.inode
      && stat.size === file.bytes
      && Math.abs(stat.mtimeMs - file.modifiedMs) < 1
  } catch {
    return false
  }
}
