import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ChatAccountSummary,
  ChatFileArea,
  ChatFileItem,
  ChatFileKind,
  ChatFileScanResult,
  ChatPlatform,
  TaskProgress
} from '../../shared/types'
import { isPathInsideOrEqual, type TaskController } from './filesystem'
import { getSystemDrive } from './system'

const MAX_RESULTS = 30_000

const EXTENSION_KIND = new Map<string, ChatFileKind>([
  ['.jpg', 'image'], ['.jpeg', 'image'], ['.png', 'image'], ['.gif', 'image'],
  ['.bmp', 'image'], ['.webp', 'image'], ['.tif', 'image'], ['.tiff', 'image'],
  ['.heic', 'image'], ['.svg', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.avi', 'video'], ['.mkv', 'video'],
  ['.wmv', 'video'], ['.flv', 'video'], ['.webm', 'video'], ['.m4v', 'video'], ['.3gp', 'video'],
  ['.mp3', 'audio'], ['.wav', 'audio'], ['.m4a', 'audio'], ['.aac', 'audio'],
  ['.flac', 'audio'], ['.ogg', 'audio'], ['.wma', 'audio'], ['.amr', 'audio'], ['.silk', 'audio'],
  ['.txt', 'text'], ['.text', 'text'], ['.md', 'text'], ['.markdown', 'text'],
  ['.log', 'text'], ['.nfo', 'text'], ['.json', 'text'],
  ['.doc', 'word'], ['.docx', 'word'], ['.rtf', 'word'], ['.odt', 'word'],
  ['.ppt', 'powerpoint'], ['.pptx', 'powerpoint'], ['.pps', 'powerpoint'],
  ['.ppsx', 'powerpoint'], ['.odp', 'powerpoint'],
  ['.xls', 'spreadsheet'], ['.xlsx', 'spreadsheet'], ['.csv', 'spreadsheet'], ['.ods', 'spreadsheet'],
  ['.pdf', 'pdf'],
  ['.zip', 'archive'], ['.rar', 'archive'], ['.7z', 'archive'], ['.tar', 'archive'],
  ['.gz', 'archive'], ['.bz2', 'archive'], ['.xz', 'archive'],
  ['.exe', 'installer'], ['.msi', 'installer'], ['.msix', 'installer'], ['.msixbundle', 'installer'],
  ['.appx', 'installer'], ['.appxbundle', 'installer'], ['.appinstaller', 'installer'],
  ['.iso', 'installer'], ['.apk', 'installer']
])

const BLOCKED_DATABASE_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.wal', '.shm', '.journal', '.lock', '.lck'
])

interface ChatScanRoot {
  lexicalRoot: string
  realRoot: string
  platform: ChatPlatform
  accountId: string
  accountLabel: string
  area: ChatFileArea
}

export interface InternalChatFile extends ChatFileItem {
  realPath: string
  approvedLexicalRoot: string
  approvedRealRoot: string
  device: number
  inode: number
  modifiedMs: number
}

export interface ChatFileSnapshot {
  result: ChatFileScanResult
  internal: Map<string, InternalChatFile>
}

export interface ChatFileClassification {
  kind: ChatFileKind
  previewable: boolean
}

function normalizePath(value: string): string {
  return path.resolve(value).toLocaleLowerCase('en-US')
}

function chatFileId(filePath: string): string {
  return createHash('sha256').update(`chat:${normalizePath(filePath)}`).digest('hex').slice(0, 24)
}

function accountId(platform: ChatPlatform, accountRoot: string): string {
  return createHash('sha256').update(`${platform}:${normalizePath(accountRoot)}`).digest('hex').slice(0, 16)
}

function isOnSystemDrive(candidate: string): boolean {
  const systemRoot = `${getSystemDrive().replace(/\\+$/, '')}\\`
  return path.parse(path.resolve(candidate)).root.toLocaleLowerCase('en-US')
    === systemRoot.toLocaleLowerCase('en-US')
}

function maskAccountName(platform: ChatPlatform, name: string): string {
  const cleaned = name.trim()
  const suffix = cleaned.length > 6 ? `…${cleaned.slice(-6)}` : cleaned
  return platform === 'wechat' ? `微信 ${suffix}` : `QQ ${suffix}`
}

