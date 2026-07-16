import {
  Archive,
  AppWindow,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
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
  LoaderCircle,
  MessageCircle,
  MonitorCog,
  NotepadText,
  Package,
  Presentation,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  InstalledApp,
  InstalledAppScanResult,
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

type Page = 'overview' | 'cleanup' | 'analysis' | 'chat' | 'files' | 'apps' | 'settings'
type BusyTask = 'scan' | 'clean' | 'analysis' | 'files' | 'chat' | 'apps' | null
type Dialog =
  | { type: 'cleanup'; ids: CategoryId[]; bytes: number }
  | { type: 'recycle'; ids: string[]; bytes: number }
  | { type: 'chat-recycle'; ids: string[]; bytes: number }
  | { type: 'uninstall'; app: InstalledApp }
  | null

const FILE_KIND_META: Record<UserFileKind, { label: string; icon: typeof FileImage; color: string }> = {
  image: { label: '图片', icon: FileImage, color: '#ec6f8c' },
  video: { label: '视频', icon: FileVideo, color: '#7856ff' },
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

const navItems: Array<{ id: Page; label: string; description: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '空间概览', description: '查看 C 盘容量和建议操作', icon: LayoutDashboard },
  { id: 'cleanup', label: '安全清理', description: '扫描并清理白名单缓存', icon: Sparkles },
  { id: 'analysis', label: '空间分析', description: '了解系统与文件空间占用', icon: BarChart3 },
  { id: 'chat', label: '聊天文件', description: '整理微信与 QQ 本地文件', icon: MessageCircle },
  { id: 'files', label: '个人文件', description: '筛选、预览并整理个人文件', icon: FileText },
  { id: 'apps', label: '应用管理', description: '查找闲置软件并安全卸载', icon: AppWindow },
  { id: 'settings', label: '设置与帮助', description: '打开系统工具和安全说明', icon: Settings }
]

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('overview')
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [chatFiles, setChatFiles] = useState<ChatFileScanResult | null>(null)
  const [userFiles, setUserFiles] = useState<UserFileScanResult | null>(null)
  const [installedApps, setInstalledApps] = useState<InstalledAppScanResult | null>(null)
  const [busy, setBusy] = useState<BusyTask>(null)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [selectedCategories, setSelectedCategories] = useState<Set<CategoryId>>(new Set())
  const [selectedChatFiles, setSelectedChatFiles] = useState<Set<string>>(new Set())
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toast, setToast] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null)
  const openingFiles = useRef(new Set<string>())
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

  const runUserFileScan = async (): Promise<void> => {
    if (busy) return
    setBusy('files')
    setSelectedFiles(new Set())
    setProgress({ kind: 'analyze', percent: 0, title: '准备整理个人文件', detail: '只读取个人目录中的文件信息' })
    try {
      setUserFiles(await window.jingpan.scanUserFiles())
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '个人文件整理未能完成' })
    } finally {
      setBusy(null)
    }
  }

  const runChatFileScan = async (): Promise<void> => {
    if (busy) return
    setBusy('chat')
    setSelectedChatFiles(new Set())
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
    setDialog(null)
    try {
      let movedToRecycleBin = 0
      let failed = 0
      const movedIds: string[] = []
      for (let index = 0; index < ids.length; index += 2_000) {
        const result = await window.jingpan.recycleUserFiles(ids.slice(index, index + 2_000))
        movedToRecycleBin += result.movedToRecycleBin
        failed += result.failed
        movedIds.push(...result.movedIds)
      }
      const removed = new Set(movedIds)
      setUserFiles({ ...userFiles, files: userFiles.files.filter((file) => !removed.has(file.id)) })
      setSelectedFiles(new Set(ids.filter((id) => !removed.has(id))))
      setToast({
        tone: failed > 0 ? 'warning' : 'success',
        text: `${movedToRecycleBin} 个文件已移入回收站${failed ? `，${failed} 个文件已变化或处理失败` : ''}`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '文件未能移入回收站' })
    }
  }

  const confirmChatRecycle = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'chat-recycle' || !chatFiles) return
    const ids = dialog.ids
    setDialog(null)
    try {
      let movedToRecycleBin = 0
      let failed = 0
      const movedIds: string[] = []
      for (let index = 0; index < ids.length; index += 2_000) {
        const result = await window.jingpan.recycleChatFiles(ids.slice(index, index + 2_000))
        movedToRecycleBin += result.movedToRecycleBin
        failed += result.failed
        movedIds.push(...result.movedIds)
      }
      const removed = new Set(movedIds)
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
      setToast({
        tone: failed > 0 ? 'warning' : 'success',
        text: `${movedToRecycleBin} 个聊天文件已移入回收站${failed ? `，${failed} 个文件已变化、被占用或处理失败` : ''}`
      })
    } catch (error) {
      setToast({ tone: 'warning', text: error instanceof Error ? error.message : '聊天文件未能移入回收站' })
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

  const cancelBusy = (): void => {
    if (busy === 'scan') void window.jingpan.cancelScan()
    if (busy === 'clean') void window.jingpan.cancelCleanup()
    if (busy === 'analysis') void window.jingpan.cancelAnalysis()
    if (busy === 'files') void window.jingpan.cancelUserFileScan()
    if (busy === 'chat') void window.jingpan.cancelChatFileScan()
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
          />
        )
    }
  })()

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={20} strokeWidth={2.4} /></div>
          <div><strong>净盘</strong><span>安全管理 C 盘</span></div>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}>
                <Icon size={19} />
                <span className="nav-copy"><span>{item.label}</span><small>{item.description}</small></span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-trust">
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
        <div className="page-container">{content}</div>
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
                : dialog.type === 'chat-recycle'
                  ? confirmChatRecycle
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
      <div className="disk-ring" style={{ '--disk-percent': `${percent * 3.6}deg` } as React.CSSProperties}>
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
          <section className="content-card">
            <div className="section-heading"><div><h2>空间分布</h2><p>分析于 {formatDate(analysis.analyzedAt)}，耗时 {formatDuration(analysis.durationMs)}</p></div><strong>{formatBytes(total)}</strong></div>
            <div className="space-bar">{analysis.groups.filter((group) => group.bytes > 0).map((group) => <span key={group.id} style={{ width: `${Math.max(1, (group.bytes / total) * 100)}%`, background: group.color }} />)}</div>
            <div className="space-groups">{analysis.groups.map((group) => <div key={group.id}><i style={{ background: group.color }} /><span><strong>{group.title}</strong><small>{group.description}</small></span><b>{formatBytes(group.bytes)}</b></div>)}</div>
          </section>
          <section className="content-card">
            <div className="section-heading"><div><h2>大文件</h2><p>显示超过 500 MB 的文件。请打开所在位置后自行确认用途。</p></div><span className="read-only-badge"><ShieldCheck size={14} />只读列表</span></div>
            {analysis.largeFiles.length === 0 ? <div className="minor-empty">没有找到超过 500 MB 的普通文件</div> : <div className="large-files">{analysis.largeFiles.slice(0, 20).map((file) => <div key={file.path}><div className="file-type-icon"><FileText size={18} /></div><span><strong title={file.path}>{file.name}</strong><small>{file.path}</small></span><b>{formatBytes(file.bytes)}</b><button title="打开所在文件夹" onClick={() => void window.jingpan.revealLargeFile(file.path)}><FolderOpen size={18} /></button></div>)}</div>}
          </section>
        </>
      )}
    </div>
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
  onRecycle
}: {
  result: ChatFileScanResult | null
  busy: BusyTask
  selected: Set<string>
  onScan: () => void
  onChooseQqFolder: () => void
  onSelectedChange: (selected: Set<string>) => void
  onOpen: (fileId: string) => void
  onRecycle: (ids: string[], bytes: number) => void
}): React.JSX.Element {
  const [platform, setPlatform] = useState<ChatPlatform | 'all'>('all')
  const [account, setAccount] = useState<string | 'all'>('all')
  const [kind, setKind] = useState<ChatFileKind | 'all'>('all')
  const [age, setAge] = useState<'all' | '30' | '90' | '180' | '365'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'size' | 'date' | 'name'>('size')
  const [page, setPage] = useState(1)
  const pageSize = 50

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
      .sort((left, right) => (
        sort === 'size'
          ? right.bytes - left.bytes
          : sort === 'date'
            ? right.modifiedAt.localeCompare(left.modifiedAt)
            : left.name.localeCompare(right.name, 'zh-CN')
      ))
  }, [platformFiles, account, kind, age, search, sort])

  const availableAccounts = useMemo(
    () => (result?.accounts ?? []).filter((item) => platform === 'all' || item.platform === platform),
    [result, platform]
  )
  useEffect(() => {
    if (account !== 'all' && !availableAccounts.some((item) => item.id === account)) setAccount('all')
  }, [account, availableAccounts])
  useEffect(() => setPage(1), [platform, account, kind, age, search, sort, result])

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
  const allShownSelected = shown.length > 0 && shown.every((file) => selected.has(file.id))
  const toggleShown = (): void => {
    const next = new Set(selected)
    if (allShownSelected) shown.forEach((file) => next.delete(file.id))
    else shown.forEach((file) => next.add(file.id))
    onSelectedChange(next)
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
                  <span>共 {filtered.length.toLocaleString('zh-CN')} 项</span>
                </div>
                <div className="chat-file-table-head"><button className={`checkbox ${allShownSelected ? 'checked' : ''}`} onClick={toggleShown}>{allShownSelected && <Check size={14} />}</button><span>文件（可预览时点击打开）</span><span>来源</span><span>修改日期</span><span>大小</span><span /></div>
                <div className="chat-file-table">
                  {shown.length === 0 ? <div className="minor-empty">没有符合条件的聊天文件</div> : shown.map((file) => (
                    <ChatFileRow
                      key={file.id}
                      file={file}
                      checked={selected.has(file.id)}
                      onOpen={() => onOpen(file.id)}
                      onToggle={() => onSelectedChange(toggleSet(selected, file.id))}
                    />
                  ))}
                </div>
                <div className="pagination"><span>第 {page} / {pageCount} 页</span><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /></button><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div>
              </section>
              <div className="sticky-action file-action">
                <div><span>已选择 {selected.size} 个聊天文件</span><strong>共 {formatBytes(selectedBytes)}</strong></div>
                <div className="recoverable-note"><ShieldCheck size={15} />可从回收站恢复</div>
                <button className="danger-button" disabled={selected.size === 0} onClick={() => onRecycle([...selected], selectedBytes)}><Trash2 size={18} />移入回收站</button>
              </div>
            </>
          )}
        </>
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
      <div className="file-name"><span style={{ color: meta.color }}><Icon size={19} /></span><div><strong title={file.name}>{file.name}</strong><small title={file.path}>{file.path}</small></div></div>
      <span className={`chat-source-badge ${file.platform}`} title={`${file.accountLabel} · ${file.drive}盘`}>{sourceLabel}</span>
      <span>{formatDate(file.modifiedAt)}</span>
      <b>{formatBytes(file.bytes)}</b>
      <button className="icon-button" aria-label={`打开 ${file.name} 所在文件夹`} title="打开所在文件夹" onClick={(event) => { event.stopPropagation(); void window.jingpan.revealChatFile(file.id) }}><FolderOpen size={17} /></button>
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
  onRecycle
}: {
  result: UserFileScanResult | null
  busy: BusyTask
  selected: Set<string>
  onScan: () => void
  onSelectedChange: (selected: Set<string>) => void
  onOpen: (fileId: string) => void
  onRecycle: (ids: string[], bytes: number) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<UserFileKind | 'all'>('all')
  const [location, setLocation] = useState<UserFileLocation | 'all'>('all')
  const [age, setAge] = useState<'all' | '90' | '180' | '365'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'size' | 'date' | 'name'>('size')
  const [page, setPage] = useState(1)
  const pageSize = 50

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN')
    const ageCutoff = age === 'all' ? 0 : Date.now() - Number(age) * 86_400_000
    const items = (result?.files ?? []).filter((file) => (
      (kind === 'all' || file.kind === kind)
      && (location === 'all' || file.location === location)
      && (!ageCutoff || new Date(file.modifiedAt).getTime() <= ageCutoff)
      && (!query || file.name.toLocaleLowerCase('zh-CN').includes(query) || file.path.toLocaleLowerCase('zh-CN').includes(query))
    ))
    return items.sort((a, b) => sort === 'size' ? b.bytes - a.bytes : sort === 'date' ? b.modifiedAt.localeCompare(a.modifiedAt) : a.name.localeCompare(b.name, 'zh-CN'))
  }, [result, kind, location, age, search, sort])

  useEffect(() => setPage(1), [kind, location, age, search, sort, result])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize)
  const selectedItems = (result?.files ?? []).filter((file) => selected.has(file.id))
  const selectedBytes = selectedItems.reduce((sum, file) => sum + file.bytes, 0)
  const allShownSelected = shown.length > 0 && shown.every((file) => selected.has(file.id))

  const counts = useMemo(() => {
    const map = new Map<UserFileKind, number>()
    for (const file of result?.files ?? []) map.set(file.kind, (map.get(file.kind) ?? 0) + 1)
    return map
  }, [result])

  const toggleShown = (): void => {
    const next = new Set(selected)
    if (allShownSelected) shown.forEach((file) => next.delete(file.id))
    else shown.forEach((file) => next.add(file.id))
    onSelectedChange(next)
  }

  return (
    <div className="page-stack">
      <PageIntro title="个人文件" description="整理位于 C 盘的图片、视频、文本和办公文档。点击文件行可直接打开预览，只有勾选的文件才会移入回收站。" action={<button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}><RefreshCw size={17} />{result ? '重新整理' : '扫描个人文件'}</button>} />
      {!result ? <EmptyState icon={FileText} title="整理 C 盘个人文件，找回更多空间" description="扫描位于 C 盘的桌面、下载、文档、图片、视频与 OneDrive，不读取文件内容。" button="开始整理" onClick={onScan} /> : (
        <>
          {result.truncated && <div className="info-banner"><CircleHelp size={19} /><span><strong>文件数量较多</strong>共找到 {result.totalMatched.toLocaleString('zh-CN')} 项，当前展示占用最大的 {result.files.length.toLocaleString('zh-CN')} 项。</span></div>}
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
              <select value={location} onChange={(event) => setLocation(event.target.value as typeof location)}><option value="all">全部位置</option><option value="downloads">下载目录</option><option value="desktop">桌面</option><option value="documents">文档</option><option value="pictures">图片</option><option value="videos">视频</option><option value="onedrive">OneDrive</option></select>
              <select value={age} onChange={(event) => setAge(event.target.value as typeof age)}><option value="all">全部时间</option><option value="90">90 天未修改</option><option value="180">半年未修改</option><option value="365">一年未修改</option></select>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="size">按大小排序</option><option value="date">按修改日期排序</option><option value="name">按名称排序</option></select>
              <span>共 {filtered.length.toLocaleString('zh-CN')} 项</span>
            </div>
            <div className="file-table-head"><button className={`checkbox ${allShownSelected ? 'checked' : ''}`} onClick={toggleShown}>{allShownSelected && <Check size={14} />}</button><span>文件（点击可打开或预览）</span><span>修改日期</span><span>大小</span><span /></div>
            <div className="file-table">
              {shown.length === 0 ? <div className="minor-empty">没有符合条件的文件</div> : shown.map((file) => <UserFileRow key={file.id} file={file} checked={selected.has(file.id)} onOpen={() => onOpen(file.id)} onToggle={() => onSelectedChange(toggleSet(selected, file.id))} />)}
            </div>
            <div className="pagination"><span>第 {page} / {pageCount} 页</span><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /></button><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div>
          </section>
          <div className="sticky-action file-action">
            <div><span>已选择 {selected.size} 个文件</span><strong>共 {formatBytes(selectedBytes)}</strong></div>
            <div className="recoverable-note"><ShieldCheck size={15} />可从回收站恢复</div>
            <button className="danger-button" disabled={selected.size === 0} onClick={() => onRecycle([...selected], selectedBytes)}><Trash2 size={18} />移入回收站</button>
          </div>
        </>
      )}
    </div>
  )
}

