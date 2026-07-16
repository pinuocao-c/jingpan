import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration } from './format'

describe('display formatting', () => {
  it('formats byte values for non-technical users', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })

  it('formats task durations compactly', () => {
    expect(formatDuration(500)).toBe('不到 1 秒')
    expect(formatDuration(12_000)).toBe('12 秒')
    expect(formatDuration(75_000)).toBe('1 分 15 秒')
  })
})
