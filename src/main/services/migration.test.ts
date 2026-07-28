import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InternalUserFile } from './userFiles'
import {
  classifyMigrationCandidate,
  migrateOneFile,
  type InternalMigrationCandidate
} from './migration'

const sandboxes: string[] = []

async function sandbox(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  sandboxes.push(root)
  return root
}

async function sourceSnapshot(
  root: string,
  relative: string,
  location: InternalUserFile['location'] = 'downloads',
  cloudBacked = false,
  contents = Buffer.alloc(1024 * 1024, 7)
): Promise<InternalUserFile> {
  const filePath = path.join(root, relative)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents)
  const stat = await fs.lstat(filePath)
  return {
    id: 'candidate-id',
    kind: 'archive',
    name: path.basename(filePath),
    path: filePath,
    extension: path.extname(filePath),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    location,
    realPath: await fs.realpath(filePath),
    approvedLexicalRoot: root,
    approvedRealRoot: await fs.realpath(root),
    cloudBacked,
    linkCount: stat.nlink,
    device: stat.dev,
    inode: stat.ino,
    modifiedMs: stat.mtimeMs
  }
}

function candidate(source: InternalUserFile, destinationRoot: string): InternalMigrationCandidate {
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    path: source.path,
    extension: source.extension,
    bytes: source.bytes,
    modifiedAt: source.modifiedAt,
    location: source.location,
    confidence: 'recommended',
    reason: 'test',
    destinationPath: path.join(destinationRoot, '下载', source.name),
    source
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (sandboxes.length > 0) {
    await fs.rm(sandboxes.pop()!, { recursive: true, force: true })
  }
})

describe('migration candidate classification', () => {
  it('recommends large independent downloads', async () => {
    const root = await sandbox('jingpan-migration-source-')
    const file = await sourceSnapshot(root, 'archive.zip')
    expect(classifyMigrationCandidate(file)).toEqual({
      confidence: 'recommended',
      reason: '下载目录中的独立文件，迁移后可直接从 D 盘打开'
    })
  })

  it('rejects cloud-backed and application-managed files', async () => {
    const root = await sandbox('jingpan-migration-source-')
    const cloud = await sourceSnapshot(root, 'cloud.zip', 'downloads', true)
    const chat = await sourceSnapshot(root, path.join('WeChat Files', 'chat.zip'))
    expect(classifyMigrationCandidate(cloud)).toBeNull()
    expect(classifyMigrationCandidate(chat)).toBeNull()
  })

  it('marks desktop and documents as review candidates', async () => {
    const root = await sandbox('jingpan-migration-source-')
    const desktop = await sourceSnapshot(root, 'desktop.zip', 'desktop')
    const document = await sourceSnapshot(root, 'document.zip', 'documents')
    expect(classifyMigrationCandidate(desktop)?.confidence).toBe('review')
    expect(classifyMigrationCandidate(document)?.confidence).toBe('review')
  })
})

describe('verified migration transaction', () => {
  it('keeps only the verified destination after a successful move', async () => {
    const sourceRoot = await sandbox('jingpan-migration-source-')
    const destinationRoot = await sandbox('jingpan-migration-destination-')
    const source = await sourceSnapshot(sourceRoot, 'photo.zip')
    const result = await migrateOneFile(candidate(source, destinationRoot), destinationRoot)

    await expect(fs.lstat(source.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(result.destinationPath)).toEqual(Buffer.alloc(1024 * 1024, 7))
    expect(result.sourceRemoved).toBe(true)
  })

  it('deletes the D-drive copy when removing the C-drive source fails', async () => {
    const sourceRoot = await sandbox('jingpan-migration-source-')
    const destinationRoot = await sandbox('jingpan-migration-destination-')
    const source = await sourceSnapshot(sourceRoot, 'locked.zip')
    const originalUnlink = fs.unlink.bind(fs)
    vi.spyOn(fs, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
      .mockImplementation(originalUnlink)

    await expect(migrateOneFile(candidate(source, destinationRoot), destinationRoot))
      .rejects.toThrow('已回滚 D 盘副本')
    expect(await fs.readFile(source.path)).toEqual(Buffer.alloc(1024 * 1024, 7))
    const destinationDirectory = path.join(destinationRoot, '下载')
    expect(await fs.readdir(destinationDirectory)).toEqual([])
  })
})
