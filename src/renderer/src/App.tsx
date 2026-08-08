import {
  Archive,
  ArrowDownNarrowWide,
  ArrowRightLeft,
  ArrowUpNarrowWide,
  AppWindow,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CircleHelp,
  CopyCheck,
  Download,
  ExternalLink,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Files,
  FolderOpen,
  FolderSearch,
  Gauge,
  HardDrive,
  LayoutDashboard,
  LayoutGrid,
  List,
  LoaderCircle,
  MessageCircle,
  MonitorCog,
  NotepadText,
  Package,
  Presentation,
  RefreshCw,
  Recycle,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AnalysisResult,
  AppSnapshot,
  CategoryId,
  ChatFileArea,
  ChatFileItem,
  ChatFileKind,
  ChatFileScanResult,
  ChatPlatform,
  CleanupResult,
  DuplicateFileScanResult,
  FileThumbnailScope,
  InstalledApp,
  InstalledAppScanResult,
  MigrationResult,
  MigrationScanResult,
  ScanResult,
  ScannedCategory,
  TaskProgress,
  UpdateCheckResult,
  UserFileItem,
  UserFileKind,
  UserFileLocation,
  UserFileScanResult
} from '../../shared/types'
import { formatBytes, formatDate, formatDuration } from './format'
import { compareFiles, formatScanAge, isScanStale, type FileSortKey, type SortDirection } from './fileUi'
import LiquidGlassRenderer from './LiquidGlassRenderer'

type Page = 'overview' | 'cleanup' | 'analysis' | 'duplicates' | 'chat' | 'files' | 'migration' | 'apps' | 'settings'
type BusyTask =
  | 'scan'
  | 'clean'
  | 'analysis'
  | 'duplicates'
  | 'files'
  | 'chat'
  | 'apps'
  | 'migration-scan'
  | 'migration'
  | 'migration-undo'
  | null
type FileViewMode = 'list' | 'grid'
type RecycleScope = 'files' | 'chat' | 'duplicates'
type RecycleReport = {
  scope: RecycleScope
  moved: number
  movedBytes: number
  systemBytes: number
  otherBytes: number
  failed: number
  errors: string[]
}
type MediaPreviewItem = {
  id: string
  kind: 'image' | 'video'
  name: string
  path: string
  bytes: number
  modifiedAt: string
}
type Dialog =
  | { type: 'cleanup'; ids: CategoryId[]; bytes: number }
  | { type: 'recycle'; ids: string[]; bytes: number }
  | { type: 'duplicate-recycle'; ids: string[]; bytes: number }
  | { type: 'chat-recycle'; ids: string[]; bytes: number }
  | { type: 'migration'; ids: string[]; bytes: number }
  | { type: 'migration-undo'; batchId: string; files: number; bytes: number }
  | { type: 'uninstall'; app: InstalledApp }
  | null

const FILE_KIND_META: Record<UserFileKind, { label: string; icon: typeof FileImage; color: string }> = {
  image: { label: '图片', icon: FileImage, color: '#ec6f8c' },
  video: { label: '视频', icon: FileVideo, color: '#7856ff' },
  audio: { label: '音频', icon: FileAudio, color: '#2d9b8f' },
  text: { label: '文本', icon: NotepadText, color: '#64748b' },
  word: { label: 'Word', icon: FileText, color: '#3978dc' },
  powerpoint: { label: 'PPT', icon: Presentation, color: '#e66b3d' },
  spreadsheet: { label: '表格', icon: FileSpreadsheet, color: '#24a26a' },
  pdf: { label: 'PDF', icon: FileType2, color: '#e04f55' },
  archive: { label: '压缩包', icon: Archive, color: '#8c6b48' },
  installer: { label: '安装包', icon: Package, color: '#e18c2f' }
}

const CHAT_FILE_KIND_META: Record<ChatFileKind, { label: string; icon: typeof FileImage; color: string }> = {
  image: FILE_KIND_META.image,
  video: FILE_KIND_META.video,
  audio: { label: '音频', icon: FileAudio, color: '#2d9b8f' },
  text: FILE_KIND_META.text,
  word: FILE_KIND_META.word,
  powerpoint: FILE_KIND_META.powerpoint,
  spreadsheet: FILE_KIND_META.spreadsheet,
  pdf: FILE_KIND_META.pdf,
  archive: FILE_KIND_META.archive,
  installer: FILE_KIND_META.installer,
  other: { label: '其他文件', icon: Files, color: '#718096' }
}

const CHAT_AREA_LABELS: Record<ChatFileArea, string> = {
  file: '接收文件',
  attachment: '聊天附件',
  image: '聊天图片',
  video: '聊天视频',
  audio: '聊天音频',
  cache: '媒体缓存',
  sticker: '表情缓存',
  temporary: '临时文件'
}

function useStoredChoice<T extends string>(key: string, values: readonly T[], fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key) as T | null
      return stored && values.includes(stored) ? stored : fallback
    } catch {
      return fallback
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Preferences are optional; the file browser continues with in-memory state.
    }
  }, [key, value])
  return [value, setValue]
}

