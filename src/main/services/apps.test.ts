import { describe, expect, it } from 'vitest'
import { sanitizeUninstallArguments } from './apps'

describe('uninstall argument safety', () => {
  it('removes common silent uninstall switches', () => {
    expect(sanitizeUninstallArguments([
      '--uninstall',
      '/S',
      '/VERYSILENT',
      '/qn',
      '--quiet',
      '/NORESTART'
    ])).toEqual(['--uninstall'])
  })

  it('preserves interactive arguments needed by vendor uninstallers', () => {
    expect(sanitizeUninstallArguments([
      '--uninstall',
      '--system-level',
      '_?=C:\\Program Files\\Example'
    ])).toEqual([
      '--uninstall',
      '--system-level',
      '_?=C:\\Program Files\\Example'
    ])
  })
})
