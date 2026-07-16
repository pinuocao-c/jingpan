import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runPowerShellJson<T>(script: string): Promise<T> {
  const utf8Bootstrap = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)'
  ].join('; ')
  const encoded = Buffer.from(`${utf8Bootstrap}; ${script}`, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  const text = stdout.trim()
  return (text ? JSON.parse(text) : []) as T
}
