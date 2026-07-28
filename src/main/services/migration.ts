import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  MigratedFileResult,
  MigrationCandidate,
  MigrationConfidence,
  MigrationResult,
  MigrationScanResult,
  MigrationUndoResult,
  TaskProgress,
  UserFileLocation
} from '../../shared/types'
import { isPathInsideOrEqual, type TaskController } from './filesystem'
import {
  scanPersonalFiles,
  verifyUserFileSnapshot,
  type InternalUserFile
} from './userFiles'

const MIN_USEFUL_FILE_BYTES = 1024 * 1024
const MAX_MIGRATION_RESULTS = 10_000
const DESTINATION_RESERVE_BYTES = 512 * 1024 * 1024
const MAX_SAFE_PATH_LENGTH = 238

const LOCATION_FOLDER: Record<Exclude<UserFileLocation, 'onedrive'>, string> = {
  downloads: '下载',
  desktop: '桌面',
  documents: '文档',
  pictures: '图片',
  videos: '视频',
  music: '音乐'
}

const APP_MANAGED_SEGMENTS = new Set([
  'appdata',
  'wechat files',
  'xwechat_files',
  'weixin',
  'tencent files',
  'nt_qq',
  'nt_data',
  'wxwork',
  'wechatwork',
  'outlook files',
  'microsoft user data',
  'my games',
  'saved games'
])

const CLOUD_SEGMENTS = new Set([
  'onedrive',
  'dropbox',
  'google drive',
  'googledrive',
  'icloud drive',
  'iclouddrive',
  'box',
  '坚果云',
  'baidunetdisk'
])

const EXCLUDED_EXTENSIONS = new Set(['.log', '.nfo'])

export interface InternalMigrationCandidate extends MigrationCandidate {
  source: InternalUserFile
}

export interface InternalMigratedFile extends MigratedFileResult {
  sha256: string
  sourceSnapshot: InternalUserFile
}

export interface InternalMigrationBatch {
  id: string
  destinationRoot: string
  createdAt: number
  files: InternalMigratedFile[]
}

export interface MigrationSnapshot {
  result: Omit<MigrationScanResult, 'scanId'>
  internal: Map<string, InternalMigrationCandidate>
}

function normalize(candidate: string): string {
  return path.resolve(candidate).toLocaleLowerCase('en-US')
}

function isSamePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right)
}

function pathSegments(candidate: string): string[] {
  return path.resolve(candidate)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase('en-US'))
}

function containsManagedSegment(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return true
  const segments = relative
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase('en-US'))
  return segments.some((segment) => APP_MANAGED_SEGMENTS.has(segment))
}

function containsCloudSegment(candidate: string): boolean {
  const segments = pathSegments(candidate)
  return segments.some((segment) => CLOUD_SEGMENTS.has(segment))
}

export function classifyMigrationCandidate(
  file: InternalUserFile
): { confidence: MigrationConfidence; reason: string } | null {
  if (file.cloudBacked || file.location === 'onedrive' || containsCloudSegment(file.path)) return null
  if (file.linkCount !== 1) return null
  if (containsManagedSegment(file.approvedLexicalRoot, file.path) || EXCLUDED_EXTENSIONS.has(file.extension)) return null
  if (file.bytes < MIN_USEFUL_FILE_BYTES) return null

  if (file.location === 'downloads') {
    return {
      confidence: 'recommended',
      reason: '下载目录中的独立文件，迁移后可直接从 D 盘打开'
    }
  }
  if (file.location === 'pictures' || file.location === 'videos' || file.location === 'music') {
    return {
      confidence: 'recommended',
      reason: '个人媒体文件，不属于 Windows 或应用运行目录'
    }
  }
  if (file.location === 'documents') {
    return {
      confidence: 'review',
      reason: '文档本身可迁移，但最近打开记录或项目引用可能需要重新定位'
    }
  }
  if (file.location === 'desktop') {
    return {
      confidence: 'review',
      reason: '桌面文件可迁移，但迁移后会从桌面原位置消失'
    }
  }
  return null
}

function toPublicCandidate(
  source: InternalUserFile,
  destinationRoot: string,
  classification: { confidence: MigrationConfidence; reason: string }
): InternalMigrationCandidate | null {
  if (source.location === 'onedrive') return null
  const relative = path.relative(source.approvedLexicalRoot, source.path)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const locationFolder = LOCATION_FOLDER[source.location]
  const destinationPath = path.join(destinationRoot, locationFolder, relative)
  const {
    realPath: _realPath,
    approvedLexicalRoot: _approvedLexicalRoot,
    approvedRealRoot: _approvedRealRoot,
    cloudBacked: _cloudBacked,
    linkCount: _linkCount,
    device: _device,
    inode: _inode,
    modifiedMs: _modifiedMs,
    ...visible
  } = source
  return {
    ...visible,
    confidence: classification.confidence,
    reason: classification.reason,
    destinationPath,
    source
  }
}

