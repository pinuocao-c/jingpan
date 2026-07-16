import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cleanTarget, createPathBoundary, isPathInside } from './filesystem'

describe('isPathInside', () => {
  it('accepts descendants of the approved root', () => {
    expect(isPathInside('C:\\Users\\Test\\Downloads', 'C:\\Users\\Test\\Downloads\\setup.msi')).toBe(true)
    expect(isPathInside('C:\\Users\\Test\\Downloads', 'C:\\Users\\Test\\Downloads\\folder\\file.pdf')).toBe(true)
  })

  it('rejects the root itself and sibling-prefix paths', () => {
    expect(isPathInside('C:\\Temp', 'C:\\Temp')).toBe(false)
    expect(isPathInside('C:\\Temp', 'C:\\Temporary\\file.txt')).toBe(false)
  })

  it('rejects traversal outside an approved root', () => {
    const root = path.resolve('C:\\Users\\Test\\Downloads')
    expect(isPathInside(root, path.resolve(root, '..', 'Documents', 'private.docx'))).toBe(false)
  })
})

describe('filesystem boundary enforcement', () => {
  it.runIf(process.platform === 'win32')('refuses a cleanup root that is a directory junction', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-root-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-outside-'))
    const linkedRoot = path.join(sandbox, 'linked')
    try {
      await fs.symlink(outside, linkedRoot, 'junction')
      expect(await createPathBoundary(linkedRoot)).toBeNull()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('does not follow a nested junction while cleaning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-clean-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-safe-'))
    const protectedFile = path.join(outside, 'keep.txt')
    try {
      await fs.writeFile(protectedFile, 'must remain')
      await fs.symlink(outside, path.join(root, 'linked-outside'), 'junction')
      await cleanTarget({ root }, { cancelled: false })
      expect(await fs.readFile(protectedFile, 'utf8')).toBe('must remain')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
