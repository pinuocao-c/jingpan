import type { UserFileLocation } from '../../shared/types'
import { runPowerShellJson } from './powershell'

export type KnownFolderLocation = Extract<
  UserFileLocation,
  'desktop' | 'downloads' | 'documents' | 'pictures' | 'videos' | 'music'
>

type KnownFolderPayload = Partial<Record<KnownFolderLocation, unknown>>

const KNOWN_FOLDER_SCRIPT = String.raw`
$folders = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
function Expand-Folder([object]$Value) {
  if ($null -eq $Value) { return '' }
  return [Environment]::ExpandEnvironmentVariables([string]$Value)
}
[PSCustomObject]@{
  desktop = Expand-Folder $folders.Desktop
  downloads = Expand-Folder $folders.'{374DE290-123F-4565-9164-39C4925E467B}'
  documents = Expand-Folder $folders.Personal
  pictures = Expand-Folder $folders.'My Pictures'
  videos = Expand-Folder $folders.'My Video'
  music = Expand-Folder $folders.'My Music'
} | ConvertTo-Json -Compress
`

const LOCATIONS: KnownFolderLocation[] = [
  'desktop',
  'downloads',
  'documents',
  'pictures',
  'videos',
  'music'
]

export function parseKnownFolderPayload(payload: KnownFolderPayload): Partial<Record<KnownFolderLocation, string>> {
  const result: Partial<Record<KnownFolderLocation, string>> = {}
  for (const location of LOCATIONS) {
    const value = payload[location]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 1_024 || !/^(?:[a-z]:\\|\\\\)/i.test(trimmed)) continue
    result[location] = trimmed
  }
  return result
}

export async function getKnownFolderPaths(): Promise<Partial<Record<KnownFolderLocation, string>>> {
  try {
    return parseKnownFolderPayload(await runPowerShellJson<KnownFolderPayload>(KNOWN_FOLDER_SCRIPT))
  } catch {
    return {}
  }
}