const navItems: Array<{ id: Page; label: string; description: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '空间概览', description: '查看 C 盘容量和建议操作', icon: LayoutDashboard },
  { id: 'cleanup', label: '安全清理', description: '扫描并清理白名单缓存', icon: Sparkles },
  { id: 'analysis', label: '空间分析', description: '了解系统与文件空间占用', icon: BarChart3 },
  { id: 'duplicates', label: '重复文件', description: '核对并回收完全相同的副本', icon: CopyCheck },
  { id: 'chat', label: '聊天文件', description: '整理微信与 QQ 本地文件', icon: MessageCircle },
  { id: 'files', label: '个人文件', description: '筛选、预览并整理个人文件', icon: FileText },
  { id: 'migration', label: '智能迁移', description: '校验后把个人文件迁移到 D 盘', icon: ArrowRightLeft },
  { id: 'apps', label: '应用管理', description: '查找闲置软件并安全卸载', icon: AppWindow },
  { id: 'settings', label: '设置与帮助', description: '打开系统工具和安全说明', icon: Settings }
]

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('overview')
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [duplicateFiles, setDuplicateFiles] = useState<DuplicateFileScanResult | null>(null)
  const [chatFiles, setChatFiles] = useState<ChatFileScanResult | null>(null)
  const [userFiles, setUserFiles] = useState<UserFileScanResult | null>(null)
  const [migration, setMigration] = useState<MigrationScanResult | null>(null)
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null)
  const [installedApps, setInstalledApps] = useState<InstalledAppScanResult | null>(null)
  const [busy, setBusy] = useState<BusyTask>(null)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [selectedCategories, setSelectedCategories] = useState<Set<CategoryId>>(new Set())
  const [selectedChatFiles, setSelectedChatFiles] = useState<Set<string>>(new Set())
  const [selectedDuplicateFiles, setSelectedDuplicateFiles] = useState<Set<string>>(new Set())
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [selectedMigrationFiles, setSelectedMigrationFiles] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toast, setToast] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const [recycleReport, setRecycleReport] = useState<RecycleReport | null>(null)
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null)
  const openingFiles = useRef(new Set<string>())
  const openingDuplicateFiles = useRef(new Set<string>())
  const openingChatFiles = useRef(new Set<string>())
  const checkingUpdate = useRef(false)
  useEffect(() => window.jingpan.onProgress(setProgress), [])

  const runCleanupScan = useCallback(async () => {
    if (busy) return
    setBusy('scan')
    setProgress({ kind: 'scan', percent: 0, title: '准备扫描', detail: '正在读取安全清理规则' })
    try {
      const result = await window.jingpan.startScan()
      setScan(result)
      setSelectedCategories(new Set(result.categories.filter((item) => item.defaultSelected && item.bytes > 0).map((item) => item.id)))
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '扫描未能完成' })
    } finally {
      setBusy(null)
    }
  }, [busy])

  useEffect(() => {
    let alive = true
    window.jingpan.getSnapshot().then((result) => {
      if (!alive) return
      setSnapshot(result)
      setSelectedCategories(new Set(result.categories.filter((item) => item.defaultSelected).map((item) => item.id)))
    }).catch(() => setToast({ tone: 'warning', text: '无法读取磁盘信息，请重新打开应用' }))
    return () => { alive = false }
  }, [])

  const checkForUpdates = useCallback(async (showResult: boolean): Promise<void> => {
    if (checkingUpdate.current) return
    checkingUpdate.current = true
    setUpdateChecking(true)
    try {
      const result = await window.jingpan.checkForUpdates(showResult)
      setUpdate(result)
      if (showResult) {
        setToast({
          tone: result.status === 'error' ? 'warning' : 'success',
          text: result.message
        })
      }
    } catch (error) {
      if (showResult) {
        setToast({
          tone: 'warning',
          text: error instanceof Error ? error.message : '暂时无法检查更新'
        })
      }
    } finally {
      checkingUpdate.current = false
      setUpdateChecking(false)
    }
  }, [])

  useEffect(() => {
    const initialCheck = window.setTimeout(() => void checkForUpdates(false), 2_000)
    const periodicCheck = window.setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1_000)
    return () => {
      window.clearTimeout(initialCheck)
      window.clearInterval(periodicCheck)
    }
  }, [checkForUpdates])

  const downloadUpdate = async (): Promise<void> => {
    try {
      const opened = await window.jingpan.downloadUpdate()
      setToast({
        tone: opened ? 'success' : 'warning',
        text: opened ? '已在默认浏览器打开官方安装包下载' : '新版安装包暂不可用，请稍后再试'
      })
    } catch (error) {
      setToast({
        tone: 'warning',
        text: error instanceof Error ? error.message : '无法打开新版安装包下载'
      })
    }
  }

  const openUpdatePage = async (): Promise<void> => {
    try {
      const opened = await window.jingpan.openUpdatePage()
      if (!opened) setToast({ tone: 'warning', text: '更新说明页面暂不可用' })
    } catch (error) {
      setToast({
        tone: 'warning',
        text: error instanceof Error ? error.message : '无法打开更新说明'
      })
    }
  }

  const openRecycleBin = async (): Promise<void> => {
    try {
      const opened = await window.jingpan.openRecycleBin()
      if (!opened) setToast({ tone: 'warning', text: '无法打开 Windows 回收站' })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '无法打开 Windows 回收站' })
    }
  }

  const runAnalysis = async (): Promise<void> => {
    if (busy) return
    setBusy('analysis')
    setProgress({ kind: 'analyze', percent: 0, title: '准备分析', detail: '这可能需要几分钟' })
    try {
      setAnalysis(await window.jingpan.startAnalysis())
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '空间分析未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const runDuplicateFileScan = async (): Promise<void> => {
    if (busy) return
    setBusy('duplicates')
    setSelectedDuplicateFiles(new Set())
    setRecycleReport((current) => current?.scope === 'duplicates' ? null : current)
    setProgress({ kind: 'analyze', percent: 0, title: '准备核对重复文件', detail: '只处理 C 盘个人目录中 1 MB 以上的本地文件' })
    try {
      setDuplicateFiles(await window.jingpan.scanDuplicateFiles())
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '重复文件扫描未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const runUserFileScan = async (): Promise<void> => {
    if (busy) return
    setBusy('files')
    setSelectedFiles(new Set())
    setRecycleReport((current) => current?.scope === 'files' ? null : current)
    setProgress({ kind: 'analyze', percent: 0, title: '准备整理个人文件', detail: '只读取个人目录中的文件信息' })
    try {
      setUserFiles(await window.jingpan.scanUserFiles())
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '个人文件整理未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const runMigrationScan = async (): Promise<void> => {
    if (busy) return
    setBusy('migration-scan')
    setSelectedMigrationFiles(new Set())
    setMigrationResult(null)
    setProgress({
      kind: 'migrate',
      percent: 0,
      title: '准备识别可迁移文件',
      detail: '只检查 C 盘个人目录中的独立文件'
    })
    try {
      const result = await window.jingpan.scanMigrationCandidates()
      setMigration(result)
      setSelectedMigrationFiles(new Set(
        result.files
          .filter((file) => file.confidence === 'recommended')
          .map((file) => file.id)
      ))
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '迁移候选识别未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const runChatFileScan = async (): Promise<void> => {
    if (busy) return
    setBusy('chat')
    setSelectedChatFiles(new Set())
    setRecycleReport((current) => current?.scope === 'chat' ? null : current)
    setProgress({ kind: 'analyze', percent: 0, title: '准备整理聊天文件', detail: '正在识别微信目录以及 QQ/NTQQ 的自定义数据位置' })
    try {
      setChatFiles(await window.jingpan.scanChatFiles())
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '聊天文件整理未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const chooseQqStorageFolder = async (): Promise<void> => {
    if (busy) return
    try {
      const result = await window.jingpan.chooseQqStorageFolder()
      if (!result.selected) return
      setToast({ tone: result.recognized ? 'success' : 'warning', text: result.message })
      if (result.recognized) await runChatFileScan()
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '无法添加 QQ 文件目录' })
    }
  }

  const runAppScan = async (): Promise<void> => {
    if (busy) return
    setBusy('apps')
    setProgress({ kind: 'analyze', percent: 35, title: '正在读取已安装应用', detail: '同时检查当前用户的 Windows 使用记录' })
    try {
      setInstalledApps(await window.jingpan.scanInstalledApps())
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '应用列表读取失败' })
    } finally {
      setBusy(null)
    }
  }

  const confirmCleanup = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'cleanup' || !scan) return
    const ids = dialog.ids
    setDialog(null)
    setBusy('clean')
    setCleanupResult(null)
    try {
      const result = await window.jingpan.startCleanup(scan.scanId, ids)
      setCleanupResult(result)
      setToast({
        tone: result.failedFiles > 0 ? 'warning' : 'success',
        text: `已释放 ${formatBytes(result.reclaimedBytes)}，${result.failedFiles} 个占用中或无权限文件被跳过`
      })
      const refreshed = await window.jingpan.startScan()
      setScan(refreshed)
      if (snapshot) {
        const updated = await window.jingpan.getSnapshot()
        setSnapshot(updated)
      }
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '清理未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const confirmRecycle = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'recycle' || !userFiles) return
    const ids = dialog.ids
    const selectedById = new Map(userFiles.files.map((file) => [file.id, file]))
    setDialog(null)
    try {
      let movedToRecycleBin = 0
      let failed = 0
      const movedIds: string[] = []
      const errors: string[] = []
      for (let index = 0; index < ids.length; index += 2_000) {
        const result = await window.jingpan.recycleUserFiles(ids.slice(index, index + 2_000))
        movedToRecycleBin += result.movedToRecycleBin
        failed += result.failed
        movedIds.push(...result.movedIds)
        errors.push(...result.errors.slice(0, Math.max(0, 20 - errors.length)))
      }
      const removed = new Set(movedIds)
      const movedBytes = movedIds.reduce((sum, id) => sum + (selectedById.get(id)?.bytes ?? 0), 0)
      setUserFiles({ ...userFiles, files: userFiles.files.filter((file) => !removed.has(file.id)) })
      setSelectedFiles(new Set(ids.filter((id) => !removed.has(id))))
      setRecycleReport({
        scope: 'files',
        moved: movedToRecycleBin,
        movedBytes,
        systemBytes: movedBytes,
        otherBytes: 0,
        failed,
        errors
      })
      setToast({
        tone: failed > 0 ? 'warning' : 'success',
        text: `${movedToRecycleBin} 个文件（${formatBytes(movedBytes)}）已移入回收站${failed ? `，${failed} 个处理失败` : ''}`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '文件未能移入回收站' })
    }
  }

  const confirmChatRecycle = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'chat-recycle' || !chatFiles) return
    const ids = dialog.ids
    const selectedById = new Map(chatFiles.files.map((file) => [file.id, file]))
    setDialog(null)
    try {
      let movedToRecycleBin = 0
      let failed = 0
      const movedIds: string[] = []
      const errors: string[] = []
      for (let index = 0; index < ids.length; index += 2_000) {
        const result = await window.jingpan.recycleChatFiles(ids.slice(index, index + 2_000))
        movedToRecycleBin += result.movedToRecycleBin
        failed += result.failed
        movedIds.push(...result.movedIds)
        errors.push(...result.errors.slice(0, Math.max(0, 20 - errors.length)))
      }
      const removed = new Set(movedIds)
      const movedItems = movedIds.map((id) => selectedById.get(id)).filter((file): file is ChatFileItem => Boolean(file))
      const systemBytes = movedItems.filter((file) => file.onSystemDrive).reduce((sum, file) => sum + file.bytes, 0)
      const otherBytes = movedItems.filter((file) => !file.onSystemDrive).reduce((sum, file) => sum + file.bytes, 0)
      const movedBytes = systemBytes + otherBytes
      setChatFiles({
        ...chatFiles,
        files: chatFiles.files.filter((file) => !removed.has(file.id)),
        accounts: chatFiles.accounts
          .map((account) => {
            const remaining = chatFiles.files.filter((file) => file.accountId === account.id && !removed.has(file.id))
            return {
              ...account,
              fileCount: remaining.length,
              bytes: remaining.reduce((sum, file) => sum + file.bytes, 0)
            }
          })
          .filter((account) => account.fileCount > 0)
      })
      setSelectedChatFiles(new Set(ids.filter((id) => !removed.has(id))))
      setRecycleReport({
        scope: 'chat',
        moved: movedToRecycleBin,
        movedBytes,
        systemBytes,
        otherBytes,
        failed,
        errors
      })
      setToast({
        tone: failed > 0 ? 'warning' : 'success',
        text: `${movedToRecycleBin} 个聊天文件（${formatBytes(movedBytes)}）已移入回收站${failed ? `，${failed} 个处理失败` : ''}`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '聊天文件未能移入回收站' })
    }
  }

  const confirmDuplicateRecycle = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'duplicate-recycle' || !duplicateFiles) return
    const ids = dialog.ids
    const selectedById = new Map(duplicateFiles.groups.flatMap((group) => group.files).map((file) => [file.id, file]))
    setDialog(null)
    try {
      const result = await window.jingpan.recycleDuplicateFiles(ids)
      const { movedToRecycleBin, failed, movedIds, errors } = result
      const removed = new Set(movedIds)
      const movedBytes = movedIds.reduce((sum, id) => sum + (selectedById.get(id)?.bytes ?? 0), 0)
      const groups = duplicateFiles.groups
        .map((group) => {
          const files = group.files.filter((file) => !removed.has(file.id))
          return {
            ...group,
            files,
            reclaimableBytes: Math.max(0, group.bytesPerFile * (files.length - 1))
          }
        })
        .filter((group) => group.files.length > 1)
      setDuplicateFiles({
        ...duplicateFiles,
        groups,
        duplicateFiles: groups.reduce((sum, group) => sum + group.files.length, 0),
        reclaimableBytes: groups.reduce((sum, group) => sum + group.reclaimableBytes, 0)
      })
      setSelectedDuplicateFiles(new Set(ids.filter((id) => !removed.has(id))))
      setRecycleReport({
        scope: 'duplicates',
        moved: movedToRecycleBin,
        movedBytes,
        systemBytes: movedBytes,
        otherBytes: 0,
        failed,
        errors: errors.slice(0, 20)
      })
      setToast({
        tone: failed > 0 ? 'warning' : 'success',
        text: `${movedToRecycleBin} 个重复副本（${formatBytes(movedBytes)}）已移入回收站${failed ? `，${failed} 个处理失败` : ''}`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '重复文件未能移入回收站' })
    }
  }

  const confirmUninstall = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'uninstall') return
    const app = dialog.app
    setDialog(null)
    try {
      const result = await window.jingpan.launchAppUninstaller(app.id)
      setToast({ tone: result.launched ? 'success' : 'warning', text: result.message })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '无法打开卸载程序' })
    }
  }

  const confirmMigration = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'migration' || !migration) return
    const ids = dialog.ids
    setDialog(null)
    setBusy('migration')
    setProgress({
      kind: 'migrate',
      percent: 0,
      title: '准备迁移到 D 盘',
      detail: '复制、SHA-256 校验和源文件移除将依次进行'
    })
    try {
      const result = await window.jingpan.migrateFiles(migration.scanId, ids)
      setMigrationResult(result)
      setMigration(null)
      setSelectedMigrationFiles(new Set())
      setSnapshot(await window.jingpan.getSnapshot())
      setToast({
        tone: result.failed > 0 ? 'warning' : 'success',
        text: `已释放 C 盘 ${formatBytes(result.reclaimedBytes)}，成功 ${result.moved} 个，失败 ${result.failed} 个`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '文件迁移未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const confirmMigrationUndo = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'migration-undo') return
    const batchId = dialog.batchId
    setDialog(null)
    setBusy('migration-undo')
    setProgress({
      kind: 'migrate',
      percent: 0,
      title: '准备撤销最近一次迁移',
      detail: '先校验 D 盘副本，再恢复到 C 盘原位置'
    })
    try {
      const result = await window.jingpan.undoMigration(batchId)
      setMigrationResult(null)
      setSnapshot(await window.jingpan.getSnapshot())
      setToast({
        tone: result.failed > 0 ? 'warning' : 'success',
        text: `已恢复 ${result.restored} 个文件到 C 盘${result.failed ? `，${result.failed} 个未恢复` : ''}`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '迁移撤销未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const openUserFile = async (fileId: string): Promise<void> => {
    if (openingFiles.current.has(fileId)) return
    openingFiles.current.add(fileId)
    try {
      const result = await window.jingpan.openUserFile(fileId)
      if (!result.opened) setToast({ tone: 'warning', text: result.message })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '无法打开文件' })
    } finally {
      openingFiles.current.delete(fileId)
    }
  }

  const openChatFile = async (fileId: string): Promise<void> => {
    if (openingChatFiles.current.has(fileId)) return
    openingChatFiles.current.add(fileId)
    try {
      const result = await window.jingpan.openChatFile(fileId)
      if (!result.opened) setToast({ tone: 'warning', text: result.message })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '无法打开聊天文件' })
    } finally {
      openingChatFiles.current.delete(fileId)
    }
  }

  const openDuplicateFile = async (fileId: string): Promise<void> => {
    if (openingDuplicateFiles.current.has(fileId)) return
    openingDuplicateFiles.current.add(fileId)
    try {
      const result = await window.jingpan.openDuplicateFile(fileId)
      if (!result.opened) setToast({ tone: 'warning', text: result.message })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '无法打开重复文件' })
    } finally {
      openingDuplicateFiles.current.delete(fileId)
    }
  }

  const cancelBusy = (): void => {
    if (busy === 'scan') void window.jingpan.cancelScan()
    if (busy === 'clean') void window.jingpan.cancelCleanup()
    if (busy === 'analysis') void window.jingpan.cancelAnalysis()
    if (busy === 'duplicates') void window.jingpan.cancelDuplicateFileScan()
    if (busy === 'files') void window.jingpan.cancelUserFileScan()
    if (busy === 'chat') void window.jingpan.cancelChatFileScan()
    if (busy === 'migration-scan') void window.jingpan.cancelMigrationScan()
    if (busy === 'migration' || busy === 'migration-undo') void window.jingpan.cancelMigration()
  }

  const selectedCleanupBytes = scan?.categories
    .filter((item) => selectedCategories.has(item.id))
    .reduce((sum, item) => sum + item.bytes, 0) ?? 0

  const content = (() => {
    if (!snapshot) return <LoadingScreen />
    switch (page) {
      case 'overview':
        return <OverviewPage snapshot={snapshot} scan={scan} analysis={analysis} busy={busy} onScan={runCleanupScan} onNavigate={setPage} />
      case 'cleanup':
        return (
          <CleanupPage
            scan={scan}
            busy={busy}
            selected={selectedCategories}
            selectedBytes={selectedCleanupBytes}
            cleanupResult={cleanupResult}
            onScan={runCleanupScan}
            onToggle={(id) => setSelectedCategories((current) => toggleSet(current, id))}
            onClean={() => setDialog({ type: 'cleanup', ids: [...selectedCategories], bytes: selectedCleanupBytes })}
          />
        )
      case 'analysis':
        return <AnalysisPage analysis={analysis} busy={busy} onAnalyze={runAnalysis} />
      case 'duplicates':
        return (
          <DuplicateFilesPage
            result={duplicateFiles}
            busy={busy}
            selected={selectedDuplicateFiles}
            onScan={runDuplicateFileScan}
            onSelectedChange={setSelectedDuplicateFiles}
            onOpen={openDuplicateFile}
            onRecycle={(ids, bytes) => setDialog({ type: 'duplicate-recycle', ids, bytes })}
            recycleReport={recycleReport?.scope === 'duplicates' ? recycleReport : null}
            onDismissReport={() => setRecycleReport(null)}
            onOpenRecycleBin={() => void openRecycleBin()}
            onGoCleanup={() => setPage('cleanup')}
          />
        )
      case 'chat':
        return (
          <ChatFilesPage
            result={chatFiles}
            busy={busy}
            selected={selectedChatFiles}
            onScan={runChatFileScan}
            onChooseQqFolder={chooseQqStorageFolder}
            onSelectedChange={setSelectedChatFiles}
            onOpen={openChatFile}
            onRecycle={(ids, bytes) => setDialog({ type: 'chat-recycle', ids, bytes })}
            recycleReport={recycleReport?.scope === 'chat' ? recycleReport : null}
            onDismissReport={() => setRecycleReport(null)}
            onOpenRecycleBin={() => void openRecycleBin()}
            onGoCleanup={() => setPage('cleanup')}
          />
        )
      case 'files':
        return (
          <PersonalFilesPage
            result={userFiles}
            busy={busy}
            selected={selectedFiles}
            onScan={runUserFileScan}
            onSelectedChange={setSelectedFiles}
            onOpen={openUserFile}
            onRecycle={(ids, bytes) => setDialog({ type: 'recycle', ids, bytes })}
            recycleReport={recycleReport?.scope === 'files' ? recycleReport : null}
            onDismissReport={() => setRecycleReport(null)}
            onOpenRecycleBin={() => void openRecycleBin()}
            onGoCleanup={() => setPage('cleanup')}
          />
        )
      case 'migration':
        return (
          <MigrationPage
            result={migration}
            lastResult={migrationResult}
            busy={busy}
            selected={selectedMigrationFiles}
            onScan={runMigrationScan}
            onSelectedChange={setSelectedMigrationFiles}
            onMigrate={(ids, bytes) => setDialog({ type: 'migration', ids, bytes })}
            onUndo={(batchId, files, bytes) => setDialog({
              type: 'migration-undo',
              batchId,
              files,
              bytes
            })}
          />
        )
      case 'apps':
        return <InstalledAppsPage result={installedApps} busy={busy} onScan={runAppScan} onUninstall={(app) => setDialog({ type: 'uninstall', app })} />
      case 'settings':
        return (
          <SettingsPage
            snapshot={snapshot}
            update={update}
            checking={updateChecking}
            onCheck={() => void checkForUpdates(true)}
            onDownload={() => void downloadUpdate()}
            onOpenPage={() => void openUpdatePage()}
            onOpenData={() => void window.jingpan.openAppDataFolder()}
          />
        )
    }
  })()

  return (
    <div className="app-shell">
      <LiquidGlassRenderer />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={20} strokeWidth={2.4} /></div>
          <div><strong>净盘</strong><span>安全管理 C 盘</span></div>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={page === item.id ? 'active' : ''}
                data-liquid-glass
                data-glass-depth="34"
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => setPage(item.id)}
              >
                <Icon size={19} />
                <span className="nav-copy"><span>{item.label}</span><small>{item.description}</small></span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-trust" data-liquid-glass data-glass-depth="28">
          <ShieldCheck size={22} />
          <div><strong>安全模式始终开启</strong><span>系统目录只读分析</span></div>
        </div>
        <div className="sidebar-version">净盘 v{snapshot?.version ?? '0.1.3'}</div>
      </aside>

      <main className="main-area">
        <header className="titlebar"><span>{navItems.find((item) => item.id === page)?.label}</span></header>
        {update?.status === 'available' && update.latestVersion !== dismissedUpdateVersion && (
          <UpdateBanner
            update={update}
            onDownload={() => void downloadUpdate()}
            onOpenPage={() => void openUpdatePage()}
            onDismiss={() => setDismissedUpdateVersion(update.latestVersion)}
          />
        )}
        <div className="page-container"><div key={page} className="page-stage">{content}</div></div>
      </main>

      {busy && progress && <ProgressOverlay progress={progress} onCancel={cancelBusy} />}
      {dialog && (
        <ConfirmDialog
          dialog={dialog}
          onCancel={() => setDialog(null)}
          onConfirm={
            dialog.type === 'cleanup'
              ? confirmCleanup
              : dialog.type === 'recycle'
                ? confirmRecycle
                : dialog.type === 'duplicate-recycle'
                  ? confirmDuplicateRecycle
                : dialog.type === 'chat-recycle'
                  ? confirmChatRecycle
                  : dialog.type === 'migration'
                    ? confirmMigration
                    : dialog.type === 'migration-undo'
                      ? confirmMigrationUndo
                      : confirmUninstall
          }
        />
      )}
      {toast && <Toast tone={toast.tone} text={toast.text} onClose={() => setToast(null)} />}
    </div>
  )
}

