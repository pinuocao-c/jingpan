import { runPowerShellJson } from './powershell'
import { getSystemDrive } from './system'

interface RecycleBinSummary {
  bytes?: number
  files?: number
  inaccessible?: number
}

export async function scanCurrentUserRecycleBin(): Promise<{
  bytes: number
  files: number
  inaccessible: number
}> {
  const drive = getSystemDrive()
  const script = String.raw`
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root = Join-Path '${drive}\' ('$Recycle.Bin\' + $sid)
$bytes = [long]0
$files = [long]0
$inaccessible = [long]0
if (Test-Path -LiteralPath $root) {
  Get-ChildItem -LiteralPath $root -Force -File -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
      $bytes += [long]$_.Length
      $files += 1
    }
}
[PSCustomObject]@{
  bytes = $bytes
  files = $files
  inaccessible = $inaccessible
} | ConvertTo-Json -Compress
`
  try {
    const result = await runPowerShellJson<RecycleBinSummary>(script)
    return {
      bytes: Math.max(0, Number(result.bytes ?? 0)),
      files: Math.max(0, Number(result.files ?? 0)),
      inaccessible: Math.max(0, Number(result.inaccessible ?? 0))
    }
  } catch {
    return { bytes: 0, files: 0, inaccessible: 1 }
  }
}