function UserFileRow({ file, checked, onOpen, onToggle }: { file: UserFileItem; checked: boolean; onOpen: () => void; onToggle: () => void }): React.JSX.Element {
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
      <button className={`checkbox ${checked ? 'checked' : ''}`} aria-label={`选择 ${file.name}`} onClick={(event) => { event.stopPropagation(); onToggle() }}>{checked && <Check size={14} />}</button>
      <div className="file-name"><span style={{ color: meta.color }}><Icon size={19} /></span><div><strong title={file.name}>{file.name}</strong><small title={file.path}>{file.path}</small></div></div>
      <span>{formatDate(file.modifiedAt)}</span><b>{formatBytes(file.bytes)}</b>
      <button className="icon-button" aria-label={`打开 ${file.name} 所在文件夹`} title="打开所在文件夹" onClick={(event) => { event.stopPropagation(); void window.jingpan.revealUserFile(file.id) }}><FolderOpen size={17} /></button>
    </div>
  )
}

function SettingsPage({
  snapshot,
  update,
  checking,
  onCheck,
  onDownload,
  onOpenPage
}: {
  snapshot: AppSnapshot
  update: UpdateCheckResult | null
  checking: boolean
  onCheck: () => void
  onDownload: () => void
  onOpenPage: () => void
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
        <div><span className="setting-icon"><HardDrive /></span><span><strong>Windows 存储设置</strong><small>需要管理已安装应用或系统存储感知时，请使用 Windows 官方页面。</small></span><button className="link-button" onClick={() => void window.jingpan.openStorageSettings()}>打开设置</button></div>
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
          <div className="app-summary-grid">
            <button className={filter === 'very-stale' ? 'active' : ''} onClick={() => setFilter('very-stale')}><strong>{counts['very-stale']}</strong><span>半年以上未用</span></button>
            <button className={filter === 'stale' ? 'active' : ''} onClick={() => setFilter('stale')}><strong>{counts.stale}</strong><span>2–6 个月未用</span></button>
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
    <div className="overlay"><div className="progress-dialog"><div className="progress-icon"><LoaderCircle className="spin" /></div><h2>{progress.title}</h2><p>{progress.detail}</p><div className="progress-track"><span style={{ width: `${progress.percent}%` }} /></div><div className="progress-meta"><span>{progress.percent}%</span><span>全程本地处理</span></div><button className="text-button" onClick={onCancel}>停止任务</button></div></div>
  )
}

