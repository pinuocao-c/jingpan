import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { AppUsageStatus, InstalledApp, InstalledAppScanResult, UninstallLaunchResult } from '../../shared/types'
import { runPowerShellJson } from './powershell'
import { getSystemDrive } from './system'

interface RegistryApp {
  KeyPath?: string
  DisplayName?: string
  DisplayVersion?: string
  Publisher?: string
  InstallDate?: string
  EstimatedSize?: number
  InstallLocation?: string
  DisplayIcon?: string
  UninstallString?: string
  SystemComponent?: number
  ParentKeyName?: string
  ReleaseType?: string
  NoRemove?: number
}

interface UsageRecord {
  Path?: string
  LastUsedAt?: string
}

export interface InternalApp extends InstalledApp {
  uninstallString: string
}

const APP_SCRIPT = String.raw`
$roots = @(
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$items = foreach ($root in $roots) {
  Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
    Where-Object {
      $_.DisplayName -and
      $_.SystemComponent -ne 1 -and
      $_.NoRemove -ne 1 -and
      -not $_.ParentKeyName -and
      $_.ReleaseType -notmatch 'Update|Hotfix|Security Update' -and
      $_.DisplayName -notmatch '(^Update for|Security Update|Hotfix|KB\d+|Redistributable|Runtime|Driver|Graphics|Health Tools|WebView2|Visual C\+\+|驱动|Management Engine Components|Serial IO|PhysX|FrameView SDK|Chipset|HW OSD)'
    } |
    ForEach-Object {
      [PSCustomObject]@{
        KeyPath = $_.PSPath
        DisplayName = [string]$_.DisplayName
        DisplayVersion = [string]$_.DisplayVersion
        Publisher = [string]$_.Publisher
        InstallDate = [string]$_.InstallDate
        EstimatedSize = [long]$_.EstimatedSize
        InstallLocation = [string]$_.InstallLocation
        DisplayIcon = [string]$_.DisplayIcon
        UninstallString = [string]$_.UninstallString
        SystemComponent = [int]$_.SystemComponent
        ParentKeyName = [string]$_.ParentKeyName
        ReleaseType = [string]$_.ReleaseType
        NoRemove = [int]$_.NoRemove
      }
    }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 3
`

const USAGE_SCRIPT = String.raw`
function Convert-Rot13([string]$Text) {
  $chars = $Text.ToCharArray()
  for ($i = 0; $i -lt $chars.Length; $i++) {
    $n = [int]$chars[$i]
    if (($n -ge 65 -and $n -le 77) -or ($n -ge 97 -and $n -le 109)) { $chars[$i] = [char]($n + 13) }
    elseif (($n -ge 78 -and $n -le 90) -or ($n -ge 110 -and $n -le 122)) { $chars[$i] = [char]($n - 13) }
  }
  return -join $chars
}
$records = @()
Get-ChildItem 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $countPath = Join-Path $_.PSPath 'Count'
    $item = Get-ItemProperty -Path $countPath -ErrorAction SilentlyContinue
    if ($item) {
      foreach ($property in $item.PSObject.Properties) {
        if ($property.Name -like 'PS*' -or $property.Value -isnot [byte[]] -or $property.Value.Length -lt 68) { continue }
        try {
          $fileTime = [BitConverter]::ToInt64($property.Value, 60)
          if ($fileTime -le 0) { continue }
          $records += [PSCustomObject]@{
            Path = Convert-Rot13 $property.Name
            LastUsedAt = [DateTime]::FromFileTimeUtc($fileTime).ToString('o')
          }
        } catch {}
      }
    }
  }
ConvertTo-Json -InputObject @($records) -Compress -Depth 3
`

function makeId(value: string): string {
  return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 24)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function parseInstallDate(value?: string): string | null {
  if (!value) return null
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())
  if (!match) return null
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function extractExe(command: string): string {
  const trimmed = command.trim()
  const quoted = /^"([^"]+\.exe)"/i.exec(trimmed)
  if (quoted) return quoted[1]
  return /^(.+?\.exe)(?:\s|$)/i.exec(trimmed)?.[1] ?? ''
}

function usageStatus(lastUsedAt: string | null): AppUsageStatus {
  if (!lastUsedAt) return 'unknown'
  const ageDays = (Date.now() - new Date(lastUsedAt).getTime()) / 86_400_000
  if (ageDays >= 180) return 'very-stale'
  if (ageDays >= 60) return 'stale'
  return 'recent'
}

function getSystemDriveStatus(raw: RegistryApp): InstalledApp['systemDriveStatus'] {
  const installLocation = raw.InstallLocation?.trim()
  const iconExecutable = extractExe(raw.DisplayIcon ?? '')
  const location = installLocation || (iconExecutable ? path.dirname(iconExecutable) : '')
  if (!/^[a-z]:\\/i.test(location)) return 'unknown'
  return path.parse(location).root.toLocaleLowerCase('en-US')
    === `${getSystemDrive()}\\`.toLocaleLowerCase('en-US')
    ? 'system'
    : 'other'
}