function publicFile(file: InternalChatFile): ChatFileItem {
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

export function classifyChatFile(
  name: string,
  area: ChatFileArea,
  platform: ChatPlatform
): ChatFileClassification | undefined {
  if (!name || name === 'Thumbs.db' || name === 'desktop.ini') return undefined
  const extension = path.extname(name).toLowerCase()
  if (BLOCKED_DATABASE_EXTENSIONS.has(extension) || /\.(?:db|sqlite)(?:-[a-z]+)$/i.test(name)) return undefined

  const knownKind = EXTENSION_KIND.get(extension)
  if (knownKind) {
    const areaAcceptsKind = (
      area === 'file'
      || area === 'attachment'
      || area === 'temporary'
      || (area === 'cache' && ['image', 'video', 'audio'].includes(knownKind))
      || (area === 'image' && knownKind === 'image')
      || (area === 'sticker' && knownKind === 'image')
      || (area === 'video' && (knownKind === 'video' || knownKind === 'image'))
      || (area === 'audio' && knownKind === 'audio')
    )
    if (!areaAcceptsKind) return undefined
    return {
      kind: knownKind,
      previewable: knownKind !== 'installer' && !['.amr', '.silk'].includes(extension)
    }
  }

  if (
    platform === 'wechat'
    && (extension === '.dat' || !extension)
    && ['image', 'sticker', 'cache', 'attachment'].includes(area)
  ) {
    return { kind: 'image', previewable: false }
  }

  if (area === 'file' || area === 'attachment') {
    return { kind: 'other', previewable: false }
  }
  return undefined
}

function heapSwap(heap: InternalChatFile[], left: number, right: number): void {
  const current = heap[left]
  heap[left] = heap[right]
  heap[right] = current
}

function heapPush(heap: InternalChatFile[], item: InternalChatFile): void {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent].bytes <= heap[index].bytes) break
    heapSwap(heap, parent, index)
    index = parent
  }
}

