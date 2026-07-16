import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import type { DiskSummary } from '../../shared/types'

const execFileAsync = promisify(execFile)

export function getSystemDrive(): string {
  const candidate = process.env.SystemDrive ?? 'C:'
  return /^[a-z]:$/i.test(candidate) ? candidate.toUpperCase() : 'C:'
}

export async function getDiskSummary(): Promise<DiskSummary> {
  const drive = getSystemDrive()
  const stats = await fs.statfs(`${drive}\\`)
  const totalBytes = stats.blocks * stats.bsize
  const freeBytes = stats.bavail * stats.bsize
  return {
    drive,
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes)
  }
}

export async function isRunningAsAdministrator(): Promise<boolean> {
  try {
    await execFileAsync('net.exe', ['session'], { windowsHide: true, timeout: 4_000 })
    return true
  } catch {
    return false
  }
}