function findLastUsed(app: RegistryApp, usage: UsageRecord[]): string | null {
  const location = app.InstallLocation ? path.resolve(app.InstallLocation).toLowerCase() : ''
  const locationName = location ? normalize(path.basename(location)) : ''
  const displayIcon = extractExe(app.DisplayIcon ?? '').toLowerCase()
  const iconName = displayIcon ? path.basename(displayIcon) : ''
  const appName = normalize(app.DisplayName ?? '')
  let newest = 0

  for (const record of usage) {
    if (!record.Path || !record.LastUsedAt) continue
    const recordPath = record.Path.replace(/^\{[^}]+\}/, '').toLowerCase()
    const recordName = path.basename(recordPath)
    const normalizedRecord = normalize(recordName.replace(/\.exe$/i, ''))
    const locationIsSpecific = Boolean(
      location
      && locationName.length >= 4
      && appName.length >= 4
      && (locationName.includes(appName) || appName.includes(locationName))
    )
    const match = (locationIsSpecific && recordPath.startsWith(`${location}${path.sep}`))
      || (iconName && recordName === iconName)
      || (
        appName.length >= 5
        && normalizedRecord.length >= 5
        && (normalizedRecord.includes(appName) || appName.includes(normalizedRecord))
      )
    if (!match) continue
    const timestamp = new Date(record.LastUsedAt).getTime()
    if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp)
  }
  return newest > 0 ? new Date(newest).toISOString() : null
}

function splitWindowsArguments(value: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let backslashes = 0
  for (const char of value.trim()) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2))
      if (backslashes % 2 === 0) quoted = !quoted
      else current += '"'
      backslashes = 0
      continue
    }
    if (backslashes) {
      current += '\\'.repeat(backslashes)
      backslashes = 0
    }
    if (/\s/.test(char) && !quoted) {
      if (current) { args.push(current); current = '' }
    } else current += char
  }
  if (backslashes) current += '\\'.repeat(backslashes)
  if (current) args.push(current)
  return args
}

export function sanitizeUninstallArguments(args: string[]): string[] {
  const silentFlags = /^(?:\/s|\/silent|\/verysilent|\/quiet|\/qn|\/qb!?|\/passive|\/norestart|\/suppressmsgboxes|\/sp-|--silent|--quiet|--passive|--norestart|-s)$/i
  return args
    .filter((argument) => argument.length <= 2_048 && !silentFlags.test(argument))
    .slice(0, 64)
}

async function spawnDetached(executable: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false
    })
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
    child.once('error', () => resolve(false))
  })
}

export async function scanInstalledApps(): Promise<{ result: InstalledAppScanResult; internal: Map<string, InternalApp> }> {
  const startedAt = Date.now()
  const [registryApps, usage] = await Promise.all([
    runPowerShellJson<RegistryApp[]>(APP_SCRIPT),
    runPowerShellJson<UsageRecord[]>(USAGE_SCRIPT).catch(() => [])
  ])
  const internal = new Map<string, InternalApp>()
  const dedupe = new Set<string>()

  for (const raw of registryApps ?? []) {
    const name = raw.DisplayName?.trim()
    if (!name) continue
    const dedupeKey = `${normalize(name)}|${normalize(raw.Publisher ?? '')}|${raw.DisplayVersion ?? ''}`
    if (dedupe.has(dedupeKey)) continue
    dedupe.add(dedupeKey)
    const id = makeId(`${raw.KeyPath ?? ''}|${dedupeKey}`)
    const lastUsedAt = findLastUsed(raw, usage ?? [])
    internal.set(id, {
      id,
      name,
      publisher: raw.Publisher?.trim() || '未知发布者',
      version: raw.DisplayVersion?.trim() || '',
      installDate: parseInstallDate(raw.InstallDate),
      estimatedBytes: Math.max(0, Number(raw.EstimatedSize ?? 0) * 1024),
      installLocation: raw.InstallLocation?.trim() || '',
      lastUsedAt,
      usageStatus: usageStatus(lastUsedAt),
      systemDriveStatus: getSystemDriveStatus(raw),
      uninstallAvailable: Boolean(raw.UninstallString?.trim()),
      uninstallString: raw.UninstallString?.trim() || ''
    })
  }

  const apps = [...internal.values()]
    .map(({ uninstallString: _uninstallString, ...app }) => app)
    .sort((a, b) => (a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0) - (b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0))

  return {
    result: { apps, scannedAt: new Date().toISOString(), durationMs: Date.now() - startedAt },
    internal
  }
}

export async function launchUninstaller(app: InternalApp): Promise<UninstallLaunchResult> {
  const command = app.uninstallString
  if (!command) return { launched: false, openedSettings: false, message: '这个应用没有提供卸载入口' }

  const productCode = /\{[0-9a-f-]{36}\}/i.exec(command)?.[0]
  if (/\bmsiexec(?:\.exe)?\b/i.test(command) && productCode) {
    const launched = await spawnDetached('msiexec.exe', ['/x', productCode])
    return {
      launched,
      openedSettings: false,
      message: launched ? '已打开 Windows Installer 卸载向导' : '无法启动 Windows Installer'
    }
  }

  const executable = extractExe(command)
  if (!executable || !/^[a-z]:\\/i.test(executable) || path.extname(executable).toLowerCase() !== '.exe') {
    return { launched: false, openedSettings: false, message: '卸载程序路径无效，请改用 Windows 应用设置' }
  }
  try {
    const stat = await fs.lstat(executable)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { launched: false, openedSettings: false, message: '卸载程序不是可信的本地可执行文件' }
    }
  } catch {
    return { launched: false, openedSettings: false, message: '卸载程序不存在，请改用 Windows 应用设置' }
  }
  const rest = command.trim().slice(command.trim().toLowerCase().indexOf('.exe') + 4).trim()
  const args = sanitizeUninstallArguments(splitWindowsArguments(rest))
  const launched = await spawnDetached(executable, args)
  return {
    launched,
    openedSettings: false,
    message: launched ? '已打开应用自己的卸载程序' : '无法启动应用自己的卸载程序'
  }
}
