import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, protocol, session, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import type { CategoryId, FileThumbnailScope, TaskProgress, UserFileKind } from '../shared/types'
import { analyzeSystemDrive } from './services/analyzer'
import { launchUninstaller, scanInstalledApps, type InternalApp } from './services/apps'
import { CATEGORY_META } from './services/catalog'
import {
  resolveQqStorageBase,
  scanChatFiles,
  verifyChatFileSnapshot,
  type InternalChatFile
} from './services/chatFiles'
import { cleanCategories } from './services/cleaner'
import {
  getDuplicateGroupSurvivors,
  scanDuplicateFiles,
  verifyDuplicateFileSnapshot,
  type InternalDuplicateFile
} from './services/duplicates'
import type { TaskController } from './services/filesystem'
import {
  migrateSelectedFiles,
  scanMigrationCandidates,
  undoMigrationBatch,
  type InternalMigrationBatch,
  type InternalMigrationCandidate
} from './services/migration'
import { scanCleanupCategories } from './services/scanner'
import { getDiskSummary, getSystemDrive, isRunningAsAdministrator } from './services/system'
import {
  scanPersonalFiles,
  verifyUserFileSnapshot,
  type InternalUserFile
} from './services/userFiles'
import { fetchLatestUpdate, type TrustedUpdate } from './services/updates'

let mainWindow: BrowserWindow | null = null
let activeTask: {
  kind:
    | 'scan'
    | 'clean'
    | 'analyze'
    | 'user-files'
    | 'duplicate-files'
    | 'chat-files'
    | 'apps'
    | 'migration-scan'
    | 'migration'
    | 'migration-undo'
  controller: TaskController
} | null = null
let revealedPaths = new Set<string>()
let userFileMap = new Map<string, InternalUserFile>()
let duplicateFileMap = new Map<string, InternalDuplicateFile>()
let chatFileMap = new Map<string, InternalChatFile>()
let installedAppMap = new Map<string, InternalApp>()
let migrationFileMap = new Map<string, InternalMigrationCandidate>()
let migrationBatchMap = new Map<string, InternalMigrationBatch>()
let cachedUpdate: TrustedUpdate | null = null
let updateCheckPromise: Promise<TrustedUpdate> | null = null
let cleanupSession: {
  scanId: string
  expiresAt: number
  categories: Set<CategoryId>
} | null = null
let migrationSession: {
  scanId: string
  expiresAt: number
  destinationRoot: string
} | null = null

const CLEANUP_SESSION_TTL_MS = 30 * 60 * 1000
const MAX_RECYCLE_BATCH = 2_000
const UPDATE_CACHE_TTL_MS = 30 * 60 * 1000
const UPDATE_ERROR_CACHE_TTL_MS = 60 * 1000
const CHAT_STORAGE_SETTINGS_VERSION = 1
const MAX_THUMBNAIL_CACHE_ENTRIES = 240
const MAX_CONCURRENT_THUMBNAILS = 3
let storedQqRoots: string[] | null = null
const thumbnailCache = new Map<string, string | null>()
const thumbnailWaiters: Array<() => void> = []
let activeThumbnailTasks = 0

interface ThumbnailSource {
  path: string
  kind: UserFileKind | 'other'
  bytes: number
  modifiedMs: number
  verify: () => Promise<boolean>
}

const VIDEO_MIME_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.3gp', 'video/3gpp']
])

const IMAGE_MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.webp', 'image/webp']
])

async function withThumbnailSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeThumbnailTasks >= MAX_CONCURRENT_THUMBNAILS) {
    await new Promise<void>((resolve) => thumbnailWaiters.push(resolve))
  }
  activeThumbnailTasks += 1
  try {
    return await work()
  } finally {
    activeThumbnailTasks -= 1
    thumbnailWaiters.shift()?.()
  }
}

function rememberThumbnail(key: string, value: string | null): void {
  if (thumbnailCache.has(key)) thumbnailCache.delete(key)
  thumbnailCache.set(key, value)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    thumbnailCache.delete(oldestKey)
  }
}