async function ensureDriveAvailable(destinationRoot: string): Promise<void> {
  const driveRoot = path.parse(path.resolve(destinationRoot)).root
  if (!driveRoot || !/^[a-z]:\\$/i.test(driveRoot)) {
    throw new Error('迁移目标必须是本机磁盘')
  }
  const stat = await fs.lstat(driveRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('D 盘当前不可用或不是本机目录')
  }
}

export async function getDestinationFreeBytes(destinationRoot: string): Promise<number> {
  const stats = await fs.statfs(path.parse(path.resolve(destinationRoot)).root, { bigint: true })
  const available = stats.bavail * stats.bsize
  return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available)
}

export async function scanMigrationCandidates(
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void,
  destinationRoot = 'D:\\净盘迁移'
): Promise<MigrationSnapshot> {
  const startedAt = Date.now()
  await ensureDriveAvailable(destinationRoot)
  const destinationFreeBytes = await getDestinationFreeBytes(destinationRoot)
  const personal = await scanPersonalFiles(controller, onProgress, {
    progressTitle: '正在识别可迁移的个人文件',
    progressCompleteTitle: '迁移候选识别完成'
  })

  const candidates: InternalMigrationCandidate[] = []
  let excludedCount = 0
  const safeRoots = new Map<string, boolean>()
  for (const source of personal.internal.values()) {
    let safeRoot = safeRoots.get(source.approvedLexicalRoot)
    if (safeRoot === undefined) {
      try {
        const rootStat = await fs.lstat(source.approvedLexicalRoot)
        safeRoot = rootStat.isDirectory() && !rootStat.isSymbolicLink()
      } catch {
        safeRoot = false
      }
      safeRoots.set(source.approvedLexicalRoot, safeRoot)
    }
    if (!safeRoot) {
      excludedCount += 1
      continue
    }
    const classification = classifyMigrationCandidate(source)
    if (!classification) {
      excludedCount += 1
      continue
    }
    const candidate = toPublicCandidate(source, destinationRoot, classification)
    if (!candidate) {
      excludedCount += 1
      continue
    }
    candidates.push(candidate)
  }

  candidates.sort((left, right) => {
    if (left.confidence !== right.confidence) return left.confidence === 'recommended' ? -1 : 1
    return right.bytes - left.bytes
  })
  const kept = candidates.slice(0, MAX_MIGRATION_RESULTS)
  const internal = new Map(kept.map((candidate) => [candidate.id, candidate]))
  const files = kept.map(({ source: _source, ...candidate }) => candidate)
  const eligibleBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const recommendedBytes = files
    .filter((file) => file.confidence === 'recommended')
    .reduce((sum, file) => sum + file.bytes, 0)

  onProgress({
    kind: 'migrate',
    percent: 100,
    title: '迁移候选识别完成',
    detail: `找到 ${files.length.toLocaleString('zh-CN')} 个高置信个人文件`
  })

  return {
    result: {
      files,
      destinationRoot,
      destinationFreeBytes,
      eligibleBytes,
      recommendedBytes,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cancelled: controller.cancelled,
      truncated: personal.result.truncated || candidates.length > MAX_MIGRATION_RESULTS,
      excludedCount
    },
    internal
  }
}

