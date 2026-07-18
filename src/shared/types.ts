export type CategoryId =
  | 'user-temp'
  | 'windows-temp'
  | 'browser-cache'
  | 'system-cache'
  | 'crash-reports'
  | 'thumbnail-cache'
  | 'recycle-bin'

export type SafetyLevel = 'recommended' | 'safe' | 'review'

export interface CategoryMeta {
  id: CategoryId
  title: string
  description: string
  detail: string
  safety: SafetyLevel
  defaultSelected: boolean
  icon: 'sparkles' | 'windows' | 'browser' | 'cpu' | 'report' | 'image' | 'trash'
}

export interface ScannedCategory extends CategoryMeta {
  bytes: number
  fileCount: number
  inaccessibleCount: number
}

export interface DiskSummary {
  drive: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

export interface AppSnapshot {
  version: string
  disk: DiskSummary
  categories: CategoryMeta[]
  isAdministrator: boolean
}

export interface TaskProgress {
  kind: 'scan' | 'clean' | 'analyze'
  percent: number
  title: string
  detail: string
  filesVisited?: number
}

export interface ScanResult {
  scanId: string
  categories: ScannedCategory[]
  scannedAt: string
  totalBytes: number
  totalFiles: number
  durationMs: number
  cancelled: boolean
}

export interface CleanupResult {
  reclaimedBytes: number
  removedFiles: number
  failedFiles: number
  durationMs: number
  cancelled: boolean
  errors: string[]
}

export interface SpaceGroup {
  id: 'system' | 'apps' | 'users' | 'program-data' | 'other'
  title: string
  description: string
  bytes: number
  fileCount: number
  color: string
}

export interface LargeFile {
  path: string
  name: string
  bytes: number
  modifiedAt: string
}

export interface AnalysisResult {
  groups: SpaceGroup[]
  largeFiles: LargeFile[]
  systemItems: SystemSpaceItem[]
  analyzedAt: string
  durationMs: number
  cancelled: boolean
}

export type SystemSpaceItemId = 'hibernation' | 'pagefile' | 'swapfile' | 'memory-dump' | 'previous-windows'

export interface SystemSpaceItem {
  id: SystemSpaceItemId
  title: string
  description: string
  bytes: number
  action: 'none' | 'storage-recommendations'
}

export type UserFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'word'
  | 'powerpoint'
  | 'spreadsheet'
  | 'pdf'
  | 'archive'
  | 'installer'

export type UserFileLocation =
  | 'downloads'
  | 'desktop'
  | 'documents'
  | 'pictures'
  | 'videos'
  | 'music'
  | 'onedrive'

export interface UserFileItem {
  id: string
  kind: UserFileKind
  name: string
  path: string
  extension: string
  bytes: number
  modifiedAt: string
  location: UserFileLocation
}

export interface UserFileScanResult {
  files: UserFileItem[]
  scannedAt: string
  durationMs: number
  cancelled: boolean
  truncated: boolean
  totalMatched: number
}

export interface UserFileDeleteResult {
  movedToRecycleBin: number
  failed: number
  movedIds: string[]
  failedIds: string[]
  errors: string[]
}

export interface UserFileOpenResult {
  opened: boolean
  message: string
}

export interface DuplicateFileGroup {
  id: string
  bytesPerFile: number
  reclaimableBytes: number
  files: UserFileItem[]
}

export interface DuplicateFileScanResult {
  groups: DuplicateFileGroup[]
  scannedAt: string
  durationMs: number
  cancelled: boolean
  truncated: boolean
  candidateFiles: number
  hashedFiles: number
  duplicateFiles: number
  reclaimableBytes: number
  cloudFoldersSkipped: boolean
}

export type ChatPlatform = 'wechat' | 'qq'
export type ChatStorageSource = 'automatic' | 'custom'

export type ChatFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'word'
  | 'powerpoint'
  | 'spreadsheet'
  | 'pdf'
  | 'archive'
  | 'installer'
  | 'other'

export type ChatFileArea =
  | 'file'
  | 'attachment'
  | 'image'
  | 'video'
  | 'audio'
  | 'cache'
  | 'sticker'
  | 'temporary'

export interface ChatAccountSummary {
  id: string
  platform: ChatPlatform
  label: string
  fileCount: number
  bytes: number
}

export interface ChatFileItem {
  id: string
  platform: ChatPlatform
  accountId: string
  accountLabel: string
  area: ChatFileArea
  kind: ChatFileKind
  name: string
  path: string
  extension: string
  bytes: number
  modifiedAt: string
  previewable: boolean
  drive: string
  onSystemDrive: boolean
}

export interface ChatStorageLocation {
  platform: ChatPlatform
  path: string
  drive: string
  onSystemDrive: boolean
  source: ChatStorageSource
}

export interface ChatStorageFolderResult {
  selected: boolean
  recognized: boolean
  added: boolean
  path: string | null
  message: string
}

export interface ChatFileScanResult {
  files: ChatFileItem[]
  accounts: ChatAccountSummary[]
  locations: ChatStorageLocation[]
  scannedAt: string
  durationMs: number
  cancelled: boolean
  truncated: boolean
  totalMatched: number
}

export interface UpdateCheckResult {
  status: 'available' | 'current' | 'error'
  currentVersion: string
  latestVersion: string | null
  releaseName: string | null
  releaseNotes: string
  publishedAt: string | null
  assetName: string | null
  assetBytes: number
  assetDigest: string | null
  downloadAvailable: boolean
  checkedAt: string
  message: string
}

export type AppUsageStatus = 'recent' | 'stale' | 'very-stale' | 'unknown'

export interface InstalledApp {
  id: string
  name: string
  publisher: string
  version: string
  installDate: string | null
  estimatedBytes: number
  installLocation: string
  lastUsedAt: string | null
  usageStatus: AppUsageStatus
  systemDriveStatus: 'system' | 'other' | 'unknown'
  uninstallAvailable: boolean
}

export interface InstalledAppScanResult {
  apps: InstalledApp[]
  scannedAt: string
  durationMs: number
}

export interface UninstallLaunchResult {
  launched: boolean
  openedSettings: boolean
  message: string
}

export interface JingpanApi {
  getSnapshot: () => Promise<AppSnapshot>
  startScan: () => Promise<ScanResult>
  cancelScan: () => Promise<void>
  startCleanup: (scanId: string, categoryIds: CategoryId[]) => Promise<CleanupResult>
  cancelCleanup: () => Promise<void>
  startAnalysis: () => Promise<AnalysisResult>
  cancelAnalysis: () => Promise<void>
  revealLargeFile: (path: string) => Promise<boolean>
  openStorageSettings: () => Promise<void>
  openStorageRecommendations: () => Promise<void>
  openStorageSenseSettings: () => Promise<void>
  openSaveLocations: () => Promise<void>
  openDiskCleanup: () => Promise<void>
  scanUserFiles: () => Promise<UserFileScanResult>
  cancelUserFileScan: () => Promise<void>
  recycleUserFiles: (fileIds: string[]) => Promise<UserFileDeleteResult>
  openUserFile: (fileId: string) => Promise<UserFileOpenResult>
  revealUserFile: (fileId: string) => Promise<boolean>
  scanDuplicateFiles: () => Promise<DuplicateFileScanResult>
  cancelDuplicateFileScan: () => Promise<void>
  recycleDuplicateFiles: (fileIds: string[]) => Promise<UserFileDeleteResult>
  openDuplicateFile: (fileId: string) => Promise<UserFileOpenResult>
  revealDuplicateFile: (fileId: string) => Promise<boolean>
  scanChatFiles: () => Promise<ChatFileScanResult>
  chooseQqStorageFolder: () => Promise<ChatStorageFolderResult>
  cancelChatFileScan: () => Promise<void>
  recycleChatFiles: (fileIds: string[]) => Promise<UserFileDeleteResult>
  openChatFile: (fileId: string) => Promise<UserFileOpenResult>
  revealChatFile: (fileId: string) => Promise<boolean>
  scanInstalledApps: () => Promise<InstalledAppScanResult>
  launchAppUninstaller: (appId: string) => Promise<UninstallLaunchResult>
  checkForUpdates: (force?: boolean) => Promise<UpdateCheckResult>
  downloadUpdate: () => Promise<boolean>
  openUpdatePage: () => Promise<boolean>
  onProgress: (listener: (progress: TaskProgress) => void) => () => void
}