function resolveThumbnailSource(scope: FileThumbnailScope, fileId: string): ThumbnailSource | null {
  if (scope === 'user') {
    const file = userFileMap.get(fileId)
    return file
      ? { path: file.path, kind: file.kind, bytes: file.bytes, modifiedMs: file.modifiedMs, verify: () => verifyUserFileSnapshot(file) }
      : null
  }
  if (scope === 'duplicate') {
    const file = duplicateFileMap.get(fileId)
    return file
      ? { path: file.path, kind: file.kind, bytes: file.bytes, modifiedMs: file.modifiedMs, verify: () => verifyDuplicateFileSnapshot(file) }
      : null
  }
  if (scope === 'chat') {
    const file = chatFileMap.get(fileId)
    return file
      ? {
          path: file.path,
          kind: file.previewable ? file.kind : 'other',
          bytes: file.bytes,
          modifiedMs: file.modifiedMs,
          verify: () => verifyChatFileSnapshot(file)
        }
      : null
  }
  const file = migrationFileMap.get(fileId)
  return file
    ? {
        path: file.path,
        kind: file.kind,
        bytes: file.bytes,
        modifiedMs: file.source.modifiedMs,
        verify: () => verifyUserFileSnapshot(file.source)
      }
    : null
}

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null
  const match = /^bytes=(\d+)-(\d*)$/i.exec(value.trim())
  if (!match) return null
  const start = Number.parseInt(match[1], 10)
  const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size) {
    return null
  }
  return { start, end: Math.min(size - 1, Math.max(start, requestedEnd)) }
}