function UpdateBanner({
  update,
  onDownload,
  onOpenPage,
  onDismiss
}: {
  update: UpdateCheckResult
  onDownload: () => void
  onOpenPage: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="update-banner-shell">
      <section className="update-banner" role="status" aria-live="polite">
        <span className="update-banner-icon"><Download size={20} /></span>
        <span className="update-banner-copy">
          <strong>净盘 v{update.latestVersion} 已发布</strong>
          <small>
            {update.downloadAvailable
              ? `官方安装包 ${formatBytes(update.assetBytes)}，下载后运行即可升级。`
              : '新版安装包正在准备中，可先查看更新说明。'}
          </small>
        </span>
        <span className="update-banner-actions">
          <button className="update-notes-button" onClick={onOpenPage}><ExternalLink size={15} />更新说明</button>
          <button className="update-download-button" disabled={!update.downloadAvailable} onClick={onDownload}><Download size={15} />{update.downloadAvailable ? '下载更新' : '准备中'}</button>
        </span>
        <button className="update-dismiss-button" aria-label="暂时关闭更新提醒" title="暂时关闭" onClick={onDismiss}><X size={17} /></button>
      </section>
    </div>
  )
}

function LoadingScreen(): React.JSX.Element {
  return <div className="loading-screen"><LoaderCircle className="spin" size={30} /><span>正在读取 C 盘信息…</span></div>
}

function OverviewPage({
  snapshot,
  scan,
  analysis,
  busy,
  onScan,
  onNavigate
}: {
  snapshot: AppSnapshot
  scan: ScanResult | null
  analysis: AnalysisResult | null
  busy: BusyTask
  onScan: () => void
  onNavigate: (page: Page) => void
}): React.JSX.Element {
  const usedPercent = Math.min(100, (snapshot.disk.usedBytes / snapshot.disk.totalBytes) * 100)
  const lowSpace = snapshot.disk.freeBytes < 10 * 1024 ** 3 || usedPercent > 90
  return (
    <div className="page-stack">
      <section className="hero-card">
        <div>
          <div className={`status-pill ${lowSpace ? 'warning' : ''}`}>
            {lowSpace ? <TriangleAlert size={15} /> : <CheckCircle2 size={15} />}
            {lowSpace ? 'C 盘空间紧张' : 'C 盘状态良好'}
          </div>
          <h1>{lowSpace ? '该给 C 盘减减负了' : '你的 C 盘一目了然'}</h1>
          <p>净盘只清理明确安全的缓存和临时文件，重要目录始终保持只读。</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={onScan} disabled={Boolean(busy)}><Sparkles size={18} />{scan ? '重新扫描垃圾' : '扫描可清理内容'}</button>
            <button className="secondary-button" onClick={() => onNavigate('files')}><FileText size={18} />整理个人文件</button>
          </div>
        </div>
        <DiskRing percent={usedPercent} used={snapshot.disk.usedBytes} total={snapshot.disk.totalBytes} />
      </section>

      <section className="metric-grid">
        <MetricCard icon={HardDrive} color="blue" label="C 盘剩余" value={formatBytes(snapshot.disk.freeBytes)} note={`共 ${formatBytes(snapshot.disk.totalBytes)}`} />
        <MetricCard icon={Sparkles} color="green" label="可安全清理" value={scan ? formatBytes(scan.totalBytes) : '尚未扫描'} note={scan ? `${scan.totalFiles.toLocaleString('zh-CN')} 个文件` : '点击上方按钮开始'} />
        <MetricCard icon={FileText} color="purple" label="大文件" value={analysis ? `${analysis.largeFiles.length} 个` : '尚未分析'} note="仅展示，不自动删除" />
      </section>

      <section className="content-card">
        <div className="section-heading"><div><h2>推荐操作</h2><p>从风险最低、效果最明确的项目开始</p></div></div>
        <div className="action-list">
          <button onClick={() => onNavigate('cleanup')}><div className="action-icon green"><Sparkles /></div><div><strong>清理临时文件与缓存</strong><span>{scan ? `预计可释放 ${formatBytes(scan.totalBytes)}` : '扫描后给出准确结果'}</span></div><ChevronRight /></button>
          <button onClick={() => onNavigate('chat')}><div className="action-icon blue"><MessageCircle /></div><div><strong>整理微信与 QQ 聊天文件</strong><span>按账号和类型筛选，预览后再移入回收站</span></div><ChevronRight /></button>
          <button onClick={() => onNavigate('files')}><div className="action-icon purple"><FileText /></div><div><strong>整理图片、视频与文档</strong><span>逐项选择，删除后仍可从回收站恢复</span></div><ChevronRight /></button>
          <button onClick={() => onNavigate('duplicates')}><div className="action-icon blue"><CopyCheck /></div><div><strong>找出内容完全相同的副本</strong><span>完整 SHA-256 核对，至少保留一份再移入回收站</span></div><ChevronRight /></button>
          <button onClick={() => onNavigate('migration')}><div className="action-icon blue"><ArrowRightLeft /></div><div><strong>把个人文件安全迁移到 D 盘</strong><span>复制、校验并回滚失败项，不处理系统和应用数据</span></div><ChevronRight /></button>
          <button onClick={() => onNavigate('apps')}><div className="action-icon orange"><AppWindow /></div><div><strong>查找长期闲置的应用</strong><span>参考 Windows 使用记录，通过正式卸载程序移除</span></div><ChevronRight /></button>
          <button onClick={() => onNavigate('analysis')}><div className="action-icon blue"><BarChart3 /></div><div><strong>查看空间都去哪了</strong><span>分析 Windows、应用和用户文件占用</span></div><ChevronRight /></button>
        </div>
      </section>
    </div>
  )
}

function DiskRing({ percent, used, total }: { percent: number; used: number; total: number }): React.JSX.Element {
  return (
    <div className="disk-ring-wrap">
      <div
        className="disk-ring"
        data-liquid-glass
        data-glass-depth="48"
        data-glass-radius="68"
        style={{ '--disk-percent': `${percent * 3.6}deg` } as React.CSSProperties}
      >
        <div><strong>{Math.round(percent)}%</strong><span>已使用</span></div>
      </div>
      <p><strong>{formatBytes(used)}</strong> / {formatBytes(total)}</p>
    </div>
  )
}

function MetricCard({ icon: Icon, color, label, value, note }: { icon: typeof HardDrive; color: string; label: string; value: string; note: string }): React.JSX.Element {
  return <div className="metric-card"><div className={`metric-icon ${color}`}><Icon size={22} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></div>
}

function CleanupPage({
  scan,
  busy,
  selected,
  selectedBytes,
  cleanupResult,
  onScan,
  onToggle,
  onClean
}: {
  scan: ScanResult | null
  busy: BusyTask
  selected: Set<CategoryId>
  selectedBytes: number
  cleanupResult: CleanupResult | null
  onScan: () => void
  onToggle: (id: CategoryId) => void
  onClean: () => void
}): React.JSX.Element {
  return (
    <div className="page-stack">
      <PageIntro title="安全清理" description="所有项目都有固定白名单。占用中、无权限或不确定的文件会自动跳过。" action={<button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}><RefreshCw size={17} />{scan ? '重新扫描' : '开始扫描'}</button>} />
      {!scan ? (
        <EmptyState icon={Sparkles} title="先扫描，再做决定" description="扫描只读取文件大小，不会修改或上传任何内容。" button="扫描可清理内容" onClick={onScan} />
      ) : (
        <>
          <ScanFreshness scannedAt={scan.scannedAt} />
          {cleanupResult && <div className="result-banner"><CheckCircle2 /><div><strong>上次清理释放了 {formatBytes(cleanupResult.reclaimedBytes)}</strong><span>{cleanupResult.removedFiles.toLocaleString('zh-CN')} 个文件已移除，耗时 {formatDuration(cleanupResult.durationMs)}</span></div></div>}
          <div className="category-list">
            {scan.categories.map((category) => <CleanupCategory key={category.id} category={category} checked={selected.has(category.id)} onToggle={() => onToggle(category.id)} />)}
          </div>
          <div className="sticky-action">
            <div><span>已选择 {selected.size} 项</span><strong>预计释放 {formatBytes(selectedBytes)}</strong></div>
            <button className="primary-button" disabled={!scan.scanId || !selectedBytes || Boolean(busy)} onClick={onClean}><Trash2 size={18} />{scan.cancelled ? '请重新扫描' : '开始安全清理'}</button>
          </div>
        </>
      )}
    </div>
  )
}

function CleanupCategory({ category, checked, onToggle }: { category: ScannedCategory; checked: boolean; onToggle: () => void }): React.JSX.Element {
  const safetyText = category.safety === 'recommended' ? '推荐清理' : category.safety === 'safe' ? '可以清理' : '请确认'
  return (
    <button className={`category-row ${checked ? 'selected' : ''}`} onClick={onToggle} disabled={category.bytes === 0}>
      <span className={`checkbox ${checked ? 'checked' : ''}`}>{checked && <Check size={14} />}</span>
      <span className="category-main"><strong>{category.title}<em className={`safety-tag ${category.safety}`}>{safetyText}</em></strong><small>{category.description}</small><span>{category.detail}</span></span>
      <span className="category-size"><strong>{formatBytes(category.bytes)}</strong><small>{category.fileCount.toLocaleString('zh-CN')} 个文件</small></span>
    </button>
  )
}

