import type { ScannedCategory, ScanResult, TaskProgress } from '../../shared/types'
import { getCategoryDefinitions } from './catalog'
import { scanTarget, type TaskController } from './filesystem'
import { scanCurrentUserRecycleBin } from './recycleBin'

export async function scanCleanupCategories(
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void
): Promise<Omit<ScanResult, 'scanId'>> {
  const startedAt = Date.now()
  const definitions = getCategoryDefinitions()
  const categories: ScannedCategory[] = []

  for (let index = 0; index < definitions.length && !controller.cancelled; index += 1) {
    const definition = definitions[index]
    let bytes = 0
    let fileCount = 0
    let inaccessibleCount = 0
    let filesVisited = 0

    onProgress({
      kind: 'scan',
      percent: Math.round((index / definitions.length) * 100),
      title: `正在检查${definition.title}`,
      detail: definition.description,
      filesVisited
    })

    if (definition.specialScanner === 'recycle-bin') {
      const result = await scanCurrentUserRecycleBin()
      bytes = result.bytes
      fileCount = result.files
      inaccessibleCount = result.inaccessible
    } else {
      for (const target of definition.targets) {
        if (controller.cancelled) break
        const result = await scanTarget(target, controller, (current) => {
          onProgress({
            kind: 'scan',
            percent: Math.min(96, Math.round(((index + 0.55) / definitions.length) * 100)),
            title: `正在检查${definition.title}`,
            detail: `已查看 ${current.visited.toLocaleString('zh-CN')} 个项目`,
            filesVisited: filesVisited + current.visited
          })
        })
        bytes += result.bytes
        fileCount += result.files
        inaccessibleCount += result.inaccessible
        filesVisited += result.visited
      }
    }

    const {
      targets: _targets,
      specialCleaner: _specialCleaner,
      specialScanner: _specialScanner,
      ...meta
    } = definition
    categories.push({ ...meta, bytes, fileCount, inaccessibleCount })
  }

  const totalBytes = categories.reduce((sum, item) => sum + item.bytes, 0)
  const totalFiles = categories.reduce((sum, item) => sum + item.fileCount, 0)
  onProgress({
    kind: 'scan',
    percent: 100,
    title: controller.cancelled ? '扫描已停止' : '扫描完成',
    detail: controller.cancelled ? '已保留当前扫描结果' : `发现 ${totalFiles.toLocaleString('zh-CN')} 个可清理文件`
  })

  return {
    categories,
    scannedAt: new Date().toISOString(),
    totalBytes,
    totalFiles,
    durationMs: Date.now() - startedAt,
    cancelled: controller.cancelled
  }
}