function registerMediaProtocol(): void {
  protocol.handle('jingpan-media', async (request) => {
    try {
      const url = new URL(request.url)
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const scope = parts[0]
      const fileId = parts[1]
      if (
        !['thumbnail', 'preview'].includes(url.hostname)
        || parts.length !== 2
        || !['user', 'duplicate', 'chat', 'migration'].includes(scope)
        || !fileId
        || fileId.length > 256
      ) return new Response(null, { status: 404 })

      const source = resolveThumbnailSource(scope as FileThumbnailScope, fileId)
      const extension = source ? path.extname(source.path).toLowerCase() : ''
      const mimeType = source?.kind === 'video'
        ? VIDEO_MIME_TYPES.get(extension)
        : source?.kind === 'image'
          ? IMAGE_MIME_TYPES.get(extension)
          : undefined
      const allowedKind = url.hostname === 'thumbnail'
        ? source?.kind === 'video'
        : source?.kind === 'video' || source?.kind === 'image'
      if (!source || !allowedKind || !mimeType || !(await source.verify())) {
        return new Response(null, { status: 404 })
      }

      const stat = await fs.stat(source.path)
      if (!stat.isFile() || stat.size <= 0 || stat.size !== source.bytes) {
        return new Response(null, { status: 404 })
      }
      const rangeHeader = request.headers.get('range')
      const range = parseByteRange(rangeHeader, stat.size)
      if (rangeHeader && !range) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` }
        })
      }

      const start = range?.start ?? 0
      const end = range?.end ?? stat.size - 1
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Length': String(end - start + 1),
        'Content-Type': mimeType,
        'Cross-Origin-Resource-Policy': 'cross-origin'
      })
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      const body = request.method === 'HEAD'
        ? null
        : Readable.toWeb(createReadStream(source.path, { start, end })) as unknown as BodyInit
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

interface ChatStorageSettings {
  version: number
  qqRoots: string[]
}

function chatStorageSettingsPath(): string {
  return path.join(app.getPath('userData'), 'chat-storage.json')
}

function normalizeStoredRoot(candidate: string): string | null {
  if (!candidate || candidate.length > 1_024) return null
  const resolved = path.resolve(candidate)
  return /^[a-z]:\\/i.test(resolved) ? resolved : null
}

async function getStoredQqRoots(): Promise<string[]> {
  if (storedQqRoots) return storedQqRoots
  try {
    const parsed = JSON.parse(await fs.readFile(chatStorageSettingsPath(), 'utf8')) as Partial<ChatStorageSettings>
    storedQqRoots = Array.isArray(parsed.qqRoots)
      ? [...new Map(parsed.qqRoots
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map(normalizeStoredRoot)
        .filter((candidate): candidate is string => Boolean(candidate))
        .map((candidate) => [candidate.toLocaleLowerCase('en-US'), candidate])).values()]
      : []
  } catch {
    storedQqRoots = []
  }
  return storedQqRoots
}

async function rememberQqRoot(candidate: string): Promise<boolean> {
  const normalized = normalizeStoredRoot(candidate)
  if (!normalized) return false
  const roots = await getStoredQqRoots()
  if (roots.some((root) => root.toLocaleLowerCase('en-US') === normalized.toLocaleLowerCase('en-US'))) {
    return false
  }
  storedQqRoots = [...roots, normalized]
  const settings: ChatStorageSettings = {
    version: CHAT_STORAGE_SETTINGS_VERSION,
    qqRoots: storedQqRoots
  }
  await fs.mkdir(path.dirname(chatStorageSettingsPath()), { recursive: true })
  await fs.writeFile(chatStorageSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return true
}

async function checkForUpdates(force = false): Promise<TrustedUpdate> {
  const cachedAt = cachedUpdate ? new Date(cachedUpdate.checkedAt).getTime() : 0
  const cacheTtl = cachedUpdate?.status === 'error' ? UPDATE_ERROR_CACHE_TTL_MS : UPDATE_CACHE_TTL_MS
  if (!force && cachedUpdate && Date.now() - cachedAt < cacheTtl) return cachedUpdate
  if (updateCheckPromise) return updateCheckPromise
  updateCheckPromise = fetchLatestUpdate(app.getVersion())
    .then((result) => {
      cachedUpdate = result
      return result
    })
    .finally(() => {
      updateCheckPromise = null
    })
  return updateCheckPromise
}

function getTrustedDevUrl(): string | null {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

interface AppStorageMode {
  dataPath: string
  portableMode: boolean
}

function configureAppStorage(): AppStorageMode {
  const executableDirectory = path.dirname(process.execPath)
  const portableMarker = path.join(executableDirectory, '.jingpan-portable')
  const dataPath = !app.isPackaged
    ? path.resolve(process.cwd(), '.cache', 'app-data')
    : existsSync(portableMarker)
      ? path.join(executableDirectory, 'data')
      : null

  if (!dataPath) {
    return { dataPath: app.getPath('userData'), portableMode: false }
  }

  const cachePath = path.join(dataPath, 'Cache')
  const logsPath = path.join(dataPath, 'logs')
  mkdirSync(cachePath, { recursive: true })
  mkdirSync(logsPath, { recursive: true })
  app.setPath('userData', dataPath)
  app.setPath('sessionData', dataPath)
  app.setAppLogsPath(logsPath)
  app.commandLine.appendSwitch('disk-cache-dir', cachePath)
  return { dataPath, portableMode: true }
}

const appStorage = configureAppStorage()

function createWindow(): void {
  const nativeWindowTheme = (): { background: string; overlay: string; symbols: string } => nativeTheme.shouldUseDarkColors
    ? { background: '#0d1522', overlay: '#111b2a', symbols: '#d9e4f2' }
    : { background: '#edf3f9', overlay: '#f4f8fc', symbols: '#5f6d80' }
  const initialTheme = nativeWindowTheme()

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: initialTheme.background,
    title: '净盘',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: initialTheme.overlay,
      symbolColor: initialTheme.symbols,
      height: 48
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true
    }
  })

  const syncNativeWindowTheme = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const theme = nativeWindowTheme()
    mainWindow.setBackgroundColor(theme.background)
    mainWindow.setTitleBarOverlay({ color: theme.overlay, symbolColor: theme.symbols, height: 48 })
  }
  nativeTheme.on('updated', syncNativeWindowTheme)
  mainWindow.once('closed', () => nativeTheme.off('updated', syncNativeWindowTheme))

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = getTrustedDevUrl()
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC call from an untrusted renderer')
  }

  const frameUrl = event.senderFrame.url
  const devUrl = getTrustedDevUrl()
  if (devUrl && new URL(frameUrl).origin === new URL(devUrl).origin) return

  try {
    const expectedPath = path.resolve(__dirname, '../renderer/index.html')
    if (
      new URL(frameUrl).protocol === 'file:'
      && path.resolve(fileURLToPath(frameUrl)).toLocaleLowerCase('en-US')
        === expectedPath.toLocaleLowerCase('en-US')
    ) return
  } catch {
    // Invalid or non-file renderer URLs are rejected below.
  }
  throw new Error('Rejected IPC call from an unexpected renderer URL')
}

function sendProgress(progress: TaskProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:progress', progress)
}

function beginTask(
  kind:
    | 'scan'
    | 'clean'
    | 'analyze'
    | 'user-files'
    | 'duplicate-files'
    | 'chat-files'
    | 'apps'
    | 'migration-scan'
    | 'migration'
    | 'migration-undo'
): TaskController {
  if (activeTask) throw new Error(`已有${activeTask.kind}任务正在运行`)
  const controller = { cancelled: false }
  activeTask = { kind, controller }
  return controller
}

function finishTask(controller: TaskController): void {
  if (activeTask?.controller === controller) activeTask = null
}

function registerIpc(): void {
  ipcMain.handle('app:snapshot', async (event) => {
    assertTrustedSender(event)
    const [disk, isAdministrator] = await Promise.all([getDiskSummary(), isRunningAsAdministrator()])
    return {
      version: app.getVersion(),
      disk,
      categories: CATEGORY_META,
      isAdministrator,
      dataPath: appStorage.dataPath,
      portableMode: appStorage.portableMode
    }
  })

  ipcMain.handle('scan:start', async (event) => {
    assertTrustedSender(event)
    const controller = beginTask('scan')
    try {
      const result = await scanCleanupCategories(controller, sendProgress)
      const scanId = result.cancelled ? '' : randomUUID()
      cleanupSession = result.cancelled
        ? null
        : {
            scanId,
            expiresAt: Date.now() + CLEANUP_SESSION_TTL_MS,
            categories: new Set(result.categories.filter((category) => category.bytes > 0).map((category) => category.id))
          }
      return { ...result, scanId }
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('scan:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'scan') activeTask.controller.cancelled = true
  })

  ipcMain.handle('clean:start', async (event, scanId: unknown, categoryIds: unknown) => {
    assertTrustedSender(event)
    if (typeof scanId !== 'string' || scanId.length > 100) throw new Error('无效或过期的扫描凭证')
    if (!Array.isArray(categoryIds) || !categoryIds.every((id) => typeof id === 'string')) {
      throw new Error('无效的清理请求')
    }
    if (
      !cleanupSession
      || cleanupSession.scanId !== scanId
      || cleanupSession.expiresAt < Date.now()
    ) {
      cleanupSession = null
      throw new Error('扫描结果已过期，请重新扫描后再清理')
    }
    const allowed = new Set(CATEGORY_META.map((item) => item.id))
    const safeIds = [...new Set(categoryIds)]
      .filter((id): id is CategoryId => allowed.has(id as CategoryId) && cleanupSession!.categories.has(id as CategoryId))
    if (safeIds.length === 0 || safeIds.length !== new Set(categoryIds).size) {
      throw new Error('清理项目与最近一次扫描结果不一致，请重新扫描')
    }
    cleanupSession = null
    const controller = beginTask('clean')
    try {
      return await cleanCategories(safeIds, controller, sendProgress)
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('clean:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'clean') activeTask.controller.cancelled = true
  })

  ipcMain.handle('analysis:start', async (event) => {
    assertTrustedSender(event)
    revealedPaths.clear()
    const controller = beginTask('analyze')
    try {
      const result = await analyzeSystemDrive(controller, sendProgress)
      revealedPaths = new Set(result.largeFiles.map((file) => path.resolve(file.path).toLowerCase()))
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('analysis:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'analyze') activeTask.controller.cancelled = true
  })

  ipcMain.handle('file:reveal', (event, requestedPath: unknown) => {
    assertTrustedSender(event)
    if (typeof requestedPath !== 'string') return false
    const normalized = path.resolve(requestedPath).toLowerCase()
    if (!revealedPaths.has(normalized)) return false
    shell.showItemInFolder(requestedPath)
    return true
  })

  ipcMain.handle('file:thumbnail', async (event, scope: unknown, fileId: unknown) => {
    assertTrustedSender(event)
    if (
      !['user', 'duplicate', 'chat', 'migration'].includes(String(scope))
      || typeof fileId !== 'string'
      || fileId.length === 0
      || fileId.length > 256
    ) return null

    const source = resolveThumbnailSource(scope as FileThumbnailScope, fileId)
    if (!source || (source.kind !== 'image' && source.kind !== 'video')) return null
    const cacheKey = `${scope}:${fileId}:${source.modifiedMs}`
    if (thumbnailCache.has(cacheKey)) return thumbnailCache.get(cacheKey) ?? null

    return withThumbnailSlot(async () => {
      if (thumbnailCache.has(cacheKey)) return thumbnailCache.get(cacheKey) ?? null
      try {
        if (!(await source.verify())) {
          rememberThumbnail(cacheKey, null)
          return null
        }
        let thumbnail = await nativeImage.createThumbnailFromPath(source.path, { width: 112, height: 112 })
        if (thumbnail.isEmpty() && source.kind === 'image') {
          thumbnail = nativeImage.createFromPath(source.path)
        }
        if (thumbnail.isEmpty()) {
          rememberThumbnail(cacheKey, null)
          return null
        }
        const dataUrl = thumbnail.resize({ width: 112, height: 112, quality: 'good' }).toDataURL()
        const safeDataUrl = dataUrl.length <= 600_000 ? dataUrl : null
        rememberThumbnail(cacheKey, safeDataUrl)
        return safeDataUrl
      } catch {
        rememberThumbnail(cacheKey, null)
        return null
      }
    })
  })

  ipcMain.handle('settings:storage', async (event) => {
    assertTrustedSender(event)
    await shell.openExternal('ms-settings:storagesense')
  })

  ipcMain.handle('settings:storage-recommendations', async (event) => {
    assertTrustedSender(event)
    await shell.openExternal('ms-settings:storagerecommendations')
  })

  ipcMain.handle('settings:storage-sense', async (event) => {
    assertTrustedSender(event)
    await shell.openExternal('ms-settings:storagepolicies')
  })

  ipcMain.handle('settings:save-locations', async (event) => {
    assertTrustedSender(event)
    await shell.openExternal('ms-settings:savelocations')
  })

  ipcMain.handle('settings:disk-cleanup', async (event) => {
    assertTrustedSender(event)
    const driveLetter = getSystemDrive().replace(':', '')
    await new Promise<void>((resolve) => {
      const child = spawn('cleanmgr.exe', ['/d', driveLetter], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
      child.once('error', () => {
        void shell.openExternal('ms-settings:storagesense').finally(resolve)
      })
    })
  })

  ipcMain.handle('settings:app-data', async (event) => {
    assertTrustedSender(event)
    const error = await shell.openPath(appStorage.dataPath)
    return !error
  })

  ipcMain.handle('settings:recycle-bin', async (event) => {
    assertTrustedSender(event)
    try {
      await shell.openExternal('shell:RecycleBinFolder')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('user-files:scan', async (event) => {
    assertTrustedSender(event)
    userFileMap.clear()
    const controller = beginTask('user-files')
    try {
      const { result, internal } = await scanPersonalFiles(controller, sendProgress)
      userFileMap = internal
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('user-files:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'user-files') activeTask.controller.cancelled = true
  })

  ipcMain.handle('user-files:recycle', async (event, fileIds: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(fileIds) || !fileIds.every((id) => typeof id === 'string')) {
      throw new Error('无效的文件选择')
    }
    const uniqueIds = [...new Set(fileIds)]
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_RECYCLE_BATCH) {
      throw new Error(`每次最多处理 ${MAX_RECYCLE_BATCH.toLocaleString('zh-CN')} 个文件`)
    }
    let movedToRecycleBin = 0
    let failed = 0
    const movedIds: string[] = []
    const failedIds: string[] = []
    const errors: string[] = []
    for (const id of uniqueIds) {
      const file = userFileMap.get(id)
      if (!file) {
        failed += 1
        failedIds.push(id)
        continue
      }
      try {
        if (!(await verifyUserFileSnapshot(file))) {
          failed += 1
          failedIds.push(id)
          if (errors.length < 10) errors.push(`${file.name} 已发生变化，请重新扫描后再操作`)
          continue
        }
        await shell.trashItem(file.path)
        userFileMap.delete(id)
        movedToRecycleBin += 1
        movedIds.push(id)
      } catch (error) {
        failed += 1
        failedIds.push(id)
        if (errors.length < 10) errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { movedToRecycleBin, failed, movedIds, failedIds, errors }
  })

  ipcMain.handle('user-files:open', async (event, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof fileId !== 'string') return { opened: false, message: '无效的文件选择' }
    const file = userFileMap.get(fileId)
    if (!file) return { opened: false, message: '文件列表已过期，请重新扫描' }
    if (file.kind === 'installer') {
      return {
        opened: false,
        message: '为避免误运行安装程序，安装包不支持直接打开；可使用右侧按钮查看所在位置'
      }
    }
    if (!(await verifyUserFileSnapshot(file))) {
      return { opened: false, message: '文件已发生变化，请重新扫描后再打开' }
    }
    const error = await shell.openPath(file.path)
    return error
      ? { opened: false, message: `无法打开文件：${error}` }
      : { opened: true, message: '' }
  })

  ipcMain.handle('user-files:reveal', (event, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof fileId !== 'string') return false
    const file = userFileMap.get(fileId)
    if (!file) return false
    shell.showItemInFolder(file.path)
    return true
  })

  ipcMain.handle('duplicate-files:scan', async (event) => {
    assertTrustedSender(event)
    duplicateFileMap.clear()
    const controller = beginTask('duplicate-files')
    try {
      const { result, internal } = await scanDuplicateFiles(controller, sendProgress)
      duplicateFileMap = internal
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('duplicate-files:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'duplicate-files') activeTask.controller.cancelled = true
  })

  ipcMain.handle('duplicate-files:recycle', async (event, fileIds: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(fileIds) || !fileIds.every((id) => typeof id === 'string')) {
      throw new Error('无效的重复文件选择')
    }
    const uniqueIds = [...new Set(fileIds)]
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_RECYCLE_BATCH) {
      throw new Error(`每次最多处理 ${MAX_RECYCLE_BATCH.toLocaleString('zh-CN')} 个文件`)
    }
    const selected = new Set(uniqueIds)
    for (const id of uniqueIds) {
      const file = duplicateFileMap.get(id)
      if (!file) throw new Error('重复文件列表已过期，请重新扫描')
    }

    for (const survivor of getDuplicateGroupSurvivors(duplicateFileMap.values(), selected)) {
      if (!(await verifyDuplicateFileSnapshot(survivor))) {
        throw new Error('准备保留的文件已发生变化，请重新扫描后再操作')
      }
    }

    let movedToRecycleBin = 0
    let failed = 0
    const movedIds: string[] = []
    const failedIds: string[] = []
    const errors: string[] = []
    for (const id of uniqueIds) {
      const file = duplicateFileMap.get(id)!
      try {
        if (!(await verifyDuplicateFileSnapshot(file))) {
          failed += 1
          failedIds.push(id)
          if (errors.length < 10) errors.push(`${file.name} 已发生变化，请重新扫描后再操作`)
          continue
        }
        await shell.trashItem(file.path)
        duplicateFileMap.delete(id)
        movedToRecycleBin += 1
        movedIds.push(id)
      } catch (error) {
        failed += 1
        failedIds.push(id)
        if (errors.length < 10) errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { movedToRecycleBin, failed, movedIds, failedIds, errors }
  })

  ipcMain.handle('duplicate-files:open', async (event, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof fileId !== 'string') return { opened: false, message: '无效的文件选择' }
    const file = duplicateFileMap.get(fileId)
    if (!file) return { opened: false, message: '重复文件列表已过期，请重新扫描' }
    if (file.kind === 'installer') {
      return { opened: false, message: '为避免误运行安装程序，安装包不支持直接打开；可查看所在位置' }
    }
    if (!(await verifyDuplicateFileSnapshot(file))) {
      return { opened: false, message: '文件已发生变化，请重新扫描后再打开' }
    }
    const error = await shell.openPath(file.path)
    return error
      ? { opened: false, message: `无法打开文件：${error}` }
      : { opened: true, message: '' }
  })

  ipcMain.handle('duplicate-files:reveal', (event, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof fileId !== 'string') return false
    const file = duplicateFileMap.get(fileId)
    if (!file) return false
    shell.showItemInFolder(file.path)
    return true
  })

  ipcMain.handle('chat-files:scan', async (event) => {
    assertTrustedSender(event)
    chatFileMap.clear()
    const controller = beginTask('chat-files')
    try {
      const { result, internal } = await scanChatFiles(controller, sendProgress, {
        customQqRoots: await getStoredQqRoots()
      })
      chatFileMap = internal
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('chat-files:choose-qq-folder', async (event) => {
    assertTrustedSender(event)
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { selected: false, recognized: false, added: false, path: null, message: '主窗口暂不可用' }
    }
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择 QQ 文件数据目录',
      buttonLabel: '使用此目录',
      message: '请选择 Tencent Files 文件夹；也可以选择它的上级文件夹或其中的账号文件夹。',
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { selected: false, recognized: false, added: false, path: null, message: '' }
    }
    const selectedPath = selection.filePaths[0]
    const resolvedBase = await resolveQqStorageBase(selectedPath)
    if (!resolvedBase) {
      return {
        selected: true,
        recognized: false,
        added: false,
        path: selectedPath,
        message: '该目录中没有识别到 QQ 的 FileRecv、Image 或 NTQQ 的 nt_data 文件夹，请选择 Tencent Files 数据目录'
      }
    }
    const added = await rememberQqRoot(resolvedBase)
    return {
      selected: true,
      recognized: true,
      added,
      path: resolvedBase,
      message: added ? '已添加 QQ 文件目录，将立即重新扫描' : 'QQ 文件目录已存在，将立即重新扫描'
    }
  })

  ipcMain.handle('chat-files:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'chat-files') activeTask.controller.cancelled = true
  })

  ipcMain.handle('chat-files:recycle', async (event, fileIds: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(fileIds) || !fileIds.every((id) => typeof id === 'string')) {
      throw new Error('无效的聊天文件选择')
    }
    const uniqueIds = [...new Set(fileIds)]
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_RECYCLE_BATCH) {
      throw new Error(`每次最多处理 ${MAX_RECYCLE_BATCH.toLocaleString('zh-CN')} 个文件`)
    }
    let movedToRecycleBin = 0
    let failed = 0
    const movedIds: string[] = []
    const failedIds: string[] = []
    const errors: string[] = []
    for (const id of uniqueIds) {
      const file = chatFileMap.get(id)
      if (!file) {
        failed += 1
        failedIds.push(id)
        continue
      }
      try {
        if (!(await verifyChatFileSnapshot(file))) {
          failed += 1
          failedIds.push(id)
          if (errors.length < 10) errors.push(`${file.name} 已发生变化，请重新扫描后再操作`)
          continue
        }
        await shell.trashItem(file.path)
        chatFileMap.delete(id)
        movedToRecycleBin += 1
        movedIds.push(id)
      } catch (error) {
        failed += 1
        failedIds.push(id)
        if (errors.length < 10) errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { movedToRecycleBin, failed, movedIds, failedIds, errors }
  })

  ipcMain.handle('chat-files:open', async (event, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof fileId !== 'string') return { opened: false, message: '无效的聊天文件选择' }
    const file = chatFileMap.get(fileId)
    if (!file) return { opened: false, message: '聊天文件列表已过期，请重新扫描' }
    if (!file.previewable) {
      const message = file.extension === '.dat'
        ? '这是微信加密保存的图片缓存，无法直接预览；可用右侧按钮查看所在位置'
        : file.kind === 'installer'
          ? '为避免误运行安装程序，此文件不支持直接打开；可用右侧按钮查看所在位置'
          : '此类聊天附件不支持安全预览；可用右侧按钮查看所在位置'
      return { opened: false, message }
    }
    if (!(await verifyChatFileSnapshot(file))) {
      return { opened: false, message: '聊天文件已发生变化，请重新扫描后再打开' }
    }
    const error = await shell.openPath(file.path)
    return error
      ? { opened: false, message: `无法打开聊天文件：${error}` }
      : { opened: true, message: '' }
  })

  ipcMain.handle('chat-files:reveal', (event, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof fileId !== 'string') return false
    const file = chatFileMap.get(fileId)
    if (!file) return false
    shell.showItemInFolder(file.path)
    return true
  })

  ipcMain.handle('apps:scan', async (event) => {
    assertTrustedSender(event)
    installedAppMap.clear()
    const controller = beginTask('apps')
    sendProgress({ kind: 'analyze', percent: 20, title: '正在读取已安装应用', detail: '只读取 Windows 卸载登记信息' })
    try {
      const { result, internal } = await scanInstalledApps()
      installedAppMap = internal
      sendProgress({ kind: 'analyze', percent: 100, title: '应用列表读取完成', detail: `找到 ${result.apps.length} 个可管理应用` })
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('apps:uninstall', async (event, appId: unknown) => {
    assertTrustedSender(event)
    if (typeof appId !== 'string') throw new Error('无效的应用选择')
    const installedApp = installedAppMap.get(appId)
    if (!installedApp) throw new Error('请重新扫描已安装应用')
    try {
      const result = await launchUninstaller(installedApp)
      if (result.launched) return result
      await shell.openExternal('ms-settings:appsfeatures')
      return { ...result, openedSettings: true, message: `${result.message}，已为你打开 Windows 应用设置` }
    } catch (error) {
      await shell.openExternal('ms-settings:appsfeatures')
      return {
        launched: false,
        openedSettings: true,
        message: `无法直接启动卸载程序，已打开 Windows 应用设置：${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

  ipcMain.handle('migration:scan', async (event) => {
    assertTrustedSender(event)
    migrationFileMap.clear()
    migrationSession = null
    const controller = beginTask('migration-scan')
    sendProgress({
      kind: 'migrate',
      percent: 0,
      title: '准备识别可迁移文件',
      detail: '只检查 C 盘个人目录，不读取文件内容'
    })
    try {
      const { result, internal } = await scanMigrationCandidates(controller, sendProgress)
      const scanId = result.cancelled ? '' : randomUUID()
      if (!result.cancelled) {
        migrationFileMap = internal
        migrationSession = {
          scanId,
          expiresAt: Date.now() + CLEANUP_SESSION_TTL_MS,
          destinationRoot: result.destinationRoot
        }
      }
      return { ...result, scanId }
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('migration:cancel-scan', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'migration-scan') activeTask.controller.cancelled = true
  })

  ipcMain.handle('migration:start', async (event, scanId: unknown, fileIds: unknown) => {
    assertTrustedSender(event)
    if (typeof scanId !== 'string' || scanId.length > 100) throw new Error('无效或过期的迁移扫描凭证')
    if (!Array.isArray(fileIds) || !fileIds.every((id) => typeof id === 'string')) {
      throw new Error('无效的迁移文件选择')
    }
    const uniqueIds = [...new Set(fileIds)]
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_RECYCLE_BATCH) {
      throw new Error(`每次最多迁移 ${MAX_RECYCLE_BATCH.toLocaleString('zh-CN')} 个文件`)
    }
    if (
      !migrationSession
      || migrationSession.scanId !== scanId
      || migrationSession.expiresAt < Date.now()
    ) {
      migrationSession = null
      migrationFileMap.clear()
      throw new Error('迁移扫描结果已过期，请重新扫描')
    }
    const selected = uniqueIds.map((id) => migrationFileMap.get(id))
    if (selected.some((file) => !file)) {
      throw new Error('迁移文件与最近一次扫描结果不一致，请重新扫描')
    }

    const destinationRoot = migrationSession.destinationRoot
    migrationSession = null
    const controller = beginTask('migration')
    try {
      const { result, batch } = await migrateSelectedFiles(
        selected as InternalMigrationCandidate[],
        destinationRoot,
        controller,
        sendProgress
      )
      if (batch.files.length > 0) {
        migrationBatchMap.clear()
        migrationBatchMap.set(batch.id, batch)
      }
      migrationFileMap.clear()
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('migration:cancel', (event) => {
    assertTrustedSender(event)
    if (activeTask?.kind === 'migration' || activeTask?.kind === 'migration-undo') {
      activeTask.controller.cancelled = true
    }
  })

  ipcMain.handle('migration:undo', async (event, batchId: unknown) => {
    assertTrustedSender(event)
    if (typeof batchId !== 'string') throw new Error('无效的迁移批次')
    const batch = migrationBatchMap.get(batchId)
    if (!batch) throw new Error('当前会话中没有可撤销的迁移记录')
    const controller = beginTask('migration-undo')
    try {
      const result = await undoMigrationBatch(batch, controller, sendProgress)
      migrationBatchMap.delete(batchId)
      return result
    } finally {
      finishTask(controller)
    }
  })

  ipcMain.handle('migration:reveal', (event, batchId: unknown, fileId: unknown) => {
    assertTrustedSender(event)
    if (typeof batchId !== 'string' || typeof fileId !== 'string') return false
    const file = migrationBatchMap.get(batchId)?.files.find((item) => item.id === fileId)
    if (!file) return false
    shell.showItemInFolder(file.destinationPath)
    return true
  })

  ipcMain.handle('updates:check', async (event, force: unknown) => {
    assertTrustedSender(event)
    if (typeof force !== 'boolean') throw new Error('无效的更新检查请求')
    const { downloadUrl: _downloadUrl, releaseUrl: _releaseUrl, ...result } = await checkForUpdates(force)
    return result
  })

  ipcMain.handle('updates:download', async (event) => {
    assertTrustedSender(event)
    const update = await checkForUpdates()
    if (
      update.status !== 'available'
      || !update.downloadAvailable
      || !update.downloadUrl
    ) return false
    await shell.openExternal(update.downloadUrl, { activate: true, logUsage: true })
    return true
  })

  ipcMain.handle('updates:open-page', async (event) => {
    assertTrustedSender(event)
    const update = await checkForUpdates()
    if (!update.releaseUrl) return false
    await shell.openExternal(update.releaseUrl, { activate: true, logUsage: true })
    return true
  })
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'jingpan-media',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}])

app.enableSandbox()

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setDevicePermissionHandler(() => false)
  registerMediaProtocol()
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => app.quit())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
