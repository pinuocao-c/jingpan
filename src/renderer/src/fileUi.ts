export type FileSortKey = 'size' | 'date' | 'name'
export type SortDirection = 'asc' | 'desc'

export interface SortableFile {
  name: string
  bytes: number
  modifiedAt: string
}

export function compareFiles(
  left: SortableFile,
  right: SortableFile,
  key: FileSortKey,
  direction: SortDirection
): number {
  const value = key === 'size'
    ? left.bytes - right.bytes
    : key === 'date'
      ? new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime()
      : left.name.localeCompare(right.name, 'zh-CN')
  return direction === 'asc' ? value : -value
}

export function formatScanAge(scannedAt: string, now = Date.now()): string {
  const scanned = new Date(scannedAt).getTime()
  if (!Number.isFinite(scanned)) return '扫描时间未知'
  const elapsedMinutes = Math.max(0, Math.floor((now - scanned) / 60_000))
  if (elapsedMinutes < 1) return '刚刚扫描'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前扫描`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时前扫描`
  return `${Math.floor(elapsedHours / 24)} 天前扫描`
}

export function isScanStale(scannedAt: string, now = Date.now(), staleAfterMinutes = 30): boolean {
  const scanned = new Date(scannedAt).getTime()
  return Number.isFinite(scanned) && now - scanned >= staleAfterMinutes * 60_000
}
