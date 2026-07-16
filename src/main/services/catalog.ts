import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { CategoryId, CategoryMeta } from '../../shared/types'

const DAY = 24 * 60 * 60 * 1000

export interface TargetSpec {
  root: string
  minAgeMs?: number
  includeFile?: (name: string) => boolean
}

export interface CategoryDefinition extends CategoryMeta {
  targets: TargetSpec[]
  specialCleaner?: 'recycle-bin'
  specialScanner?: 'recycle-bin'
}

export const CATEGORY_META: CategoryMeta[] = [
  {
    id: 'user-temp',
    title: '用户临时文件',
    description: '应用运行产生、且超过 24 小时的临时内容',
    detail: '仅清理当前用户临时目录中超过 24 小时的文件；正在使用的文件会自动跳过。',
    safety: 'recommended',
    defaultSelected: true,
    icon: 'sparkles'
  },
  {
    id: 'windows-temp',
    title: 'Windows 临时文件',
    description: '系统临时目录中超过 24 小时的残留文件',
    detail: 'Windows 或其他程序正在占用的文件不会被强制删除；部分内容可能需要管理员权限。',
    safety: 'recommended',
    defaultSelected: true,
    icon: 'windows'
  },
  {
    id: 'browser-cache',
    title: '浏览器缓存',
    description: '常用浏览器可重新生成的网页缓存',
    detail: '不会删除书签、历史记录、密码、扩展或登录状态。关闭浏览器后清理效果更完整。',
    safety: 'recommended',
    defaultSelected: true,
    icon: 'browser'
  },
  {
    id: 'system-cache',
    title: '图形与网络缓存',
    description: 'DirectX 着色器与 Windows 网络缓存',
    detail: '这些内容会在需要时由 Windows 自动重新生成，首次打开相关程序时可能短暂重建缓存。',
    safety: 'safe',
    defaultSelected: true,
    icon: 'cpu'
  },
  {
    id: 'crash-reports',
    title: '崩溃报告',
    description: '程序异常退出后留下的转储与报告',
    detail: '仅用于故障诊断。近期正在排查软件崩溃问题时，可以取消选择这一项。',
    safety: 'safe',
    defaultSelected: true,
    icon: 'report'
  },
  {
    id: 'thumbnail-cache',
    title: '缩略图缓存',
    description: '资源管理器生成的图片与文件预览缓存',
    detail: '清理后不会影响原文件，但下次浏览文件夹时 Windows 需要重新生成预览。',
    safety: 'review',
    defaultSelected: false,
    icon: 'image'
  },
  {
    id: 'recycle-bin',
    title: '回收站',
    description: '仍可恢复的已删除文件',
    detail: '清空后无法再从回收站恢复，因此默认不选中。请确认其中没有需要找回的文件。',
    safety: 'review',
    defaultSelected: false,
    icon: 'trash'
  }
]

function existing(paths: string[]): TargetSpec[] {
  return paths.filter((root) => existsSync(root)).map((root) => ({ root }))
}

function browserCacheRoots(localAppData: string, roamingAppData: string): string[] {
  const vendors = [
    path.join(localAppData, 'Google', 'Chrome', 'User Data'),
    path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
    path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    path.join(localAppData, 'Chromium', 'User Data')
  ]
  const roots: string[] = []

  for (const userData of vendors) {
    if (!existsSync(userData)) continue
    try {
      for (const entry of readdirSync(userData, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^(Default|Profile \d+|Guest Profile)$/.test(entry.name)) continue
        const profile = path.join(userData, entry.name)
        roots.push(
          path.join(profile, 'Cache'),
          path.join(profile, 'Code Cache'),
          path.join(profile, 'GPUCache')
        )
      }
    } catch {
      // A locked browser profile is simply omitted from this scan.
    }
  }

  const firefoxProfiles = path.join(roamingAppData, 'Mozilla', 'Firefox', 'Profiles')
  if (existsSync(firefoxProfiles)) {
    try {
      for (const entry of readdirSync(firefoxProfiles, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        roots.push(
          path.join(firefoxProfiles, entry.name, 'cache2'),
          path.join(firefoxProfiles, entry.name, 'startupCache')
        )
      }
    } catch {
      // Locked Firefox profiles are omitted.
    }
  }

  for (const operaProfile of ['Opera Stable', 'Opera GX Stable']) {
    const profile = path.join(roamingAppData, 'Opera Software', operaProfile)
    roots.push(path.join(profile, 'Cache'), path.join(profile, 'GPUCache'), path.join(profile, 'Code Cache'))
  }
  return roots
}

export function getCategoryDefinitions(): CategoryDefinition[] {
  const local = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const temp = process.env.TEMP ?? path.join(local, 'Temp')
  const byId = new Map<CategoryId, CategoryDefinition>()

  for (const meta of CATEGORY_META) byId.set(meta.id, { ...meta, targets: [] })

  byId.get('user-temp')!.targets = [{ root: temp, minAgeMs: DAY }]
  byId.get('windows-temp')!.targets = [{ root: path.join(systemRoot, 'Temp'), minAgeMs: DAY }]
  byId.get('browser-cache')!.targets = existing(browserCacheRoots(local, roaming))
  byId.get('system-cache')!.targets = existing([
    path.join(local, 'D3DSCache'),
    path.join(local, 'Microsoft', 'Windows', 'INetCache')
  ])
  byId.get('crash-reports')!.targets = existing([
    path.join(local, 'CrashDumps'),
    path.join(local, 'Microsoft', 'Windows', 'WER')
  ])
  byId.get('thumbnail-cache')!.targets = [
    {
      root: path.join(local, 'Microsoft', 'Windows', 'Explorer'),
      includeFile: (name) => /^(thumbcache|iconcache).+\.db$/i.test(name)
    }
  ]
  byId.get('recycle-bin')!.targets = []
  byId.get('recycle-bin')!.specialCleaner = 'recycle-bin'
  byId.get('recycle-bin')!.specialScanner = 'recycle-bin'

  return CATEGORY_META.map((meta) => byId.get(meta.id)!)
}