function AnalysisPage({ analysis, busy, onAnalyze }: { analysis: AnalysisResult | null; busy: BusyTask; onAnalyze: () => void }): React.JSX.Element {
  const total = analysis?.groups.reduce((sum, group) => sum + group.bytes, 0) ?? 0
  return (
    <div className="page-stack">
      <PageIntro title="空间分析" description="帮你看清 C 盘空间分布。系统和应用目录只分析，绝不会在这里删除。" action={<button className="secondary-button" onClick={onAnalyze} disabled={Boolean(busy)}><BarChart3 size={17} />{analysis ? '重新分析' : '开始分析'}</button>} />
      {!analysis ? <EmptyState icon={BarChart3} title="看看空间都去哪了" description="完整分析可能需要几分钟，你可以随时停止。" button="分析 C 盘" onClick={onAnalyze} /> : (
        <>
          <ScanFreshness scannedAt={analysis.analyzedAt} />
          <section className="content-card">
            <div className="section-heading"><div><h2>空间分布</h2><p>分析于 {formatDate(analysis.analyzedAt)}，耗时 {formatDuration(analysis.durationMs)}</p></div><strong>{formatBytes(total)}</strong></div>
            <div className="space-bar">{analysis.groups.filter((group) => group.bytes > 0).map((group) => <span key={group.id} style={{ width: `${Math.max(1, (group.bytes / total) * 100)}%`, background: group.color }} />)}</div>
            <div className="space-groups">{analysis.groups.map((group) => <div key={group.id}><i style={{ background: group.color }} /><span><strong>{group.title}</strong><small>{group.description}</small></span><b>{formatBytes(group.bytes)}</b></div>)}</div>
          </section>
          {analysis.systemItems.length > 0 && (
            <section className="content-card">
              <div className="section-heading"><div><h2>系统保留空间说明</h2><p>这些项目能解释“其他与系统保留”的一部分占用，净盘不会直接删除或修改。</p></div><span className="read-only-badge"><ShieldCheck size={14} />只读识别</span></div>
              <div className="system-space-list">
                {analysis.systemItems.map((item) => (
                  <div key={item.id}>
                    <span className="setting-icon"><HardDrive /></span>
                    <span><strong>{item.title}</strong><small>{item.description}</small></span>
                    <b>{formatBytes(item.bytes)}</b>
                    {item.action === 'storage-recommendations'
                      ? <button className="link-button" onClick={() => void window.jingpan.openStorageRecommendations()}>交给 Windows 处理</button>
                      : <em className="neutral-badge">系统管理</em>}
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="content-card">
            <div className="section-heading"><div><h2>大文件</h2><p>显示超过 500 MB 的文件。请打开所在位置后自行确认用途。</p></div><span className="read-only-badge"><ShieldCheck size={14} />只读列表</span></div>
            {analysis.largeFiles.length === 0 ? <div className="minor-empty">没有找到超过 500 MB 的普通文件</div> : <div className="large-files">{analysis.largeFiles.slice(0, 20).map((file) => <div key={file.path}><div className="file-type-icon"><FileText size={18} /></div><span><strong title={file.path}>{file.name}</strong><small>{file.path}</small></span><b>{formatBytes(file.bytes)}</b><button title="打开所在文件夹" onClick={() => void window.jingpan.revealLargeFile(file.path)}><FolderOpen size={18} /></button></div>)}</div>}
          </section>
        </>
      )}
    </div>
  )
}

function FileViewToggle({
  value,
  onChange
}: {
  value: FileViewMode
  onChange: (value: FileViewMode) => void
}): React.JSX.Element {
  return (
    <div className="view-toggle" role="group" aria-label="切换文件预览方式">
      <button className={value === 'list' ? 'active' : ''} type="button" onClick={() => onChange('list')}><List size={16} />列表</button>
      <button className={value === 'grid' ? 'active' : ''} type="button" onClick={() => onChange('grid')}><LayoutGrid size={16} />方块</button>
    </div>
  )
}

function PaginationControl({
  page,
  pageCount,
  onPageChange
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(page))
  useEffect(() => setDraft(String(page)), [page])
  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      setDraft(String(page))
      return
    }
    const nextPage = Math.min(pageCount, Math.max(1, parsed))
    setDraft(String(nextPage))
    onPageChange(nextPage)
  }
  return (
    <div className="pagination">
      <span>第</span>
      <input
        aria-label="输入页码"
        inputMode="numeric"
        min={1}
        max={pageCount}
        value={draft}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      <span>/ {pageCount} 页</span>
      <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={17} /></button>
      <button disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}><ChevronRight size={17} /></button>
    </div>
  )
}

function FileRecycleAction({
  selectedCount,
  selectedBytes,
  currentPageCount,
  currentPageSelectedCount,
  hiddenSelectedCount = 0,
  detail,
  safetyText = '可从回收站恢复',
  disabled,
  onTogglePage,
  onClear,
  onRecycle,
  className = ''
}: {
  selectedCount: number
  selectedBytes: number
  currentPageCount?: number
  currentPageSelectedCount?: number
  hiddenSelectedCount?: number
  detail?: string
  safetyText?: string
  disabled: boolean
  onTogglePage?: () => void
  onClear: () => void
  onRecycle: () => void
  className?: string
}): React.JSX.Element {
  const allCurrentPageSelected = Boolean(currentPageCount && currentPageSelectedCount === currentPageCount)
  return (
    <div className={`file-recycle-action ${className}`}>
      <div className="selection-summary">
        <span>已选择 {selectedCount} 个文件</span>
        <strong>共 {formatBytes(selectedBytes)}</strong>
        {detail && <small>{detail}</small>}
        {hiddenSelectedCount > 0 && <small className="hidden-selection-note">另有 {hiddenSelectedCount} 项不在当前筛选中</small>}
      </div>
      <div className="selection-controls">
        {onTogglePage && currentPageCount !== undefined && currentPageCount > 0 && (
          <button type="button" onClick={onTogglePage}>{allCurrentPageSelected ? '取消本页' : '全选本页'}</button>
        )}
        <button type="button" disabled={selectedCount === 0} onClick={onClear}>清空选择</button>
      </div>
      <div className="recoverable-note"><ShieldCheck size={15} />{safetyText}</div>
      <button className="danger-button" disabled={disabled} onClick={onRecycle}><Trash2 size={18} />移入回收站</button>
    </div>
  )
}

function SortDirectionButton({ direction, onChange }: { direction: SortDirection; onChange: (value: SortDirection) => void }): React.JSX.Element {
  const descending = direction === 'desc'
  const Icon = descending ? ArrowDownNarrowWide : ArrowUpNarrowWide
  return (
    <button
      type="button"
      className="sort-direction-button"
      title={`当前为${descending ? '降序' : '升序'}，点击切换`}
      onClick={() => onChange(descending ? 'asc' : 'desc')}
    >
      <Icon size={15} />{descending ? '降序' : '升序'}
    </button>
  )
}

function ScanFreshness({ scannedAt }: { scannedAt: string }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const stale = isScanStale(scannedAt, now)
  return (
    <div className={`scan-freshness ${stale ? 'stale' : ''}`} title={new Date(scannedAt).toLocaleString('zh-CN')}>
      <Clock3 size={14} />
      <span>{formatScanAge(scannedAt, now)}</span>
      {stale && <strong>结果可能已变化，处理前建议重新扫描</strong>}
    </div>
  )
}

function RecycleResultBanner({
  report,
  onOpenRecycleBin,
  onGoCleanup,
  onDismiss
}: {
  report: RecycleReport
  onOpenRecycleBin: () => void
  onGoCleanup: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <section className={`recycle-result-banner ${report.failed > 0 ? 'has-errors' : ''}`}>
      <Recycle size={22} />
      <div className="recycle-result-copy">
        <strong>已移入回收站 {report.moved} 个文件，共 {formatBytes(report.movedBytes)}</strong>
        <span>文件仍占用原磁盘空间，清空回收站后才会真正释放。</span>
        {report.scope === 'chat' && report.otherBytes > 0 && (
          <small>C 盘 {formatBytes(report.systemBytes)}，其他磁盘 {formatBytes(report.otherBytes)}</small>
        )}
        {report.failed > 0 && (
          <details>
            <summary>{report.failed} 个文件未处理，查看原因</summary>
            <ul>{(report.errors.length > 0 ? report.errors : ['文件可能已变化、被占用或没有访问权限']).map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>
          </details>
        )}
      </div>
      <div className="recycle-result-actions">
        <button className="secondary-button" onClick={onOpenRecycleBin}><FolderOpen size={15} />打开回收站</button>
        <button className="secondary-button" onClick={onGoCleanup}><Sparkles size={15} />前往安全清理</button>
        <button className="icon-button" title="关闭提示" onClick={onDismiss}><X size={16} /></button>
      </div>
    </section>
  )
}

function MediaPreviewDialog({
  items,
  activeId,
  scope,
  selected,
  onSelect,
  onActiveChange,
  onClose,
  onOpenExternal,
  onReveal
}: {
  items: MediaPreviewItem[]
  activeId: string
  scope: FileThumbnailScope
  selected: Set<string>
  onSelect: (fileId: string) => void
  onActiveChange: (fileId: string) => void
  onClose: () => void
  onOpenExternal: (fileId: string) => void
  onReveal: (fileId: string) => void
}): React.JSX.Element | null {
  const index = items.findIndex((item) => item.id === activeId)
  const item = index >= 0 ? items[index] : null
  const [mediaError, setMediaError] = useState(false)
  useEffect(() => setMediaError(false), [activeId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && items.length > 1) {
        event.preventDefault()
        const previous = items[(index - 1 + items.length) % items.length]
        if (previous) onActiveChange(previous.id)
      }
      if (event.key === 'ArrowRight' && items.length > 1) {
        event.preventDefault()
        const next = items[(index + 1) % items.length]
        if (next) onActiveChange(next.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [index, items, onActiveChange, onClose])

  if (!item) return null
  const source = `jingpan-media://preview/${scope}/${encodeURIComponent(item.id)}`
  return createPortal(
    <div className="media-preview-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="media-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览 ${item.name}`}>
        <header>
          <div><strong title={item.name}>{item.name}</strong><span>{index + 1} / {items.length}</span></div>
          <button className="icon-button" title="关闭预览" onClick={onClose}><X size={19} /></button>
        </header>
        <div className="media-preview-stage">
          {mediaError ? (
            <div className="media-preview-error"><FileImage size={40} /><strong>此格式暂不能在应用内显示</strong><span>可以使用 Windows 默认应用打开原文件。</span></div>
          ) : item.kind === 'video' ? (
            <video key={source} controls preload="metadata" src={source} onError={() => setMediaError(true)} />
          ) : (
            <img key={source} src={source} alt={item.name} onError={() => setMediaError(true)} />
          )}
          {items.length > 1 && (
            <>
              <button
                className="preview-nav previous"
                title="上一项（左方向键）"
                onClick={() => { const previous = items[(index - 1 + items.length) % items.length]; if (previous) onActiveChange(previous.id) }}
              ><ChevronLeft size={24} /></button>
              <button
                className="preview-nav next"
                title="下一项（右方向键）"
                onClick={() => { const next = items[(index + 1) % items.length]; if (next) onActiveChange(next.id) }}
              ><ChevronRight size={24} /></button>
            </>
          )}
        </div>
        <footer>
          <div className="media-preview-details">
            <strong>{formatBytes(item.bytes)}</strong>
            <span>{formatDate(item.modifiedAt)}</span>
            <small title={item.path}>{item.path}</small>
          </div>
          <div className="media-preview-actions">
            <button className={`preview-select-button ${selected.has(item.id) ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>
              <span className={`checkbox ${selected.has(item.id) ? 'checked' : ''}`}>{selected.has(item.id) && <Check size={14} />}</span>
              {selected.has(item.id) ? '已选择' : '选择此文件'}
            </button>
            <button className="secondary-button" onClick={() => onReveal(item.id)}><FolderOpen size={16} />所在位置</button>
            <button className="secondary-button" onClick={() => onOpenExternal(item.id)}><ExternalLink size={16} />默认应用打开</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function ChatFilesPage({
  result,
  busy,
  selected,
  onScan,
  onChooseQqFolder,
  onSelectedChange,
  onOpen,
  onRecycle,
  recycleReport,
  onDismissReport,
  onOpenRecycleBin,
  onGoCleanup
}: {
  result: ChatFileScanResult | null
  busy: BusyTask
  selected: Set<string>
  onScan: () => void
  onChooseQqFolder: () => void
  onSelectedChange: (selected: Set<string>) => void
  onOpen: (fileId: string) => void
  onRecycle: (ids: string[], bytes: number) => void
  recycleReport: RecycleReport | null
  onDismissReport: () => void
  onOpenRecycleBin: () => void
  onGoCleanup: () => void
}): React.JSX.Element {
  const [platform, setPlatform] = useState<ChatPlatform | 'all'>('all')
  const [account, setAccount] = useState<string | 'all'>('all')
  const [kind, setKind] = useState<ChatFileKind | 'all'>('all')
  const [age, setAge] = useState<'all' | '30' | '90' | '180' | '365'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useStoredChoice<FileSortKey>('jingpan.chat.sort', ['size', 'date', 'name'], 'size')
  const [sortDirection, setSortDirection] = useStoredChoice<SortDirection>('jingpan.chat.sort-direction', ['asc', 'desc'], 'desc')
  const [viewMode, setViewMode] = useStoredChoice<FileViewMode>('jingpan.chat.view', ['list', 'grid'], 'list')
  const [page, setPage] = useState(1)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const pageSize = viewMode === 'grid' ? 48 : 50

  const platformFiles = useMemo(
    () => (result?.files ?? []).filter((file) => platform === 'all' || file.platform === platform),
    [result, platform]
  )
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN')
    const ageCutoff = age === 'all' ? 0 : Date.now() - Number(age) * 86_400_000
    return platformFiles
      .filter((file) => (
        (account === 'all' || file.accountId === account)
        && (kind === 'all' || file.kind === kind)
        && (!ageCutoff || new Date(file.modifiedAt).getTime() <= ageCutoff)
        && (!query || file.name.toLocaleLowerCase('zh-CN').includes(query) || file.path.toLocaleLowerCase('zh-CN').includes(query))
      ))
      .sort((left, right) => compareFiles(left, right, sort, sortDirection))
  }, [platformFiles, account, kind, age, search, sort, sortDirection])

  const availableAccounts = useMemo(
    () => (result?.accounts ?? []).filter((item) => platform === 'all' || item.platform === platform),
    [result, platform]
  )
  useEffect(() => {
    if (account !== 'all' && !availableAccounts.some((item) => item.id === account)) setAccount('all')
  }, [account, availableAccounts])
  useEffect(() => setPage(1), [platform, account, kind, age, search, sort, sortDirection, viewMode, result])
  useEffect(() => {
    setPlatform('all')
    setAccount('all')
    setKind('all')
    setAge('all')
    setSearch('')
    setPage(1)
    setPreviewId(null)
  }, [result?.scannedAt])

  const kindCounts = useMemo(() => {
    const map = new Map<ChatFileKind, number>()
    for (const file of platformFiles) map.set(file.kind, (map.get(file.kind) ?? 0) + 1)
    return map
  }, [platformFiles])
  const platformStats = useMemo(() => {
    const values = {
      all: { files: 0, bytes: 0, otherDriveFiles: 0, otherDriveBytes: 0 },
      wechat: { files: 0, bytes: 0, otherDriveFiles: 0, otherDriveBytes: 0 },
      qq: { files: 0, bytes: 0, otherDriveFiles: 0, otherDriveBytes: 0 }
    }
    for (const file of result?.files ?? []) {
      values.all.files += 1
      values.all.bytes += file.bytes
      values[file.platform].files += 1
      values[file.platform].bytes += file.bytes
      if (!file.onSystemDrive) {
        values.all.otherDriveFiles += 1
        values.all.otherDriveBytes += file.bytes
        values[file.platform].otherDriveFiles += 1
        values[file.platform].otherDriveBytes += file.bytes
      }
    }
    return values
  }, [result])
  const locationCounts = useMemo(() => ({
    all: result?.locations.length ?? 0,
    wechat: result?.locations.filter((location) => location.platform === 'wechat').length ?? 0,
    qq: result?.locations.filter((location) => location.platform === 'qq').length ?? 0
  }), [result])
  const qqLocations = result?.locations.filter((location) => location.platform === 'qq') ?? []
  const otherDriveLocations = result?.locations.filter((location) => !location.onSystemDrive) ?? []

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize)
  const selectedItems = (result?.files ?? []).filter((file) => selected.has(file.id))
  const selectedBytes = selectedItems.reduce((sum, file) => sum + file.bytes, 0)
  const systemSelectedBytes = selectedItems.filter((file) => file.onSystemDrive).reduce((sum, file) => sum + file.bytes, 0)
  const otherSelectedBytes = selectedBytes - systemSelectedBytes
  const filteredSelectedCount = filtered.filter((file) => selected.has(file.id)).length
  const hiddenSelectedCount = Math.max(0, selected.size - filteredSelectedCount)
  const currentPageSelectedCount = shown.filter((file) => selected.has(file.id)).length
  const allShownSelected = shown.length > 0 && shown.every((file) => selected.has(file.id))
  const previewItems = filtered.filter((file): file is ChatFileItem & { kind: 'image' | 'video' } => (
    file.previewable && (file.kind === 'image' || file.kind === 'video')
  ))
  useEffect(() => {
    if (previewId && !previewItems.some((file) => file.id === previewId)) setPreviewId(null)
  }, [previewId, previewItems])
  const openFile = (file: ChatFileItem): void => {
    if (file.previewable && (file.kind === 'image' || file.kind === 'video')) setPreviewId(file.id)
    else onOpen(file.id)
  }
  const toggleShown = (): void => {
    const next = new Set(selected)
    if (allShownSelected) shown.forEach((file) => next.delete(file.id))
    else {
      for (const file of shown) {
        if (next.size >= 2_000) break
        next.add(file.id)
      }
    }
    onSelectedChange(next)
  }
  const toggleFile = (fileId: string): void => {
    if (!selected.has(fileId) && selected.size >= 2_000) return
    onSelectedChange(toggleSet(selected, fileId))
  }

  return (
    <div className="page-stack">
      <PageIntro
        title="微信与 QQ 聊天文件"
        description="自动识别常见目录和 QQ/NTQQ 自定义数据位置；其他磁盘的文件会明确标注。不会读取聊天数据库。"
        action={(
          <div className="page-intro-actions">
            <button className="secondary-button" onClick={onChooseQqFolder} disabled={Boolean(busy)}><FolderSearch size={17} />选择 QQ 目录</button>
            <button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}><RefreshCw size={17} />{result ? '重新扫描' : '扫描聊天文件'}</button>
          </div>
        )}
      />
      <div className="info-banner chat-warning">
        <TriangleAlert size={19} />
        <span><strong>建议先退出微信和 QQ 再清理</strong>移除本地文件后，聊天记录中的对应图片、视频或附件可能无法继续打开；文件会先进入 Windows 回收站。</span>
      </div>
      {result && otherDriveLocations.length > 0 && (
        <div className="info-banner chat-location-banner">
          <HardDrive size={19} />
          <span>
            <strong>已识别其他磁盘上的聊天文件</strong>
            位于 {[...new Set(otherDriveLocations.map((location) => location.drive))].join('、')} 盘的文件可以在这里整理，但删除它们不会释放 C 盘空间。
          </span>
        </div>
      )}
      {result && qqLocations.length === 0 && (
        <div className="info-banner chat-location-banner unresolved">
          <CircleHelp size={19} />
          <span>
            <strong>尚未识别到 QQ 文件位置</strong>
            这不等于 QQ 没有文件。可选择 Tencent Files 文件夹，净盘会记住该位置并重新扫描。
          </span>
          <button className="secondary-button" onClick={onChooseQqFolder} disabled={Boolean(busy)}><FolderSearch size={16} />选择目录</button>
        </div>
      )}
      {recycleReport && <RecycleResultBanner report={recycleReport} onOpenRecycleBin={onOpenRecycleBin} onGoCleanup={onGoCleanup} onDismiss={onDismissReport} />}
      {!result ? (
        <EmptyState
          icon={MessageCircle}
          title="看看微信与 QQ 保存了多少本地文件"
          description="自动识别经典版与新版常见目录，并查找 QQ 自定义数据位置；不会读取消息正文、联系人或聊天数据库。"
          button="开始扫描"
          onClick={onScan}
        />
      ) : (
        <>
          {result.truncated && <div className="info-banner"><CircleHelp size={19} /><span><strong>文件数量较多</strong>共找到 {result.totalMatched.toLocaleString('zh-CN')} 项，当前展示占用最大的 {result.files.length.toLocaleString('zh-CN')} 项。</span></div>}
          <ScanFreshness scannedAt={result.scannedAt} />
          <div className="chat-platform-grid">
            {([
              ['all', '全部聊天文件', MessageCircle],
              ['wechat', '微信', MessageCircle],
              ['qq', 'QQ', MessageCircle]
            ] as const).map(([key, label, Icon]) => (
              <button key={key} className={platform === key ? 'active' : ''} onClick={() => setPlatform(key)}>
                <span><Icon size={18} /><strong>{label}</strong></span>
                <b>{formatBytes(platformStats[key].bytes)}</b>
                <small>
                  {platformStats[key].files > 0
                    ? `${platformStats[key].files.toLocaleString('zh-CN')} 个文件${platformStats[key].otherDriveFiles > 0 ? ` · 其他盘 ${formatBytes(platformStats[key].otherDriveBytes)}` : ''}`
                    : locationCounts[key] > 0
                      ? `已识别 ${locationCounts[key]} 个位置，暂无可管理文件`
                      : '未识别到文件位置'}
                </small>
              </button>
            ))}
          </div>
          {result.files.length === 0 ? (
            <section className="content-card chat-not-found">
              <MessageCircle size={36} />
              <h2>{result.locations.length > 0 ? '已识别聊天目录，暂无可管理文件' : '未识别到聊天文件位置'}</h2>
              <p>{result.locations.length > 0 ? '目录中可能暂时没有图片、视频、音频或接收文件，消息数据库不会显示在这里。' : '这不代表电脑里一定没有聊天文件。你可以重新扫描，或手动选择 QQ 的 Tencent Files 数据目录。'}</p>
              <div className="chat-empty-actions">
                <button className="secondary-button" onClick={onChooseQqFolder}><FolderSearch size={16} />选择 QQ 目录</button>
                <button className="secondary-button" onClick={onScan}><RefreshCw size={16} />重新扫描</button>
              </div>
            </section>
          ) : (
            <>
              <div className="file-kind-tabs">
                <button className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}><HardDrive size={17} />全部 <span>{platformFiles.length}</span></button>
                {(Object.keys(CHAT_FILE_KIND_META) as ChatFileKind[]).map((key) => {
                  const meta = CHAT_FILE_KIND_META[key]
                  const Icon = meta.icon
                  return <button key={key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}><Icon size={17} style={{ color: meta.color }} />{meta.label} <span>{kindCounts.get(key) ?? 0}</span></button>
                })}
              </div>
              <section className="content-card chat-file-browser">
                <div className="file-toolbar">
                  <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索聊天文件名或位置" /></label>
                  <select value={account} onChange={(event) => setAccount(event.target.value)}><option value="all">全部账号</option>{availableAccounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <select value={age} onChange={(event) => setAge(event.target.value as typeof age)}><option value="all">全部时间</option><option value="30">30 天未修改</option><option value="90">90 天未修改</option><option value="180">半年未修改</option><option value="365">一年未修改</option></select>
                  <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="size">按大小排序</option><option value="date">按修改日期排序</option><option value="name">按名称排序</option></select>
                  <SortDirectionButton direction={sortDirection} onChange={setSortDirection} />
                  <FileViewToggle value={viewMode} onChange={setViewMode} />
                  <span>共 {filtered.length.toLocaleString('zh-CN')} 项</span>
                </div>
                <FileRecycleAction
                  className="top-action"
                  selectedCount={selected.size}
                  selectedBytes={selectedBytes}
                  currentPageCount={shown.length}
                  currentPageSelectedCount={currentPageSelectedCount}
                  hiddenSelectedCount={hiddenSelectedCount}
                  detail={`C 盘 ${formatBytes(systemSelectedBytes)}${otherSelectedBytes > 0 ? `，其他磁盘 ${formatBytes(otherSelectedBytes)}` : ''}`}
                  safetyText="清空回收站后释放空间"
                  disabled={selected.size === 0}
                  onTogglePage={toggleShown}
                  onClear={() => onSelectedChange(new Set())}
                  onRecycle={() => onRecycle([...selected], selectedBytes)}
                />
                {viewMode === 'list' ? (
                  <>
                    <div className="chat-file-table-head"><button className={`checkbox ${allShownSelected ? 'checked' : ''}`} title={allShownSelected ? '取消选择本页' : '全选本页'} aria-label={allShownSelected ? '取消选择本页' : '全选本页'} onClick={toggleShown}>{allShownSelected && <Check size={14} />}</button><span>文件（图片和视频在应用内预览）</span><span>来源</span><span>修改日期</span><span>大小</span><span /></div>
                    <div className="chat-file-table">
                      {shown.length === 0 ? <div className="minor-empty">没有符合条件的聊天文件</div> : shown.map((file) => (
                        <ChatFileRow
                          key={file.id}
                          file={file}
                          checked={selected.has(file.id)}
                          onOpen={() => openFile(file)}
                          onToggle={() => toggleFile(file.id)}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="file-grid">
                    {shown.length === 0 ? <div className="minor-empty">没有符合条件的聊天文件</div> : shown.map((file) => (
                      <ChatFileCard
                        key={file.id}
                        file={file}
                        checked={selected.has(file.id)}
                        onOpen={() => openFile(file)}
                        onToggle={() => toggleFile(file.id)}
                      />
                    ))}
                  </div>
                )}
                <PaginationControl page={page} pageCount={pageCount} onPageChange={setPage} />
              </section>
            </>
          )}
        </>
      )}
      {previewId && (
        <MediaPreviewDialog
          items={previewItems}
          activeId={previewId}
          scope="chat"
          selected={selected}
          onSelect={toggleFile}
          onActiveChange={setPreviewId}
          onClose={() => setPreviewId(null)}
          onOpenExternal={onOpen}
          onReveal={(fileId) => { void window.jingpan.revealChatFile(fileId) }}
        />
      )}
    </div>
  )
}

function ChatFileRow({
  file,
  checked,
  onOpen,
  onToggle
}: {
  file: ChatFileItem
  checked: boolean
  onOpen: () => void
  onToggle: () => void
}): React.JSX.Element {
  const meta = CHAT_FILE_KIND_META[file.kind]
  const Icon = meta.icon
  const sourceLabel = `${file.platform === 'wechat' ? '微信' : 'QQ'} · ${CHAT_AREA_LABELS[file.area]}${file.onSystemDrive ? '' : ` · ${file.drive}盘`}`
  return (
    <div
      className={`chat-file-row ${checked ? 'selected' : ''} ${file.previewable ? 'openable' : 'protected-file'}`}
      role="button"
      tabIndex={0}
      title={file.previewable ? `打开或预览 ${file.name}` : '此文件不支持安全预览，可使用右侧按钮查看所在位置'}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <button className={`checkbox ${checked ? 'checked' : ''}`} aria-label={`选择 ${file.name}`} onClick={(event) => { event.stopPropagation(); onToggle() }}>{checked && <Check size={14} />}</button>
      <div className="file-name"><FileThumbnail scope="chat" fileId={file.id} kind={file.kind} color={meta.color} icon={Icon} /><div><strong title={file.name}>{file.name}</strong><small title={file.path}>{file.path}</small></div></div>
      <span className={`chat-source-badge ${file.platform}`} title={`${file.accountLabel} · ${file.drive}盘`}>{sourceLabel}</span>
      <span>{formatDate(file.modifiedAt)}</span>
      <b>{formatBytes(file.bytes)}</b>
      <button className="icon-button" aria-label={`打开 ${file.name} 所在文件夹`} title="打开所在文件夹" onClick={(event) => { event.stopPropagation(); void window.jingpan.revealChatFile(file.id) }}><FolderOpen size={17} /></button>
    </div>
  )
}

function ChatFileCard({
  file,
  checked,
  onOpen,
  onToggle
}: {
  file: ChatFileItem
  checked: boolean
  onOpen: () => void
  onToggle: () => void
}): React.JSX.Element {
  const meta = CHAT_FILE_KIND_META[file.kind]
  const Icon = meta.icon
  const sourceLabel = `${file.platform === 'wechat' ? '微信' : 'QQ'} · ${CHAT_AREA_LABELS[file.area]}${file.onSystemDrive ? '' : ` · ${file.drive}盘`}`
  return (
    <div
      className={`file-card chat-file-card ${checked ? 'selected' : ''} ${file.previewable ? 'openable' : 'protected-file'}`}
      role="button"
      tabIndex={0}
      title={file.previewable ? `打开或预览 ${file.name}` : '此文件不支持安全预览，可使用右侧按钮查看所在位置'}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <button className={`checkbox ${checked ? 'checked' : ''}`} aria-label={`选择 ${file.name}`} onClick={(event) => { event.stopPropagation(); onToggle() }}>{checked && <Check size={14} />}</button>
      <FileThumbnail scope="chat" fileId={file.id} kind={file.kind} color={meta.color} icon={Icon} />
      <div className="file-card-body">
        <strong title={file.name}>{file.name}</strong>
        <small title={file.path}>{file.path}</small>
      </div>
      <div className="file-card-meta">
        <span className={`chat-source-badge ${file.platform}`} title={`${file.accountLabel} · ${file.drive}盘`}>{sourceLabel}</span>
        <b>{formatBytes(file.bytes)}</b>
      </div>
      <div className="file-card-foot">
        <span>{formatDate(file.modifiedAt)}</span>
        <button className="icon-button" aria-label={`打开 ${file.name} 所在文件夹`} title="打开所在文件夹" onClick={(event) => { event.stopPropagation(); void window.jingpan.revealChatFile(file.id) }}><FolderOpen size={17} /></button>
      </div>
    </div>
  )
}

function DuplicateFilesPage({
  result,
  busy,
  selected,
  onScan,
  onSelectedChange,
  onOpen,
  onRecycle,
  recycleReport,
  onDismissReport,
  onOpenRecycleBin,
  onGoCleanup
}: {
  result: DuplicateFileScanResult | null
  busy: BusyTask
  selected: Set<string>
  onScan: () => void
  onSelectedChange: (selected: Set<string>) => void
  onOpen: (fileId: string) => void
  onRecycle: (ids: string[], bytes: number) => void
  recycleReport: RecycleReport | null
  onDismissReport: () => void
  onOpenRecycleBin: () => void
  onGoCleanup: () => void
}): React.JSX.Element {
  const files = useMemo(() => result?.groups.flatMap((group) => group.files) ?? [], [result])
  const selectedBytes = files.filter((file) => selected.has(file.id)).reduce((sum, file) => sum + file.bytes, 0)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewItems = files.filter((file): file is UserFileItem & { kind: 'image' | 'video' } => file.kind === 'image' || file.kind === 'video')
  useEffect(() => {
    if (previewId && !previewItems.some((file) => file.id === previewId)) setPreviewId(null)
  }, [previewId, previewItems])
  const openFile = (file: UserFileItem): void => {
    if (file.kind === 'image' || file.kind === 'video') setPreviewId(file.id)
    else onOpen(file.id)
  }

  const smartSelect = (): void => {
    const next = new Set<string>()
    for (const group of result?.groups ?? []) {
      for (const file of group.files.slice(1)) {
        if (next.size >= 2_000) break
        next.add(file.id)
      }
      if (next.size >= 2_000) break
    }
    onSelectedChange(next)
  }

  const toggleFile = (groupId: string, fileId: string): void => {
    const next = new Set(selected)
    if (next.has(fileId)) {
      next.delete(fileId)
    } else {
      const group = result?.groups.find((item) => item.id === groupId)
      const selectedInGroup = group?.files.filter((file) => next.has(file.id)).length ?? 0
      if (!group || selectedInGroup >= group.files.length - 1 || next.size >= 2_000) return
      next.add(fileId)
    }
    onSelectedChange(next)
  }

  return (
    <div className="page-stack">
      <PageIntro
        title="重复文件"
        description="仅将大小相同且完整 SHA-256 一致的文件判定为重复；每组至少保留一份。"
        action={<button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}><RefreshCw size={17} />{result ? '重新核对' : '扫描重复文件'}</button>}
      />
      <div className="info-banner duplicate-safety-banner">
        <ShieldCheck size={19} />
        <span><strong>内容核对，不凭文件名猜测</strong>只扫描 C 盘个人目录中 1 MB 以上的图片、视频、音频、文档、压缩包和安装包；OneDrive 等云目录不会读取内容，避免触发下载。</span>
      </div>
      {recycleReport && <RecycleResultBanner report={recycleReport} onOpenRecycleBin={onOpenRecycleBin} onGoCleanup={onGoCleanup} onDismiss={onDismissReport} />}
      {result && <ScanFreshness scannedAt={result.scannedAt} />}
      {!result ? (
        <EmptyState icon={CopyCheck} title="找出真正相同的文件副本" description="扫描会读取本地文件内容并计算 SHA-256，不上传文件。耗时取决于需要核对的文件大小。" button="开始核对" onClick={onScan} />
      ) : result.groups.length === 0 ? (
        <section className="content-card duplicate-empty">
          <CheckCircle2 size={38} />
          <h2>没有发现完全相同的个人文件</h2>
          <p>已核对 {result.hashedFiles.toLocaleString('zh-CN')} 个同尺寸候选文件。1 MB 以下和云端文件未读取内容。</p>
          <button className="secondary-button" onClick={onScan}><RefreshCw size={16} />重新核对</button>
        </section>
      ) : (
        <>
          {result.truncated && <div className="info-banner"><CircleHelp size={19} /><span><strong>结果较多</strong>本次展示释放空间最大的 {result.groups.length.toLocaleString('zh-CN')} 组；可处理后再次扫描。</span></div>}
          <div className="duplicate-summary-grid">
            <div><strong>{result.groups.length.toLocaleString('zh-CN')}</strong><span>组完全相同</span></div>
            <div><strong>{result.duplicateFiles.toLocaleString('zh-CN')}</strong><span>个重复文件</span></div>
            <div><strong>{formatBytes(result.reclaimableBytes)}</strong><span>最多可回收</span></div>
            <button onClick={smartSelect}><CopyCheck size={18} /><span><strong>智能选择副本</strong><small>每组保留最近修改的一份</small></span></button>
          </div>
          <FileRecycleAction
            className="top-action duplicate-top-action"
            selectedCount={selected.size}
            selectedBytes={selectedBytes}
            safetyText="每组至少保留一份，清空回收站后释放空间"
            disabled={selected.size === 0}
            onClear={() => onSelectedChange(new Set())}
            onRecycle={() => onRecycle([...selected], selectedBytes)}
          />
          <div className="duplicate-groups">
            {result.groups.map((group, groupIndex) => {
              const selectedInGroup = group.files.filter((file) => selected.has(file.id)).length
              return (
                <section className="content-card duplicate-group" key={group.id}>
                  <div className="duplicate-group-heading">
                    <span><strong>重复组 {groupIndex + 1}</strong><small>{group.files.length} 份 · 每份 {formatBytes(group.bytesPerFile)} · 默认将最近修改的一份排在最前</small></span>
                    <span><em className="enabled-badge">SHA-256 完全一致</em><b>可回收 {formatBytes(group.reclaimableBytes)}</b></span>
                  </div>
                  <div className="duplicate-file-list">
                    {group.files.map((file) => (
                      <UserFileRow
                        key={file.id}
                        file={file}
                        checked={selected.has(file.id)}
                        selectionDisabled={!selected.has(file.id) && (selectedInGroup >= group.files.length - 1 || selected.size >= 2_000)}
                        onOpen={() => openFile(file)}
                        onToggle={() => toggleFile(group.id, file.id)}
                        onReveal={() => void window.jingpan.revealDuplicateFile(file.id)}
                        thumbnailScope="duplicate"
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </>
      )}
      {previewId && (
        <MediaPreviewDialog
          items={previewItems}
          activeId={previewId}
          scope="duplicate"
          selected={selected}
          onSelect={(fileId) => {
            const group = result?.groups.find((candidate) => candidate.files.some((file) => file.id === fileId))
            if (group) toggleFile(group.id, fileId)
          }}
          onActiveChange={setPreviewId}
          onClose={() => setPreviewId(null)}
          onOpenExternal={onOpen}
          onReveal={(fileId) => { void window.jingpan.revealDuplicateFile(fileId) }}
        />
      )}
    </div>
  )
}

function PersonalFilesPage({
  result,
  busy,
  selected,
  onScan,
  onSelectedChange,
  onOpen,
  onRecycle,
  recycleReport,
  onDismissReport,
  onOpenRecycleBin,
  onGoCleanup
}: {
  result: UserFileScanResult | null
  busy: BusyTask
  selected: Set<string>
  onScan: () => void
  onSelectedChange: (selected: Set<string>) => void
  onOpen: (fileId: string) => void
  onRecycle: (ids: string[], bytes: number) => void
  recycleReport: RecycleReport | null
  onDismissReport: () => void
  onOpenRecycleBin: () => void
  onGoCleanup: () => void
}): React.JSX.Element {
  const [kind, setKind] = useState<UserFileKind | 'all'>('all')
  const [location, setLocation] = useState<UserFileLocation | 'all'>('all')
  const [age, setAge] = useState<'all' | '90' | '180' | '365'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useStoredChoice<FileSortKey>('jingpan.files.sort', ['size', 'date', 'name'], 'size')
  const [sortDirection, setSortDirection] = useStoredChoice<SortDirection>('jingpan.files.sort-direction', ['asc', 'desc'], 'desc')
  const [viewMode, setViewMode] = useStoredChoice<FileViewMode>('jingpan.files.view', ['list', 'grid'], 'list')
  const [page, setPage] = useState(1)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const pageSize = viewMode === 'grid' ? 48 : 50

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN')
    const ageCutoff = age === 'all' ? 0 : Date.now() - Number(age) * 86_400_000
    const items = (result?.files ?? []).filter((file) => (
      (kind === 'all' || file.kind === kind)
      && (location === 'all' || file.location === location)
      && (!ageCutoff || new Date(file.modifiedAt).getTime() <= ageCutoff)
      && (!query || file.name.toLocaleLowerCase('zh-CN').includes(query) || file.path.toLocaleLowerCase('zh-CN').includes(query))
    ))
    return items.sort((a, b) => compareFiles(a, b, sort, sortDirection))
  }, [result, kind, location, age, search, sort, sortDirection])

  useEffect(() => setPage(1), [kind, location, age, search, sort, sortDirection, viewMode, result])
  useEffect(() => {
    setKind('all')
    setLocation('all')
    setAge('all')
    setSearch('')
    setPage(1)
    setPreviewId(null)
  }, [result?.scannedAt])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize)
  const selectedItems = (result?.files ?? []).filter((file) => selected.has(file.id))
  const selectedBytes = selectedItems.reduce((sum, file) => sum + file.bytes, 0)
  const filteredSelectedCount = filtered.filter((file) => selected.has(file.id)).length
  const hiddenSelectedCount = Math.max(0, selected.size - filteredSelectedCount)
  const currentPageSelectedCount = shown.filter((file) => selected.has(file.id)).length
  const allShownSelected = shown.length > 0 && shown.every((file) => selected.has(file.id))
  const previewItems = filtered.filter((file): file is UserFileItem & { kind: 'image' | 'video' } => file.kind === 'image' || file.kind === 'video')
  useEffect(() => {
    if (previewId && !previewItems.some((file) => file.id === previewId)) setPreviewId(null)
  }, [previewId, previewItems])
  const openFile = (file: UserFileItem): void => {
    if (file.kind === 'image' || file.kind === 'video') setPreviewId(file.id)
    else onOpen(file.id)
  }

  const counts = useMemo(() => {
    const map = new Map<UserFileKind, number>()
    for (const file of result?.files ?? []) map.set(file.kind, (map.get(file.kind) ?? 0) + 1)
    return map
  }, [result])

  const toggleShown = (): void => {
    const next = new Set(selected)
    if (allShownSelected) shown.forEach((file) => next.delete(file.id))
    else {
      for (const file of shown) {
        if (next.size >= 2_000) break
        next.add(file.id)
      }
    }
    onSelectedChange(next)
  }
  const toggleFile = (fileId: string): void => {
    if (!selected.has(fileId) && selected.size >= 2_000) return
    onSelectedChange(toggleSet(selected, fileId))
  }

  return (
    <div className="page-stack">
      <PageIntro title="个人文件" description="整理位于 C 盘的图片、视频、音频、文本和办公文档。点击文件行可直接打开预览，只有勾选的文件才会移入回收站。" action={<button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}><RefreshCw size={17} />{result ? '重新整理' : '扫描个人文件'}</button>} />
      {recycleReport && <RecycleResultBanner report={recycleReport} onOpenRecycleBin={onOpenRecycleBin} onGoCleanup={onGoCleanup} onDismiss={onDismissReport} />}
      {!result ? <EmptyState icon={FileText} title="整理 C 盘个人文件，找回更多空间" description="读取 Windows 真实的桌面、下载、文档、图片、视频和音乐位置，并包含 C 盘 OneDrive；不读取文件内容。" button="开始整理" onClick={onScan} /> : (
        <>
          {result.truncated && <div className="info-banner"><CircleHelp size={19} /><span><strong>文件数量较多</strong>共找到 {result.totalMatched.toLocaleString('zh-CN')} 项，当前展示占用最大的 {result.files.length.toLocaleString('zh-CN')} 项。</span></div>}
          <ScanFreshness scannedAt={result.scannedAt} />
          <div className="file-kind-tabs">
            <button className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}><HardDrive size={17} />全部 <span>{result.files.length}</span></button>
            {(Object.keys(FILE_KIND_META) as UserFileKind[]).map((key) => {
              const meta = FILE_KIND_META[key]
              const Icon = meta.icon
              return <button key={key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}><Icon size={17} style={{ color: meta.color }} />{meta.label} <span>{counts.get(key) ?? 0}</span></button>
            })}
          </div>
          <section className="content-card file-browser">
            <div className="file-toolbar">
              <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名或位置" /></label>
              <select value={location} onChange={(event) => setLocation(event.target.value as typeof location)}><option value="all">全部位置</option><option value="downloads">下载目录</option><option value="desktop">桌面</option><option value="documents">文档</option><option value="pictures">图片</option><option value="videos">视频</option><option value="music">音乐</option><option value="onedrive">OneDrive</option></select>
              <select value={age} onChange={(event) => setAge(event.target.value as typeof age)}><option value="all">全部时间</option><option value="90">90 天未修改</option><option value="180">半年未修改</option><option value="365">一年未修改</option></select>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="size">按大小排序</option><option value="date">按修改日期排序</option><option value="name">按名称排序</option></select>
              <SortDirectionButton direction={sortDirection} onChange={setSortDirection} />
              <FileViewToggle value={viewMode} onChange={setViewMode} />
              <span>共 {filtered.length.toLocaleString('zh-CN')} 项</span>
            </div>
            <FileRecycleAction
              className="top-action"
              selectedCount={selected.size}
              selectedBytes={selectedBytes}
              currentPageCount={shown.length}
              currentPageSelectedCount={currentPageSelectedCount}
              hiddenSelectedCount={hiddenSelectedCount}
              safetyText="清空回收站后释放空间"
              disabled={selected.size === 0}
              onTogglePage={toggleShown}
              onClear={() => onSelectedChange(new Set())}
              onRecycle={() => onRecycle([...selected], selectedBytes)}
            />
            {viewMode === 'list' ? (
              <>
                <div className="file-table-head"><button className={`checkbox ${allShownSelected ? 'checked' : ''}`} title={allShownSelected ? '取消选择本页' : '全选本页'} aria-label={allShownSelected ? '取消选择本页' : '全选本页'} onClick={toggleShown}>{allShownSelected && <Check size={14} />}</button><span>文件（图片和视频在应用内预览）</span><span>修改日期</span><span>大小</span><span /></div>
                <div className="file-table">
                  {shown.length === 0 ? <div className="minor-empty">没有符合条件的文件</div> : shown.map((file) => <UserFileRow key={file.id} file={file} checked={selected.has(file.id)} onOpen={() => openFile(file)} onToggle={() => toggleFile(file.id)} />)}
                </div>
              </>
            ) : (
              <div className="file-grid">
                {shown.length === 0 ? <div className="minor-empty">没有符合条件的文件</div> : shown.map((file) => <UserFileCard key={file.id} file={file} checked={selected.has(file.id)} onOpen={() => openFile(file)} onToggle={() => toggleFile(file.id)} />)}
              </div>
            )}
            <PaginationControl page={page} pageCount={pageCount} onPageChange={setPage} />
          </section>
        </>
      )}
      {previewId && (
        <MediaPreviewDialog
          items={previewItems}
          activeId={previewId}
          scope="user"
          selected={selected}
          onSelect={toggleFile}
          onActiveChange={setPreviewId}
          onClose={() => setPreviewId(null)}
          onOpenExternal={onOpen}
          onReveal={(fileId) => { void window.jingpan.revealUserFile(fileId) }}
        />
      )}
    </div>
  )
}

const videoFrameCache = new Map<string, string | null>()
const videoFrameWaiters: Array<() => void> = []
let activeVideoFrameTasks = 0

async function withVideoFrameSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeVideoFrameTasks >= 2) {
    await new Promise<void>((resolve) => videoFrameWaiters.push(resolve))
  }
  activeVideoFrameTasks += 1
  try {
    return await work()
  } finally {
    activeVideoFrameTasks -= 1
    videoFrameWaiters.shift()?.()
  }
}

function rememberVideoFrame(key: string, value: string | null): void {
  if (videoFrameCache.has(key)) videoFrameCache.delete(key)
  videoFrameCache.set(key, value)
  while (videoFrameCache.size > 160) {
    const oldestKey = videoFrameCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    videoFrameCache.delete(oldestKey)
  }
}

async function captureVideoFrame(scope: FileThumbnailScope, fileId: string): Promise<string | null> {
  const key = `${scope}:${fileId}`
  if (videoFrameCache.has(key)) return videoFrameCache.get(key) ?? null
  return withVideoFrameSlot(async () => {
    if (videoFrameCache.has(key)) return videoFrameCache.get(key) ?? null
    const result = await new Promise<string | null>((resolve) => {
      const video = document.createElement('video')
      const cleanup = (): void => {
        window.clearTimeout(timeout)
        video.pause()
        video.removeAttribute('src')
        video.load()
        video.remove()
      }
      const finish = (value: string | null): void => {
        cleanup()
        resolve(value)
      }
      const timeout = window.setTimeout(() => finish(null), 12_000)
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.preload = 'auto'
      video.playsInline = true
      video.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none'
      video.onloadeddata = () => {
        if (!video.videoWidth || !video.videoHeight) {
          finish(null)
          return
        }
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 112
          canvas.height = 112
          const context = canvas.getContext('2d')
          if (!context) {
            finish(null)
            return
          }
          const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
          const width = video.videoWidth * scale
          const height = video.videoHeight * scale
          context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
          finish(canvas.toDataURL('image/jpeg', 0.82))
        } catch {
          finish(null)
        }
      }
      video.onerror = () => finish(null)
      document.body.appendChild(video)
      video.src = `jingpan-media://thumbnail/${scope}/${encodeURIComponent(fileId)}`
      video.load()
    })
    rememberVideoFrame(key, result)
    return result
  })
}

function FileThumbnail({
  scope,
  fileId,
  kind,
  color,
  icon: Icon
}: {
  scope: FileThumbnailScope
  fileId: string
  kind: UserFileKind | ChatFileKind
  color: string
  icon: typeof FileImage
}): React.JSX.Element {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [source, setSource] = useState<string | null>(null)
  const previewKind = kind === 'image' || kind === 'video'

  useEffect(() => {
    setSource(null)
    if (!previewKind) return
    let disposed = false
    let requested = false
    const requestThumbnail = (): void => {
      if (requested) return
      requested = true
      void window.jingpan.getFileThumbnail(scope, fileId)
        .catch(() => null)
        .then(async (thumbnail) => thumbnail ?? (kind === 'video' ? captureVideoFrame(scope, fileId) : null))
        .then((thumbnail) => {
          if (!disposed && thumbnail) setSource(thumbnail)
        })
        .catch(() => {
          // The fallback icon remains visible if Windows and Chromium cannot decode it.
        })
    }
    const host = hostRef.current
    if (!host || typeof IntersectionObserver === 'undefined') {
      requestThumbnail()
      return () => {
        disposed = true
      }
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      requestThumbnail()
    }, { rootMargin: '180px 0px' })
    observer.observe(host)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [fileId, kind, previewKind, scope])

  return (
    <span
      ref={hostRef}
      className={`file-thumbnail ${source ? 'has-preview' : ''}`}
      data-kind={kind}
      data-file-id={fileId}
      data-thumbnail-scope={scope}
      style={{ color }}
      aria-hidden="true"
    >
      <Icon className="file-thumbnail-fallback" size={19} />
      {source && <img src={source} alt="" draggable={false} />}
    </span>
  )
}

function UserFileRow({
  file,
  checked,
  selectionDisabled = false,
  onOpen,
  onToggle,
  onReveal,
  thumbnailScope = 'user'
}: {
  file: UserFileItem
  checked: boolean
  selectionDisabled?: boolean
  onOpen: () => void
  onToggle: () => void
  onReveal?: () => void
  thumbnailScope?: FileThumbnailScope
}): React.JSX.Element {
  const meta = FILE_KIND_META[file.kind]
  const Icon = meta.icon
  const directOpenAllowed = file.kind !== 'installer'
  return (
    <div
      className={`file-row ${checked ? 'selected' : ''} ${directOpenAllowed ? 'openable' : 'protected-file'}`}
      role="button"
      tabIndex={0}
      title={directOpenAllowed ? `打开或预览 ${file.name}` : '安装包为避免误运行，不支持直接打开'}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <button className={`checkbox ${checked ? 'checked' : ''}`} disabled={selectionDisabled} aria-label={`选择 ${file.name}`} title={selectionDisabled ? '每组至少保留一份，或已达到单次处理上限' : undefined} onClick={(event) => { event.stopPropagation(); onToggle() }}>{checked && <Check size={14} />}</button>
      <div className="file-name"><FileThumbnail scope={thumbnailScope} fileId={file.id} kind={file.kind} color={meta.color} icon={Icon} /><div><strong title={file.name}>{file.name}</strong><small title={file.path}>{file.path}</small></div></div>
      <span>{formatDate(file.modifiedAt)}</span><b>{formatBytes(file.bytes)}</b>
      <button className="icon-button" aria-label={`打开 ${file.name} 所在文件夹`} title="打开所在文件夹" onClick={(event) => { event.stopPropagation(); if (onReveal) onReveal(); else void window.jingpan.revealUserFile(file.id) }}><FolderOpen size={17} /></button>
    </div>
  )
}

function UserFileCard({
  file,
  checked,
  selectionDisabled = false,
  onOpen,
  onToggle,
  onReveal,
  thumbnailScope = 'user'
}: {
  file: UserFileItem
  checked: boolean
  selectionDisabled?: boolean
  onOpen: () => void
  onToggle: () => void
  onReveal?: () => void
  thumbnailScope?: FileThumbnailScope
}): React.JSX.Element {
  const meta = FILE_KIND_META[file.kind]
  const Icon = meta.icon
  const directOpenAllowed = file.kind !== 'installer'
  return (
    <div
      className={`file-card ${checked ? 'selected' : ''} ${directOpenAllowed ? 'openable' : 'protected-file'}`}
      role="button"
      tabIndex={0}
      title={directOpenAllowed ? `打开或预览 ${file.name}` : '安装包为避免误运行，不支持直接打开'}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <button className={`checkbox ${checked ? 'checked' : ''}`} disabled={selectionDisabled} aria-label={`选择 ${file.name}`} title={selectionDisabled ? '每组至少保留一份，或已达到单次处理上限' : undefined} onClick={(event) => { event.stopPropagation(); onToggle() }}>{checked && <Check size={14} />}</button>
      <FileThumbnail scope={thumbnailScope} fileId={file.id} kind={file.kind} color={meta.color} icon={Icon} />
      <div className="file-card-body">
        <strong title={file.name}>{file.name}</strong>
        <small title={file.path}>{file.path}</small>
      </div>
      <div className="file-card-meta">
        <span>{formatDate(file.modifiedAt)}</span>
        <b>{formatBytes(file.bytes)}</b>
      </div>
      <div className="file-card-foot">
        <span>{meta.label}</span>
        <button className="icon-button" aria-label={`打开 ${file.name} 所在文件夹`} title="打开所在文件夹" onClick={(event) => { event.stopPropagation(); if (onReveal) onReveal(); else void window.jingpan.revealUserFile(file.id) }}><FolderOpen size={17} /></button>
      </div>
    </div>
  )
}

function MigrationPage({
  result,
  lastResult,
  busy,
  selected,
  onScan,
  onSelectedChange,
  onMigrate,
  onUndo
}: {
  result: MigrationScanResult | null
  lastResult: MigrationResult | null
  busy: BusyTask
  selected: Set<string>
  onScan: () => void
  onSelectedChange: (selected: Set<string>) => void
  onMigrate: (ids: string[], bytes: number) => void
  onUndo: (batchId: string, files: number, bytes: number) => void
}): React.JSX.Element {
  const [confidence, setConfidence] = useState<'all' | 'recommended' | 'review'>('recommended')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 50
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN')
    return (result?.files ?? []).filter((file) => (
      (confidence === 'all' || file.confidence === confidence)
      && (!query
        || file.name.toLocaleLowerCase('zh-CN').includes(query)
        || file.path.toLocaleLowerCase('zh-CN').includes(query))
    ))
  }, [result, confidence, search])

  useEffect(() => setPage(1), [result, confidence, search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize)
  const selectedFiles = (result?.files ?? []).filter((file) => selected.has(file.id))
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.bytes, 0)
  const allShownSelected = shown.length > 0 && shown.every((file) => selected.has(file.id))
  const toggleShown = (): void => {
    const next = new Set(selected)
    if (allShownSelected) {
      shown.forEach((file) => next.delete(file.id))
    } else {
      for (const file of shown) {
        if (next.size >= 2_000) break
        next.add(file.id)
      }
    }
    onSelectedChange(next)
  }
  const toggleFile = (fileId: string): void => {
    if (!selected.has(fileId) && selected.size >= 2_000) return
    onSelectedChange(toggleSet(selected, fileId))
  }
  const recommendedCount = result?.files.filter((file) => file.confidence === 'recommended').length ?? 0
  const reviewCount = result?.files.filter((file) => file.confidence === 'review').length ?? 0

  return (
    <div className="page-stack">
      <PageIntro
        title="智能迁移到 D 盘"
        description="只识别 C 盘个人目录中的独立文件。复制并通过 SHA-256 校验后，才会移除 C 盘原件。"
        action={(
          <button className="secondary-button" data-liquid-glass data-glass-depth="38" onClick={onScan} disabled={Boolean(busy)}>
            <RefreshCw size={17} />{result ? '重新识别' : '识别可迁移文件'}
          </button>
        )}
      />

      <div className="migration-safety" data-liquid-glass data-glass-depth="28">
        <ShieldCheck size={21} />
        <span>
          <strong>失败就完整回滚</strong>
          任一步失败都会删除 D 盘临时片段或未完成副本，只保留 C 盘原件。系统、应用、云盘和聊天数据不会进入候选列表。
        </span>
      </div>

      {lastResult && (
        <section className="migration-result" data-liquid-glass data-glass-depth="34">
          <div>
            <CheckCircle2 size={21} />
            <span>
              <strong>最近一次迁移释放了 {formatBytes(lastResult.reclaimedBytes)}</strong>
              成功 {lastResult.moved} 个，失败 {lastResult.failed} 个
            </span>
          </div>
          <div className="migration-result-actions">
            {lastResult.files.slice(0, 3).map((file) => (
              <button
                key={file.id}
                className="link-button"
                onClick={() => void window.jingpan.revealMigratedFile(lastResult.batchId, file.id)}
              >
                <FolderOpen size={14} />{file.name}
              </button>
            ))}
            {lastResult.moved > 0 && (
              <button
                className="secondary-button"
                data-liquid-glass
                data-glass-depth="36"
                onClick={() => onUndo(lastResult.batchId, lastResult.moved, lastResult.reclaimedBytes)}
              >
                <RotateCcw size={16} />撤销本次迁移
              </button>
            )}
          </div>
          {lastResult.errors.length > 0 && (
            <small>{lastResult.errors.slice(0, 2).join('；')}</small>
          )}
        </section>
      )}

      {!result ? (
        <EmptyState
          icon={ArrowRightLeft}
          title="先识别，再选择迁移"
          description="推荐项来自下载、图片、视频和音乐目录。桌面与文档会单独标为谨慎项，不会默认选择。"
          button="开始识别"
          onClick={onScan}
        />
      ) : (
        <>
          <ScanFreshness scannedAt={result.scannedAt} />
          <section className="migration-summary">
            <div data-liquid-glass data-glass-depth="30"><span>D 盘可用</span><strong>{formatBytes(result.destinationFreeBytes)}</strong><small>{result.destinationRoot}</small></div>
            <div data-liquid-glass data-glass-depth="30"><span>推荐迁移</span><strong>{formatBytes(result.recommendedBytes)}</strong><small>{recommendedCount.toLocaleString('zh-CN')} 个高置信文件</small></div>
            <div data-liquid-glass data-glass-depth="30"><span>已安全排除</span><strong>{result.excludedCount.toLocaleString('zh-CN')}</strong><small>应用数据、云文件和低收益项目</small></div>
          </section>

          <div className="migration-filter">
            <button
              data-liquid-glass
              data-glass-depth="34"
              className={confidence === 'recommended' ? 'active' : ''}
              onClick={() => setConfidence('recommended')}
            >
              推荐 <span>{recommendedCount}</span>
            </button>
            <button
              data-liquid-glass
              data-glass-depth="34"
              className={confidence === 'review' ? 'active' : ''}
              onClick={() => setConfidence('review')}
            >
              谨慎 <span>{reviewCount}</span>
            </button>
            <button
              data-liquid-glass
              data-glass-depth="34"
              className={confidence === 'all' ? 'active' : ''}
              onClick={() => setConfidence('all')}
            >
              全部 <span>{result.files.length}</span>
            </button>
          </div>

          <section className="content-card migration-browser" data-liquid-glass data-glass-depth="24">
            <div className="file-toolbar">
              <label className="search-box">
                <Search size={17} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名或原位置" />
              </label>
              <span>显示 {filtered.length.toLocaleString('zh-CN')} 项</span>
            </div>
            <div className="migration-table-head">
              <button className={`checkbox ${allShownSelected ? 'checked' : ''}`} onClick={toggleShown}>
                {allShownSelected && <Check size={14} />}
              </button>
              <span>源文件与迁移原因</span>
              <span>目标位置</span>
              <span>大小</span>
            </div>
            <div className="migration-table">
              {shown.length === 0
                ? <div className="minor-empty">没有符合条件的迁移文件</div>
                : shown.map((file) => {
                    const meta = FILE_KIND_META[file.kind]
                    const Icon = meta.icon
                    const checked = selected.has(file.id)
                    return (
                      <button
                        key={file.id}
                        className={`migration-row ${checked ? 'selected' : ''}`}
                        onClick={() => toggleFile(file.id)}
                      >
                        <span className={`checkbox ${checked ? 'checked' : ''}`}>{checked && <Check size={14} />}</span>
                        <span className="migration-source">
                          <FileThumbnail scope="migration" fileId={file.id} kind={file.kind} color={meta.color} icon={Icon} />
                          <span><strong>{file.name}</strong><small title={file.path}>{file.path}</small><em className={file.confidence}>{file.reason}</em></span>
                        </span>
                        <span className="migration-destination" title={file.destinationPath}>{file.destinationPath}</span>
                        <b>{formatBytes(file.bytes)}</b>
                      </button>
                    )
                  })}
            </div>
            <PaginationControl page={page} pageCount={pageCount} onPageChange={setPage} />
          </section>

          <div className="sticky-action migration-action" data-liquid-glass data-glass-depth="36">
            <div><span>已选择 {selected.size} 个文件</span><strong>预计释放 {formatBytes(selectedBytes)}</strong></div>
            <div className="recoverable-note"><ShieldCheck size={15} />复制校验后再移除源文件</div>
            <button
              className="primary-button"
              data-liquid-glass
              data-glass-depth="40"
              disabled={selected.size === 0 || !result.scanId || Boolean(busy)}
              onClick={() => onMigrate([...selected], selectedBytes)}
            >
              <ArrowRightLeft size={18} />迁移到 D 盘
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function SettingsPage({
  snapshot,
  update,
  checking,
  onCheck,
  onDownload,
  onOpenPage,
  onOpenData
}: {
  snapshot: AppSnapshot
  update: UpdateCheckResult | null
  checking: boolean
  onCheck: () => void
  onDownload: () => void
  onOpenPage: () => void
  onOpenData: () => void
}): React.JSX.Element {
  const updateDescription = checking
    ? '正在连接 GitHub 检查正式版本…'
    : update?.status === 'available'
      ? `${update.message}${update.downloadAvailable ? `，安装包 ${formatBytes(update.assetBytes)}` : ''}`
      : update?.message ?? '启动后自动检查，软件运行期间每 6 小时检查一次。'
  return (
    <div className="page-stack">
      <PageIntro title="设置与帮助" description="净盘坚持本地运行、透明规则和可恢复操作。" />
      <section className="content-card settings-list">
        <div>
          <span className="setting-icon"><RefreshCw className={checking ? 'spin' : ''} /></span>
          <span><strong>软件更新</strong><small>{updateDescription}</small></span>
          <span className="setting-actions">
            {update?.status === 'available' && <button className="link-button" onClick={onOpenPage}>更新说明</button>}
            {update?.status === 'available' && update.downloadAvailable && <button className="setting-download-button" onClick={onDownload}><Download size={14} />下载更新</button>}
            <button className="link-button" disabled={checking} onClick={onCheck}>{checking ? '检查中' : '检查更新'}</button>
          </span>
        </div>
        <div><span className="setting-icon"><ShieldCheck /></span><span><strong>安全清理白名单</strong><small>只允许清理程序内置的临时文件和缓存目录，界面无法提交任意路径。</small></span><em className="enabled-badge">已开启</em></div>
        <div><span className="setting-icon"><MonitorCog /></span><span><strong>管理员权限</strong><small>{snapshot.isAdministrator ? '当前以管理员身份运行，可扫描更多 Windows 临时文件。' : '当前为普通权限；受保护文件会被安全跳过，无需特意提权。'}</small></span><em className={snapshot.isAdministrator ? 'enabled-badge' : 'neutral-badge'}>{snapshot.isAdministrator ? '管理员' : '普通权限'}</em></div>
        <div><span className="setting-icon"><FolderOpen /></span><span><strong>缓存与设置位置</strong><small title={snapshot.dataPath}>{snapshot.portableMode ? '项目内存储已开启：' : 'Windows 默认存储：'}{snapshot.dataPath}</small></span><button className="link-button" onClick={onOpenData}>打开位置</button></div>
        <div><span className="setting-icon"><HardDrive /></span><span><strong>Windows 清理建议</strong><small>查看以前的 Windows 安装、大型或未使用文件、云同步文件和闲置应用等官方建议。</small></span><button className="link-button" onClick={() => void window.jingpan.openStorageRecommendations()}>打开建议</button></div>
        <div><span className="setting-icon"><RefreshCw /></span><span><strong>自动存储感知</strong><small>设置 Windows 何时自动清理临时文件、回收站和本地云文件；下载目录默认不会被处理。</small></span><button className="link-button" onClick={() => void window.jingpan.openStorageSenseSettings()}>设置规则</button></div>
        <div><span className="setting-icon"><FolderOpen /></span><span><strong>新内容保存位置</strong><small>把新应用、文档、音乐、图片和视频的默认保存位置改到其他磁盘，减少 C 盘再次变满。</small></span><button className="link-button" onClick={() => void window.jingpan.openSaveLocations()}>选择位置</button></div>
        <div><span className="setting-icon"><Sparkles /></span><span><strong>Windows 磁盘清理</strong><small>打开微软自带的磁盘清理窗口，由你选择 Windows 更新、临时安装文件等系统项目。</small></span><button className="link-button" onClick={() => void window.jingpan.openDiskCleanup()}>打开工具</button></div>
      </section>
      <section className="content-card safety-explainer">
        <div className="section-heading"><div><h2>我们如何保护你的文件</h2><p>简单，但不省略重要的安全边界</p></div></div>
        <div className="safety-grid"><div><CheckCircle2 /><strong>不上传数据</strong><span>所有扫描与分类都在本机完成。</span></div><div><CheckCircle2 /><strong>不猜测用途</strong><span>系统与应用目录只分析、不删除。</span></div><div><CheckCircle2 /><strong>个人文件可恢复</strong><span>手动选择的文件只移入回收站。</span></div></div>
      </section>
    </div>
  )
}

function InstalledAppsPage({
  result,
  busy,
  onScan,
  onUninstall
}: {
  result: InstalledAppScanResult | null
  busy: BusyTask
  onScan: () => void
  onUninstall: (app: InstalledApp) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | InstalledApp['usageStatus']>('all')
  const [driveFilter, setDriveFilter] = useState<'all' | InstalledApp['systemDriveStatus']>('system')
  const [sort, setSort] = useState<'unused' | 'size' | 'name'>('unused')

  const apps = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return (result?.apps ?? [])
      .filter((app) => (
        (filter === 'all' || app.usageStatus === filter)
        && (driveFilter === 'all' || app.systemDriveStatus === driveFilter)
        && (!needle || app.name.toLocaleLowerCase('zh-CN').includes(needle) || app.publisher.toLocaleLowerCase('zh-CN').includes(needle))
      ))
      .sort((a, b) => {
        if (sort === 'size') return b.estimatedBytes - a.estimatedBytes
        if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN')
        const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0
        const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0
        return aTime - bTime
      })
  }, [result, query, filter, driveFilter, sort])

  const counts = useMemo(() => {
    const values = { recent: 0, stale: 0, 'very-stale': 0, unknown: 0 }
    for (const app of result?.apps ?? []) values[app.usageStatus] += 1
    return values
  }, [result])

  return (
    <div className="page-stack">
      <PageIntro title="应用管理" description="按使用记录查找可能闲置的软件，并通过它自身的正式卸载入口移除。" action={<button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}><RefreshCw size={17} />{result ? '刷新列表' : '读取应用'}</button>} />
      <div className="info-banner"><CircleHelp size={19} /><span><strong>“最后使用”是参考信息</strong>部分软件不会向 Windows 提供完整使用记录；“未发现记录”不代表从未使用，请结合名称、大小和用途判断。</span></div>
      {!result ? <EmptyState icon={AppWindow} title="找出安装后被遗忘的软件" description="读取 Windows 已安装应用与当前用户的使用记录，不会扫描软件内容。" button="查看已安装应用" onClick={onScan} /> : (
        <>
          <ScanFreshness scannedAt={result.scannedAt} />
          <div className="app-summary-grid">
            <button className={filter === 'very-stale' ? 'active' : ''} onClick={() => setFilter('very-stale')}><strong>{counts['very-stale']}</strong><span>半年以上未用</span></button>
            <button className={filter === 'stale' ? 'active' : ''} onClick={() => setFilter('stale')}><strong>{counts.stale}</strong><span>2-6 个月未用</span></button>
            <button className={filter === 'unknown' ? 'active' : ''} onClick={() => setFilter('unknown')}><strong>{counts.unknown}</strong><span>未发现记录</span></button>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><strong>{result.apps.length}</strong><span>全部应用</span></button>
          </div>
          <section className="content-card app-browser">
            <div className="file-toolbar">
              <label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用或发布者" /></label>
              <select value={driveFilter} onChange={(event) => setDriveFilter(event.target.value as typeof driveFilter)}><option value="system">明确位于 C 盘</option><option value="unknown">位置未知</option><option value="other">其他磁盘</option><option value="all">全部磁盘</option></select>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="unused">最久未用优先</option><option value="size">占用最大优先</option><option value="name">按名称排序</option></select>
              <span>显示 {apps.length.toLocaleString('zh-CN')} 个</span>
            </div>
            <div className="app-table-head"><span>应用</span><span>最近使用</span><span>估算大小</span><span /></div>
            <div className="app-table">
              {apps.length === 0 ? <div className="minor-empty">没有符合条件的应用</div> : apps.map((app) => <InstalledAppRow key={app.id} app={app} onUninstall={() => onUninstall(app)} />)}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function InstalledAppRow({ app, onUninstall }: { app: InstalledApp; onUninstall: () => void }): React.JSX.Element {
  const usage = app.usageStatus === 'unknown'
    ? { label: '未发现记录', tone: 'unknown' }
    : app.usageStatus === 'very-stale'
      ? { label: `${daysSince(app.lastUsedAt!)} 天未用`, tone: 'very-stale' }
      : app.usageStatus === 'stale'
        ? { label: `${daysSince(app.lastUsedAt!)} 天未用`, tone: 'stale' }
        : { label: app.lastUsedAt ? formatDate(app.lastUsedAt) : '近期', tone: 'recent' }
  return (
    <div className="app-row">
      <div className="app-name"><span><AppWindow size={20} /></span><div><strong>{app.name}</strong><small>{app.publisher}{app.version ? ` · ${app.version}` : ''}</small></div></div>
      <span className={`usage-badge ${usage.tone}`}>{usage.label}</span>
      <b>{app.estimatedBytes > 0 ? formatBytes(app.estimatedBytes) : '未知'}</b>
      <button className="uninstall-button" disabled={!app.uninstallAvailable} onClick={onUninstall}>{app.uninstallAvailable ? '卸载' : '不可用'}</button>
    </div>
  )
}

function PageIntro({ title, description, action }: { title: string; description: string; action?: React.ReactNode }): React.JSX.Element {
  return <div className="page-intro"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

function EmptyState({ icon: Icon, title, description, button, onClick }: { icon: typeof Sparkles; title: string; description: string; button: string; onClick: () => void }): React.JSX.Element {
  return <section className="empty-state"><div><Icon size={34} /></div><h2>{title}</h2><p>{description}</p><button className="primary-button" onClick={onClick}>{button}</button></section>
}

function ProgressOverlay({ progress, onCancel }: { progress: TaskProgress; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="overlay">
      <div className="progress-dialog" data-liquid-glass data-glass-depth="72" data-glass-clarity="1">
        <div className="progress-icon"><LoaderCircle className="spin" /></div>
        <h2>{progress.title}</h2>
        <p>{progress.detail}</p>
        <div className="progress-track" data-liquid-glass data-glass-depth="48">
          <span style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="progress-meta"><span>{progress.percent}%</span><span>全程本地处理</span></div>
        <button className="text-button" data-liquid-glass data-glass-depth="38" onClick={onCancel}>停止任务</button>
      </div>
    </div>
  )
}

function ConfirmDialog({ dialog, onCancel, onConfirm }: { dialog: Exclude<Dialog, null>; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  const cleanup = dialog.type === 'cleanup'
  const uninstall = dialog.type === 'uninstall'
  const chatRecycle = dialog.type === 'chat-recycle'
  const duplicateRecycle = dialog.type === 'duplicate-recycle'
  const migration = dialog.type === 'migration'
  const migrationUndo = dialog.type === 'migration-undo'
  const title = cleanup
    ? '确认开始安全清理？'
    : uninstall
      ? `卸载“${dialog.app.name}”？`
      : migration
        ? '确认迁移到 D 盘？'
        : migrationUndo
          ? '撤销最近一次迁移？'
          : '确认移入回收站？'
  const description = cleanup
    ? `将清理 ${dialog.ids.length} 类白名单内容，预计释放 ${formatBytes(dialog.bytes)}。占用中或无权限文件会自动跳过。`
    : uninstall
      ? '净盘将启动该应用登记在 Windows 中的正式卸载程序。请在随后出现的卸载向导中再次确认。'
      : migration
        ? `将迁移 ${dialog.ids.length} 个文件，共 ${formatBytes(dialog.bytes)}。每个文件会先复制到 D 盘并通过 SHA-256 校验，失败项会删除 D 盘片段并只保留 C 盘原件。`
        : migrationUndo
          ? `将校验 D 盘副本，并把 ${dialog.files} 个文件恢复到 C 盘原位置，共 ${formatBytes(dialog.bytes)}。原位置已有同名文件时不会覆盖。`
      : chatRecycle
        ? `你选择了 ${dialog.ids.length} 个聊天文件，共 ${formatBytes(dialog.bytes)}。移除后，微信或 QQ 中对应的旧图片、视频和附件可能无法打开；文件仍可从 Windows 回收站恢复。`
        : duplicateRecycle
          ? `你选择了 ${dialog.ids.length} 个已通过 SHA-256 核对的重复副本，共 ${formatBytes(dialog.bytes)}。每组至少保留一份，所选文件仍可从 Windows 回收站恢复。`
        : `你选择了 ${dialog.ids.length} 个文件，共 ${formatBytes(dialog.bytes)}。操作后仍可在 Windows 回收站中恢复。`
  return (
    <div className="overlay">
      <div className="confirm-dialog" data-liquid-glass data-glass-depth="38">
        <div className={`confirm-icon ${cleanup || migration || migrationUndo ? '' : 'danger'}`}>
          {cleanup
            ? <ShieldCheck />
            : uninstall
              ? <AppWindow />
              : migration
                ? <ArrowRightLeft />
                : migrationUndo
                  ? <RotateCcw />
                  : <Trash2 />}
        </div>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button className="secondary-button" data-liquid-glass data-glass-depth="36" onClick={onCancel}>取消</button>
          <button
            className={cleanup || migration || migrationUndo ? 'primary-button' : 'danger-button'}
            data-liquid-glass
            data-glass-depth="38"
            onClick={onConfirm}
          >
            {cleanup
              ? '确认清理'
              : uninstall
                ? '打开卸载程序'
                : migration
                  ? '确认迁移'
                  : migrationUndo
                    ? '确认撤销'
                    : '移入回收站'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Toast({ tone, text, onClose }: { tone: 'success' | 'warning'; text: string; onClose: () => void }): React.JSX.Element {
  useEffect(() => { const timer = window.setTimeout(onClose, 5000); return () => window.clearTimeout(timer) }, [onClose])
  return <div className={`toast ${tone}`}>{tone === 'success' ? <CheckCircle2 /> : <TriangleAlert />}<span>{text}</span><button onClick={onClose}><X size={16} /></button></div>
}

function toggleSet<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

export default App
