import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDuplicateGroupSurvivors, scanDuplicateFiles, verifyDuplicateFileSnapshot } from './duplicates'

describe('exact duplicate file scanning', () => {
  it('uses full content hashes and ignores same-size files with different content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-duplicates-'))
    try {
      const repeated = Buffer.alloc(1024 * 1024, 7)
      await Promise.all([
        fs.writeFile(path.join(root, 'copy-a.mp4'), repeated),
        fs.writeFile(path.join(root, 'copy-b.mp4'), repeated),
        fs.writeFile(path.join(root, 'same-size-but-different.mp4'), Buffer.alloc(1024 * 1024, 8))
      ])
      const realRoot = await fs.realpath(root)
      const { result, internal } = await scanDuplicateFiles(
        { cancelled: false },
        () => {},
        { roots: [{ lexicalRoot: root, realRoot, location: 'videos', cloudBacked: false }] }
      )

      expect(result.groups).toHaveLength(1)
      expect(result.groups[0].files.map((file) => file.name).sort()).toEqual(['copy-a.mp4', 'copy-b.mp4'])
      expect(result.reclaimableBytes).toBe(1024 * 1024)
      const duplicateIds = new Set(result.groups[0].files.map((file) => file.id))
      expect(() => getDuplicateGroupSurvivors(internal.values(), duplicateIds)).toThrow(/至少保留一份/)
      duplicateIds.delete(result.groups[0].files[0].id)
      expect(getDuplicateGroupSurvivors(internal.values(), duplicateIds).map((file) => file.id))
        .toEqual([result.groups[0].files[0].id])
      const snapshot = internal.get(result.groups[0].files[0].id)!
      expect(await verifyDuplicateFileSnapshot(snapshot)).toBe(true)
      await fs.writeFile(snapshot.path, Buffer.alloc(1024 * 1024, 9))
      expect(await verifyDuplicateFileSnapshot(snapshot)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('skips cloud-backed roots so hashing cannot hydrate online-only files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-cloud-'))
    try {
      await fs.writeFile(path.join(root, 'cloud-copy.mp4'), Buffer.alloc(1024 * 1024, 4))
      const realRoot = await fs.realpath(root)
      const { result } = await scanDuplicateFiles(
        { cancelled: false },
        () => {},
        { roots: [{ lexicalRoot: root, realRoot, location: 'onedrive', cloudBacked: true }] }
      )
      expect(result.groups).toHaveLength(0)
      expect(result.cloudFoldersSkipped).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