function heapReplaceMinimum(heap: InternalChatFile[], item: InternalChatFile): void {
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

function keepLargest(heap: InternalChatFile[], item: InternalChatFile): void {
  if (heap.length < MAX_RESULTS) {
    heapPush(heap, item)
  } else if (item.bytes > heap[0].bytes) {
    heapReplaceMinimum(heap, item)
  }
}

async function extractConfiguredWeChatRoots(base: string): Promise<string[]> {
  const configPath = path.join(base, 'All Users', 'config', 'config.data')
  if (!existsSync(configPath)) return []
  try {
    const buffer = await fs.readFile(configPath)
    if (buffer.length > 64 * 1024) return []
    const roots = new Set<string>()
    for (const encoding of ['utf8', 'utf16le', 'latin1'] as const) {
      const text = buffer.toString(encoding).replace(/\0/g, '')
      const matches = text.match(/[A-Za-z]:\\[^<>"|?*\r\n]{1,260}/g) ?? []
      for (const rawMatch of matches) {
        const marker = /(?:\\|^)(WeChat Files|xwechat_files)(?:\\|$)/i.exec(rawMatch)
        if (!marker || marker.index === undefined) continue
        const end = marker.index + marker[0].replace(/\\$/, '').length
        const root = rawMatch.slice(0, end).replace(/[^\p{L}\p{N}\s._:\\-]+$/u, '')
        if (/^[A-Za-z]:\\/.test(root)) roots.add(path.resolve(root))
      }
    }
    return [...roots]
  } catch {
    return []
  }
}

async function addAreaRoot(
  roots: ChatScanRoot[],
  seen: Set<string>,
  platform: ChatPlatform,
  accountRoot: string,
  accountName: string,
  relativePath: string,
  area: ChatFileArea
): Promise<void> {
  const lexicalRoot = path.resolve(accountRoot, relativePath)
  if (!existsSync(lexicalRoot)) return
  try {
    const realAccountRoot = await fs.realpath(accountRoot)
    const realRoot = await fs.realpath(lexicalRoot)
    const stat = await fs.stat(realRoot)
    if (
      !stat.isDirectory()
      || !isOnSystemDrive(realRoot)
      || !isPathInsideOrEqual(realAccountRoot, realRoot)
    ) return
    const key = normalizePath(realRoot)
    if (seen.has(key)) return
    seen.add(key)
    roots.push({
      lexicalRoot,
      realRoot,
      platform,
      accountId: accountId(platform, realAccountRoot),
      accountLabel: maskAccountName(platform, accountName),
      area
    })
  } catch {
    // Unavailable, redirected or linked chat directories are omitted.
  }
}

async function discoverWeChatRoots(documentRoots: string[]): Promise<ChatScanRoot[]> {
  const bases = new Set<string>()
  for (const documents of documentRoots) {
    bases.add(path.join(documents, 'WeChat Files'))
    bases.add(path.join(documents, 'xwechat_files'))
  }
  for (const base of [...bases]) {
    for (const configured of await extractConfiguredWeChatRoots(base)) bases.add(configured)
  }

  const roots: ChatScanRoot[] = []
  const seen = new Set<string>()
  for (const base of bases) {
    if (!existsSync(base) || !isOnSystemDrive(base)) continue
    let accounts
    let realBase: string
    try {
      realBase = await fs.realpath(base)
      accounts = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const account of accounts) {
      if (!account.isDirectory() || account.isSymbolicLink() || /^(All Users|Applet|WMPF)$/i.test(account.name)) continue
      const accountRoot = path.join(base, account.name)
      try {
        const realAccountRoot = await fs.realpath(accountRoot)
        if (!isPathInsideOrEqual(realBase, realAccountRoot)) continue
      } catch {
        continue
      }
      const classicAreas: Array<[string, ChatFileArea]> = [
        [path.join('FileStorage', 'File'), 'file'],
        [path.join('FileStorage', 'MsgAttach'), 'attachment'],
        [path.join('FileStorage', 'Image'), 'image'],
        [path.join('FileStorage', 'Video'), 'video'],
        [path.join('FileStorage', 'Cache'), 'cache'],
        [path.join('FileStorage', 'CustomEmotion'), 'sticker'],
        [path.join('FileStorage', 'Temp'), 'temporary'],
        [path.join('FileStorage', 'TempFromPhone'), 'temporary']
      ]
      const modernAreas: Array<[string, ChatFileArea]> = [
        [path.join('msg', 'attach'), 'attachment'],
        [path.join('msg', 'file'), 'file'],
        [path.join('msg', 'image'), 'image'],
        [path.join('msg', 'video'), 'video'],
        [path.join('msg', 'audio'), 'audio'],
        [path.join('msg', 'cache'), 'cache'],
        [path.join('msg', 'download'), 'file'],
        ['cache', 'cache'],
        ['temp', 'temporary']
      ]
      for (const [relativePath, area] of [...classicAreas, ...modernAreas]) {
        await addAreaRoot(roots, seen, 'wechat', accountRoot, account.name, relativePath, area)
      }
    }
  }
  return roots
}

async function discoverQqRoots(documentRoots: string[]): Promise<ChatScanRoot[]> {
  const roots: ChatScanRoot[] = []
  const seen = new Set<string>()
  for (const documents of documentRoots) {
    const base = path.join(documents, 'Tencent Files')
    if (!existsSync(base) || !isOnSystemDrive(base)) continue
    let accounts
    let realBase: string
    try {
      realBase = await fs.realpath(base)
      accounts = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const account of accounts) {
      if (!account.isDirectory() || account.isSymbolicLink() || /^All Users$/i.test(account.name)) continue
      const accountRoot = path.join(base, account.name)
      try {
        const realAccountRoot = await fs.realpath(accountRoot)
        if (!isPathInsideOrEqual(realBase, realAccountRoot)) continue
      } catch {
        continue
      }
      const areas: Array<[string, ChatFileArea]> = [
        ['FileRecv', 'file'],
        ['Image', 'image'],
        ['Video', 'video'],
        ['Audio', 'audio'],
        [path.join('nt_qq', 'nt_data', 'FileRecv'), 'file'],
        [path.join('nt_qq', 'nt_data', 'File'), 'file'],
        [path.join('nt_qq', 'nt_data', 'Pic'), 'image'],
        [path.join('nt_qq', 'nt_data', 'Video'), 'video'],
        [path.join('nt_qq', 'nt_data', 'Audio'), 'audio']
      ]
      for (const [relativePath, area] of areas) {
        await addAreaRoot(roots, seen, 'qq', accountRoot, account.name, relativePath, area)
      }
    }
  }
  return roots
}

function getDocumentRoots(): string[] {
  const roots = new Set<string>()
  const profile = process.env.USERPROFILE
  if (profile) roots.add(path.join(profile, 'Documents'))
  for (const oneDrive of [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial
  ]) {
    if (oneDrive) roots.add(path.join(oneDrive, 'Documents'))
  }
  return [...roots].filter((root) => existsSync(root))
}

async function getChatRoots(documentRootsOverride?: string[]): Promise<ChatScanRoot[]> {
  const documentRoots = documentRootsOverride ?? getDocumentRoots()
  const [wechat, qq] = await Promise.all([
    discoverWeChatRoots(documentRoots),
    discoverQqRoots(documentRoots)
  ])
  return [...wechat, ...qq]
}

export async function scanChatFiles(
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void,
  options: { documentRoots?: string[] } = {}
): Promise<ChatFileSnapshot> {
  const startedAt = Date.now()
  const roots = await getChatRoots(options.documentRoots)
  const largestFiles: InternalChatFile[] = []
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
          const classification = entry.isFile()
            ? classifyChatFile(entry.name, root.area, root.platform)
            : undefined
          if (entry.isFile() && !classification) continue
          const stat = await fs.lstat(candidate)
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory()) {
            const realCandidate = await fs.realpath(candidate)
            if (!isPathInsideOrEqual(root.realRoot, realCandidate)) continue
            directories.push(candidate)
          } else if (stat.isFile() && classification) {
            const realCandidate = await fs.realpath(candidate)
            if (!isPathInsideOrEqual(root.realRoot, realCandidate)) continue
            const normalized = normalizePath(realCandidate)
            if (seenRealPaths.has(normalized)) continue
            seenRealPaths.add(normalized)
            totalMatched += 1
            keepLargest(largestFiles, {
              id: chatFileId(realCandidate),
              platform: root.platform,
              accountId: root.accountId,
              accountLabel: root.accountLabel,
              area: root.area,
              kind: classification.kind,
              name: entry.name,
              path: candidate,
              extension: path.extname(entry.name).toLowerCase(),
              bytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              previewable: classification.previewable,
              realPath: realCandidate,
              approvedLexicalRoot: root.lexicalRoot,
              approvedRealRoot: root.realRoot,
              device: stat.dev,
              inode: stat.ino,
              modifiedMs: stat.mtimeMs
            })
          }
        } catch {
          // Files that change during scanning are safely omitted.
        }

        if (visited % 300 === 0) {
          onProgress({
            kind: 'analyze',
            percent: Math.min(96, Math.round(((rootIndex + 0.55) / Math.max(1, roots.length)) * 100)),
            title: '正在整理微信与 QQ 聊天文件',
            detail: `已找到 ${totalMatched.toLocaleString('zh-CN')} 个可管理文件`,
            filesVisited: visited
          })
        }
      }
    }
  }

  largestFiles.sort((left, right) => right.bytes - left.bytes)
  const internal = new Map(largestFiles.map((file) => [file.id, file]))
  const files = largestFiles.map(publicFile)
  const accountMap = new Map<string, ChatAccountSummary>()
  for (const file of files) {
    const current = accountMap.get(file.accountId) ?? {
      id: file.accountId,
      platform: file.platform,
      label: file.accountLabel,
      fileCount: 0,
      bytes: 0
    }
    current.fileCount += 1
    current.bytes += file.bytes
    accountMap.set(file.accountId, current)
  }
  const accounts = [...accountMap.values()].sort((left, right) => right.bytes - left.bytes)
  const truncated = totalMatched > MAX_RESULTS
  onProgress({
    kind: 'analyze',
    percent: 100,
    title: '聊天文件整理完成',
    detail: roots.length === 0
      ? '未在 C 盘识别到微信或 QQ 聊天文件目录'
      : truncated
        ? `共找到 ${totalMatched.toLocaleString('zh-CN')} 项，已显示最大的 ${MAX_RESULTS.toLocaleString('zh-CN')} 项`
        : `共找到 ${files.length.toLocaleString('zh-CN')} 个文件`
  })

  return {
    result: {
      files,
      accounts,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cancelled: controller.cancelled,
      truncated,
      totalMatched
    },
    internal
  }
}

export async function verifyChatFileSnapshot(file: InternalChatFile): Promise<boolean> {
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
