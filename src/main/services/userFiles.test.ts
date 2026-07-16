import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InternalUserFile } from './userFiles'
import { verifyUserFileSnapshot } from './userFiles'

describe('personal file snapshot verification', () => {
  it('rejects a file that changed after scanning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-file-'))
    const filePath = path.join(root, 'document.pdf')
    try {
      await fs.writeFile(filePath, 'version one')
      const stat = await fs.lstat(filePath)
      const realPath = await fs.realpath(filePath)
      const snapshot: InternalUserFile = {
        id: 'test-id',
        kind: 'pdf',
        name: 'document.pdf',
        path: filePath,
        extension: '.pdf',
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        location: 'downloads',
        realPath,
        approvedLexicalRoot: root,
        approvedRealRoot: await fs.realpath(root),
        device: stat.dev,
        inode: stat.ino,
        modifiedMs: stat.mtimeMs
      }

      expect(await verifyUserFileSnapshot(snapshot)).toBe(true)
      await fs.writeFile(filePath, 'version two is different')
      expect(await verifyUserFileSnapshot(snapshot)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
