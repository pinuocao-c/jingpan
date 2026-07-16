import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AnalysisResult, LargeFile, SpaceGroup, TaskProgress } from '../../shared/types'
import { isPathInside, type TaskController } from './filesystem'
import { getDiskSummary, getSystemDrive } from './system'

const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024

interface LocationDefinition {
  id: SpaceGroup['id']
  title: string
  description: string
  color: string
  roots: string[]
}

interface LocationResult {
  bytes: number
  files: number
  visited: number
  largeFiles: LargeFile[]
}

function addLargeFile(list: LargeFile[], file: LargeFile): void {
  list.push(file)
  list.sort((a, b) => b.bytes - a.bytes)
  if (list.length > 40) list.length = 40
}

async function analyzeRoot(
  root: string,
  controller: TaskController,
  onTick: (visited: number) => void
): Promise<LocationResult> {
  const result: LocationResult = { bytes: 0, files: 0, visited: 0, largeFiles: [] }
  const resolvedRoot = path.resolve(root)
  const directories = [resolvedRoot]

  while (directories.length > 0 && !controller.cancelled) {
    const directory = directories.pop()!
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (controller.cancelled) break
      const candidate = path.join(directory, entry.name)
      if (!isPathInside(resolvedRoot, candidate)) continue
      result.visited += 1

      try {
        const stat = await fs.lstat(candidate)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          directories.push(candidate)
        } else if (stat.isFile()) {
          result.bytes += stat.size
          result.files += 1
          if (stat.size >= LARGE_FILE_THRESHOLD) {
            addLargeFile(result.largeFiles, {
              path: candidate,
              name: entry.name,
              bytes: stat.size,
              modifiedAt: stat.mtime.toISOString()
            })
          }
        }
      } catch {
        // Protected or transient files are omitted, never treated as zero-risk cleanup candidates.
      }

      if (result.visited % 500 === 0) onTick(result.visited)
    }
  }

  onTick(result.visited)
  return result
}

export async function analyzeSystemDrive(
  controller: TaskController,
  onProgress: (progress: TaskProgress) => void
): Promise<AnalysisResult> {
  const startedAt = Date.now()
  const drive = getSystemDrive()
  const definitions: LocationDefinition[] = [
    {
      id: 'system',
      title: 'Windows 系统',
      description: '系统核心文件，只分析不清理',
      color: '#5b8ff9',
      roots: [`${drive}\\Windows`]
    },
    {
      id: 'apps',
      title: '应用与游戏',
      description: '建议通过卸载程序释放空间',
      color: '#7856ff',
      roots: [`${drive}\\Program Files`, `${drive}\\Program Files (x86)`]
    },
    {
      id: 'users',
      title: '用户文件',
      description: '桌面、下载、文档、图片与应用数据',
      color: '#23b48e',
      roots: [`${drive}\\Users`]
    },
    {
      id: 'program-data',
      title: '应用数据',
      description: '所有用户共享的程序数据，只分析不清理',
      color: '#f2a93b',
      roots: [`${drive}\\ProgramData`]
    }
  ]

  const groups: SpaceGroup[] = []
  const largeFiles: LargeFile[] = []

  for (let index = 0; index < definitions.length && !controller.cancelled; index += 1) {
    const definition = definitions[index]
    let bytes = 0
    let fileCount = 0

    for (const root of definition.roots) {
      if (controller.cancelled) break
      const rootResult = await analyzeRoot(root, controller, (visited) => {
        onProgress({
          kind: 'analyze',
          percent: Math.min(96, Math.round(((index + 0.55) / definitions.length) * 100)),
          title: `正在分析${definition.title}`,
          detail: `已查看 ${visited.toLocaleString('zh-CN')} 个项目`,
          filesVisited: visited
        })
      })
      bytes += rootResult.bytes
      fileCount += rootResult.files
      for (const file of rootResult.largeFiles) addLargeFile(largeFiles, file)
    }

    groups.push({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      color: definition.color,
      bytes,
      fileCount
    })
  }

  const disk = await getDiskSummary()
  const measured = groups.reduce((sum, group) => sum + group.bytes, 0)
  groups.push({
    id: 'other',
    title: '其他与系统保留',
    description: '分页文件、休眠文件、受保护目录及未归类内容',
    color: '#a8b2c1',
    bytes: Math.max(0, disk.usedBytes - measured),
    fileCount: 0
  })

  onProgress({
    kind: 'analyze',
    percent: 100,
    title: controller.cancelled ? '分析已停止' : '空间分析完成',
    detail: controller.cancelled ? '已保留当前结果' : '系统目录始终保持只读分析'
  })

  return {
    groups,
    largeFiles,
    analyzedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    cancelled: controller.cancelled
  }
}
