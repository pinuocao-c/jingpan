import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import type { CategoryId, TaskProgress } from '../shared/types'
import { analyzeSystemDrive } from './services/analyzer'
import { launchUninstaller, scanInstalledApps, type InternalApp } from './services/apps'
import { CATEGORY_META } from './services/catalog'
import {
  scanChatFiles,
  verifyChatFileSnapshot,
  type InternalChatFile
} from './services/chatFiles'
import { cleanCategories } from './services/cleaner'
import type { TaskController } from './services/filesystem'
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
  kind: 'scan' | 'clean' | 'analyze' | 'user-files' | 'chat-files' | 'apps'
  controller: TaskController
} | null = null
let revealedPaths = new Set<string>()
let userFileMap = new Map<string, InternalUserFile>()
let chatFileMap = new Map<string, InternalChatFile>()
let installedAppMap = new Map<string, InternalApp>()
let cachedUpdate: TrustedUpdate | null = null
let updateCheckPromise: Promise<TrustedUpdate> | null = null
let cleanupSession: {
  scanId: string
  expiresAt: number
  categories: Set<CategoryId>
} | null = null

const CLEANUP_SESSION_TTL_MS = 30 * 60 * 1000
const MAX_RECYCLE_BATCH = 2_000
const UPDATE_CACHE_TTL_MS = 30 * 60 * 1000
const UPDATE_ERROR_CACHE_TTL_MS = 60 * 1000

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: '#f5f7fb',
    title: '净盘',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f9fc',
      symbolColor: '#647184',
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

function beginTask(kind: 'scan' | 'clean' | 'analyze' | 'user-files' | 'chat-files' | 'apps'): TaskController {
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
    return { version: app.getVersion(), disk, categories: CATEGORY_META, isAdministrator }
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

  ipcMain.handle('settings:storage', async (event) => {
    assertTrustedSender(event)
    await shell.openExternal('ms-settings:storagesense')
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

  ipcMain.handle('chat-files:scan', async (event) => {
    assertTrustedSender(event)
    chatFileMap.clear()
    const controller = beginTask('chat-files')
    try {
      const { result, internal } = await scanChatFiles(controller, sendProgress)
      chatFileMap = internal
      return result
    } finally {
      finishTask(controller)
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

app.enableSandbox()

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setDevicePermissionHandler(() => false)
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => app.quit())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
