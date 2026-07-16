import { describe, expect, it } from 'vitest'
import { compareVersions, evaluateLatestRelease } from './updates'

function releaseFixture(version = '0.1.2'): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    name: `净盘 v${version}`,
    body: '更新说明',
    html_url: `https://github.com/pinuocao-c/jingpan/releases/tag/v${version}`,
    published_at: '2026-07-16T12:00:00Z',
    draft: false,
    prerelease: false,
    assets: [{
      name: `Jingpan-${version}-x64.exe`,
      size: 100_000_000,
      digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: `https://github.com/pinuocao-c/jingpan/releases/download/v${version}/Jingpan-${version}-x64.exe`,
      state: 'uploaded'
    }]
  }
}

describe('update version comparison', () => {
  it('compares numeric version parts instead of text', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1)
  })
})

describe('GitHub release validation', () => {
  it('accepts the expected official installer', () => {
    const result = evaluateLatestRelease('0.1.1', releaseFixture())
    expect(result.status).toBe('available')
    expect(result.downloadAvailable).toBe(true)
    expect(result.downloadUrl).toContain('/pinuocao-c/jingpan/releases/download/v0.1.2/')
  })

  it('rejects installer links from another host', () => {
    const fixture = releaseFixture()
    const assets = fixture.assets as Array<Record<string, unknown>>
    assets[0].browser_download_url = 'https://example.com/Jingpan-0.1.2-x64.exe'
    const result = evaluateLatestRelease('0.1.1', fixture)
    expect(result.status).toBe('available')
    expect(result.downloadAvailable).toBe(false)
    expect(result.downloadUrl).toBeNull()
  })

  it('rejects a different file hidden behind an official release path', () => {
    const fixture = releaseFixture()
    const assets = fixture.assets as Array<Record<string, unknown>>
    assets[0].browser_download_url = 'https://github.com/pinuocao-c/jingpan/releases/download/v0.1.2/not-the-installer.exe'
    const result = evaluateLatestRelease('0.1.1', fixture)
    expect(result.status).toBe('available')
    expect(result.downloadAvailable).toBe(false)
    expect(result.downloadUrl).toBeNull()
  })

  it('does not offer an older or equal release', () => {
    const result = evaluateLatestRelease('0.1.2', releaseFixture())
    expect(result.status).toBe('current')
    expect(result.downloadAvailable).toBe(false)
  })
})