async function ensureSafeDirectory(destinationRoot: string, targetDirectory: string): Promise<void> {
  await ensureDriveAvailable(destinationRoot)
  const resolvedRoot = path.resolve(destinationRoot)
  const resolvedTarget = path.resolve(targetDirectory)
  if (!isPathInsideOrEqual(resolvedRoot, resolvedTarget)) throw new Error('迁移目标超出 D 盘安全目录')

  const driveRoot = path.parse(resolvedRoot).root
  const relative = path.relative(driveRoot, resolvedTarget)
  let current = driveRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`迁移目标包含不安全的链接目录：${current}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await fs.mkdir(current)
      const created = await fs.lstat(current)
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`无法创建安全的迁移目录：${current}`)
      }
    }
  }

  const realRoot = await fs.realpath(resolvedRoot)
  const realTarget = await fs.realpath(resolvedTarget)
  if (!isPathInsideOrEqual(realRoot, realTarget)) throw new Error('迁移目标经过重解析后越出安全目录')
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function removeRollbackFile(candidate: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(candidate, { force: true })
      if (!(await pathExists(candidate))) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)))
  }
  throw lastError instanceof Error ? lastError : new Error(`无法删除回滚文件：${candidate}`)
}

function shortenedDestination(candidate: string): string {
  if (candidate.length <= MAX_SAFE_PATH_LENGTH) return candidate
  const directory = path.dirname(candidate)
  const extension = path.extname(candidate)
  const name = path.basename(candidate, extension)
  const suffix = createHash('sha256').update(candidate).digest('hex').slice(0, 8)
  const allowed = Math.max(16, MAX_SAFE_PATH_LENGTH - directory.length - extension.length - suffix.length - 4)
  return path.join(directory, `${name.slice(0, allowed)}-${suffix}${extension}`)
}

async function availableDestination(requested: string): Promise<string> {
  const initial = shortenedDestination(requested)
  if (!(await pathExists(initial))) return initial
  const directory = path.dirname(initial)
  const extension = path.extname(initial)
  const name = path.basename(initial, extension)
  for (let index = 1; index <= 9_999; index += 1) {
    const candidate = shortenedDestination(path.join(directory, `${name} (${index})${extension}`))
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error(`目标位置存在过多同名文件：${path.basename(requested)}`)
}

export async function hashFile(candidate: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(candidate)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

async function syncFile(candidate: string): Promise<void> {
  const handle = await fs.open(candidate, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function migrateOneFile(
  candidate: InternalMigrationCandidate,
  destinationRoot: string
): Promise<InternalMigratedFile> {
  if (!(await verifyUserFileSnapshot(candidate.source))) {
    throw new Error(`${candidate.name} 已发生变化，请重新扫描`)
  }

  const destinationDirectory = path.dirname(candidate.destinationPath)
  await ensureSafeDirectory(destinationRoot, destinationDirectory)
  const destinationPath = await availableDestination(candidate.destinationPath)
  const partialPath = path.join(destinationDirectory, `.jingpan-${randomUUID()}.partial`)
  const sourceHash = await hashFile(candidate.source.path)
  let finalized = false
  let sourceRemoved = false

  try {
    await fs.copyFile(candidate.source.path, partialPath, fsConstants.COPYFILE_EXCL)
    await syncFile(partialPath)
    const copiedStat = await fs.lstat(partialPath)
    if (!copiedStat.isFile() || copiedStat.isSymbolicLink() || copiedStat.size !== candidate.bytes) {
      throw new Error(`${candidate.name} 的 D 盘副本大小校验失败`)
    }
    const copiedHash = await hashFile(partialPath)
    if (copiedHash !== sourceHash) throw new Error(`${candidate.name} 的 SHA-256 校验失败`)
    if (!(await verifyUserFileSnapshot(candidate.source))) {
      throw new Error(`${candidate.name} 在复制过程中发生变化，已保留 C 盘原件`)
    }

    await fs.rename(partialPath, destinationPath)
    finalized = true
    const finalStat = await fs.lstat(destinationPath)
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.size !== candidate.bytes) {
      throw new Error(`${candidate.name} 的 D 盘最终文件校验失败`)
    }

    try {
      await fs.unlink(candidate.source.path)
      sourceRemoved = true
    } catch {
      try {
        await removeRollbackFile(destinationPath)
      } catch (rollbackError) {
        throw new Error(
          `${candidate.name} 的 C 盘原件无法移除，且 D 盘副本回滚失败：${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`
        )
      }
      throw new Error(`${candidate.name} 的 C 盘原件被占用或无权限，已回滚 D 盘副本`)
    }

    return {
      id: candidate.id,
      name: candidate.name,
      sourcePath: candidate.source.path,
      destinationPath,
      bytes: candidate.bytes,
      sourceRemoved: true,
      sha256: sourceHash,
      sourceSnapshot: candidate.source
    }
  } catch (error) {
    await removeRollbackFile(partialPath).catch(() => undefined)
    if (finalized && !sourceRemoved && await pathExists(candidate.source.path).catch(() => false)) {
      await removeRollbackFile(destinationPath).catch(() => undefined)
    }
    throw error
  }
}

export async function migrateSelectedFiles(
  selected: InternalMigrationCandidate[],
  destinationRoot: string,
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void,
  batchId = randomUUID()
): Promise<{ result: MigrationResult; batch: InternalMigrationBatch }> {
  if (selected.length === 0) throw new Error('请先选择需要迁移的文件')
  const selectedBytes = selected.reduce((sum, file) => sum + file.bytes, 0)
  const freeBytes = await getDestinationFreeBytes(destinationRoot)
  if (freeBytes < selectedBytes + DESTINATION_RESERVE_BYTES) {
    throw new Error('D 盘可用空间不足，迁移后至少需要保留 512 MB 空间')
  }

  const files: InternalMigratedFile[] = []
  const failedIds: string[] = []
  const errors: string[] = []
  for (let index = 0; index < selected.length && !controller.cancelled; index += 1) {
    const candidate = selected[index]
    onProgress({
      kind: 'migrate',
      percent: Math.round((index / selected.length) * 96),
      title: '正在校验并迁移到 D 盘',
      detail: `${candidate.name} (${index + 1}/${selected.length})`
    })
    try {
      files.push(await migrateOneFile(candidate, destinationRoot))
    } catch (error) {
      failedIds.push(candidate.id)
      if (errors.length < 12) errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const moved = files.length
  const copiedSourceKept = 0
  const reclaimedBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  onProgress({
    kind: 'migrate',
    percent: 100,
    title: '文件迁移完成',
    detail: `已释放 C 盘空间 ${moved.toLocaleString('zh-CN')} 项`
  })

  return {
    result: {
      batchId,
      files: files.map(({ sha256: _sha256, sourceSnapshot: _sourceSnapshot, ...file }) => file),
      moved,
      copiedSourceKept,
      failed: failedIds.length,
      reclaimedBytes,
      failedIds,
      errors,
      cancelled: controller.cancelled
    },
    batch: {
      id: batchId,
      destinationRoot,
      createdAt: Date.now(),
      files
    }
  }
}

async function verifyMigratedFile(batch: InternalMigrationBatch, file: InternalMigratedFile): Promise<boolean> {
  try {
    const stat = await fs.lstat(file.destinationPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) return false
    const realRoot = await fs.realpath(batch.destinationRoot)
    const realFile = await fs.realpath(file.destinationPath)
    if (!isPathInsideOrEqual(realRoot, realFile)) return false
    return await hashFile(file.destinationPath) === file.sha256
  } catch {
    return false
  }
}

async function restoreOneFile(
  batch: InternalMigrationBatch,
  file: InternalMigratedFile
): Promise<{ destinationCopyKept: boolean }> {
  if (!file.sourceRemoved) throw new Error(`${file.name} 的 C 盘原件仍在，无需撤销`)
  if (await pathExists(file.sourcePath)) throw new Error(`${file.name} 的原位置已有同名文件，未覆盖`)
  if (!(await verifyMigratedFile(batch, file))) throw new Error(`${file.name} 的 D 盘副本已变化，无法安全撤销`)

  const sourceRoot = await fs.realpath(file.sourceSnapshot.approvedLexicalRoot)
  if (!isSamePath(sourceRoot, file.sourceSnapshot.approvedRealRoot)) {
    throw new Error(`${file.name} 的原个人目录已改变，无法安全撤销`)
  }
  const sourceDirectory = path.dirname(file.sourcePath)
  const directoryStat = await fs.lstat(sourceDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${file.name} 的原目录不再安全`)
  }
  const realDirectory = await fs.realpath(sourceDirectory)
  if (!isPathInsideOrEqual(sourceRoot, realDirectory)) {
    throw new Error(`${file.name} 的原目录越出个人文件范围`)
  }

  const partialPath = path.join(sourceDirectory, `.jingpan-restore-${randomUUID()}.partial`)
  try {
    await fs.copyFile(file.destinationPath, partialPath, fsConstants.COPYFILE_EXCL)
    await syncFile(partialPath)
    const restoredHash = await hashFile(partialPath)
    if (restoredHash !== file.sha256) throw new Error(`${file.name} 的撤销副本校验失败`)
    await fs.rename(partialPath, file.sourcePath)
    let destinationCopyKept = false
    try {
      await fs.unlink(file.destinationPath)
    } catch {
      destinationCopyKept = true
    }
    return { destinationCopyKept }
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function undoMigrationBatch(
  batch: InternalMigrationBatch,
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void
): Promise<MigrationUndoResult> {
  let restored = 0
  let destinationCopiesKept = 0
  let restoredBytes = 0
  const errors: string[] = []
  const restorable = batch.files.filter((file) => file.sourceRemoved)

  for (let index = 0; index < restorable.length && !controller.cancelled; index += 1) {
    const file = restorable[index]
    onProgress({
      kind: 'migrate',
      percent: Math.round((index / Math.max(1, restorable.length)) * 96),
      title: '正在撤销最近一次迁移',
      detail: `${file.name} (${index + 1}/${restorable.length})`
    })
    try {
      const result = await restoreOneFile(batch, file)
      restored += 1
      restoredBytes += file.bytes
      if (result.destinationCopyKept) destinationCopiesKept += 1
    } catch (error) {
      if (errors.length < 12) errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  onProgress({
    kind: 'migrate',
    percent: 100,
    title: '迁移撤销完成',
    detail: `已恢复 ${restored.toLocaleString('zh-CN')} 个文件`
  })
  return {
    restored,
    destinationCopiesKept,
    failed: restorable.length - restored,
    restoredBytes,
    errors
  }
}
