import { contextBridge, ipcRenderer } from 'electron'
import type { CategoryId, FileThumbnailScope, JingpanApi, TaskProgress } from '../shared/types'

const api: JingpanApi = {
  getSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  startScan: () => ipcRenderer.invoke('scan:start'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  startCleanup: (scanId: string, categoryIds: CategoryId[]) => ipcRenderer.invoke('clean:start', scanId, categoryIds),
  cancelCleanup: () => ipcRenderer.invoke('clean:cancel'),
  startAnalysis: () => ipcRenderer.invoke('analysis:start'),
  cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),
  revealLargeFile: (path: string) => ipcRenderer.invoke('file:reveal', path),
  openStorageSettings: () => ipcRenderer.invoke('settings:storage'),
  openStorageRecommendations: () => ipcRenderer.invoke('settings:storage-recommendations'),
  openStorageSenseSettings: () => ipcRenderer.invoke('settings:storage-sense'),
  openSaveLocations: () => ipcRenderer.invoke('settings:save-locations'),
  openDiskCleanup: () => ipcRenderer.invoke('settings:disk-cleanup'),
  scanUserFiles: () => ipcRenderer.invoke('user-files:scan'),
  cancelUserFileScan: () => ipcRenderer.invoke('user-files:cancel'),
  recycleUserFiles: (fileIds: string[]) => ipcRenderer.invoke('user-files:recycle', fileIds),
  openUserFile: (fileId: string) => ipcRenderer.invoke('user-files:open', fileId),
  revealUserFile: (fileId: string) => ipcRenderer.invoke('user-files:reveal', fileId),
  scanDuplicateFiles: () => ipcRenderer.invoke('duplicate-files:scan'),
  cancelDuplicateFileScan: () => ipcRenderer.invoke('duplicate-files:cancel'),
  recycleDuplicateFiles: (fileIds: string[]) => ipcRenderer.invoke('duplicate-files:recycle', fileIds),
  openDuplicateFile: (fileId: string) => ipcRenderer.invoke('duplicate-files:open', fileId),
  revealDuplicateFile: (fileId: string) => ipcRenderer.invoke('duplicate-files:reveal', fileId),
  scanChatFiles: () => ipcRenderer.invoke('chat-files:scan'),
  chooseQqStorageFolder: () => ipcRenderer.invoke('chat-files:choose-qq-folder'),
  cancelChatFileScan: () => ipcRenderer.invoke('chat-files:cancel'),
  recycleChatFiles: (fileIds: string[]) => ipcRenderer.invoke('chat-files:recycle', fileIds),
  openChatFile: (fileId: string) => ipcRenderer.invoke('chat-files:open', fileId),
  revealChatFile: (fileId: string) => ipcRenderer.invoke('chat-files:reveal', fileId),
  scanInstalledApps: () => ipcRenderer.invoke('apps:scan'),
  launchAppUninstaller: (appId: string) => ipcRenderer.invoke('apps:uninstall', appId),
  scanMigrationCandidates: () => ipcRenderer.invoke('migration:scan'),
  cancelMigrationScan: () => ipcRenderer.invoke('migration:cancel-scan'),
  migrateFiles: (scanId: string, fileIds: string[]) => ipcRenderer.invoke('migration:start', scanId, fileIds),
  cancelMigration: () => ipcRenderer.invoke('migration:cancel'),
  undoMigration: (batchId: string) => ipcRenderer.invoke('migration:undo', batchId),
  revealMigratedFile: (batchId: string, fileId: string) => ipcRenderer.invoke('migration:reveal', batchId, fileId),
  getFileThumbnail: (scope: FileThumbnailScope, fileId: string) => ipcRenderer.invoke('file:thumbnail', scope, fileId),
  checkForUpdates: (force = false) => ipcRenderer.invoke('updates:check', force),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  openUpdatePage: () => ipcRenderer.invoke('updates:open-page'),
  onProgress: (listener: (progress: TaskProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: TaskProgress): void => listener(progress)
    ipcRenderer.on('task:progress', handler)
    return () => ipcRenderer.removeListener('task:progress', handler)
  }
}

contextBridge.exposeInMainWorld('jingpan', api)
