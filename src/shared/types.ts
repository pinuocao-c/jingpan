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
  analyzedAt: string
  durationMs: number
  cancelled: boolean
}

export type UserFileKind =
  | 'image'
  | 'video'
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
  openDiskCleanup: () => Promise<void>
  scanUserFiles: () => Promise<UserFileScanResult>
  cancelUserFileScan: () => Promise<void>
  recycleUserFiles: (fileIds: string[]) => Promise<UserFileDeleteResult>
  revealUserFile: (fileId: string) => Promise<boolean>
  scanInstalledApps: () => Promise<InstalledAppScanResult>
  launchAppUninstaller: (appId: string) => Promise<UninstallLaunchResult>
  onProgress: (listener: (progress: TaskProgress) => void) => () => void
}