function ConfirmDialog({ dialog, onCancel, onConfirm }: { dialog: Exclude<Dialog, null>; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  const cleanup = dialog.type === 'cleanup'
  const uninstall = dialog.type === 'uninstall'
  const chatRecycle = dialog.type === 'chat-recycle'
  const title = cleanup ? '确认开始安全清理？' : uninstall ? `卸载“${dialog.app.name}”？` : '确认移入回收站？'
  const description = cleanup
    ? `将清理 ${dialog.ids.length} 类白名单内容，预计释放 ${formatBytes(dialog.bytes)}。占用中或无权限文件会自动跳过。`
    : uninstall
      ? '净盘将启动该应用登记在 Windows 中的正式卸载程序。请在随后出现的卸载向导中再次确认。'
      : chatRecycle
        ? `你选择了 ${dialog.ids.length} 个聊天文件，共 ${formatBytes(dialog.bytes)}。移除后，微信或 QQ 中对应的旧图片、视频和附件可能无法打开；文件仍可从 Windows 回收站恢复。`
        : `你选择了 ${dialog.ids.length} 个文件，共 ${formatBytes(dialog.bytes)}。操作后仍可在 Windows 回收站中恢复。`
  return (
    <div className="overlay"><div className="confirm-dialog"><div className={`confirm-icon ${cleanup ? '' : 'danger'}`}>{cleanup ? <ShieldCheck /> : uninstall ? <AppWindow /> : <Trash2 />}</div><h2>{title}</h2><p>{description}</p><div className="dialog-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className={cleanup ? 'primary-button' : 'danger-button'} onClick={onConfirm}>{cleanup ? '确认清理' : uninstall ? '打开卸载程序' : '移入回收站'}</button></div></div></div>
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
