import { describe, expect, it } from 'vitest'
import { compareFiles, formatScanAge, isScanStale } from './fileUi'

const files = [
  { name: '乙.txt', bytes: 20, modifiedAt: '2026-01-02T00:00:00.000Z' },
  { name: '甲.txt', bytes: 10, modifiedAt: '2026-01-01T00:00:00.000Z' }
]

describe('file browser helpers', () => {
  it('sorts files in both directions', () => {
    expect([...files].sort((a, b) => compareFiles(a, b, 'size', 'asc'))[0].bytes).toBe(10)
    expect([...files].sort((a, b) => compareFiles(a, b, 'date', 'desc'))[0].modifiedAt).toContain('01-02')
    expect([...files].sort((a, b) => compareFiles(a, b, 'name', 'asc'))[0].name).toBe('甲.txt')
  })

  it('formats scan age and marks old results', () => {
    const now = new Date('2026-08-08T10:00:00.000Z').getTime()
    expect(formatScanAge('2026-08-08T09:55:00.000Z', now)).toBe('5 分钟前扫描')
    expect(isScanStale('2026-08-08T09:31:00.000Z', now)).toBe(false)
    expect(isScanStale('2026-08-08T09:30:00.000Z', now)).toBe(true)
  })
})
