import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CategoryId, CleanupResult, TaskProgress } from '../../shared/types'
import { getCategoryDefinitions } from './catalog'
import { cleanTarget, type TaskController } from './filesystem'
import { getSystemDrive } from './system'

const execFileAsync = promisify(execFile)

async function emptyRecycleBin(): Promise<void> {
  const driveLetter = getSystemDrive().replace(':', '')
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Clear-RecycleBin -DriveLetter '${driveLetter}' -Force -ErrorAction Stop`
  ], { windowsHide: true, timeout: 30_000 })
}

export async function cleanCategories(
  requestedIds: CategoryId[],
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void
): Promise<CleanupResult> {
  const startedAt = Date.now()
  const definitions = getCategoryDefinitions()
  const allowList = new Set(definitions.map((item) => item.id))
  const uniqueIds = [...new Set(requestedIds)].filter((id) => allowList.has(id))
  const selected = uniqueIds.map((id) => definitions.find((item) => item.id === id)!)
  let reclaimedBytes = 0
  let removedFiles = 0
  let failedFiles = 0
  const errors: string[] = []

  for (let index = 0; index < selected.length && !controller.cancelled; index += 1) {
    const definition = selected[index]
    onProgress({
      kind: 'clean',
      percent: Math.round((index / selected.length) * 100),
      title: `正在清理${definition.title}`,
      detail: '仅处理扫描白名单内的文件'
    })

    if (definition.specialCleaner === 'recycle-bin') {
      try {
        await emptyRecycleBin()
      } catch (error) {
        failedFiles += 1
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`回收站：${message}`)
      }
      continue
    }

    for (const target of definition.targets) {
      if (controller.cancelled) break
      const result = await cleanTarget(target, controller, (current) => {
        onProgress({
          kind: 'clean',
          percent: Math.min(97, Math.round(((index + 0.6) / selected.length) * 100)),
          title: `正在清理${definition.title}`,
          detail: `已安全移除 ${(removedFiles + current.removed).toLocaleString('zh-CN')} 个文件`
        })
      })
      reclaimedBytes += result.bytes
      removedFiles += result.removed
      failedFiles += result.failed
      errors.push(...result.errors.slice(0, Math.max(0, 12 - errors.length)))
    }
  }

  onProgress({
    kind: 'clean',
    percent: 100,
    title: controller.cancelled ? '清理已停止' : '清理完成',
    detail: failedFiles > 0 ? `${failedFiles} 个占用中或无权限文件已跳过` : '所选内容已安全清理'
  })

  return {
    reclaimedBytes,
    removedFiles,
    failedFiles,
    durationMs: Date.now() - startedAt,
    cancelled: controller.cancelled,
    errors
  }
}
