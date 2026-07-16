import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyChatFile, scanChatFiles } from './chatFiles'

describe('chat file classification', () => {
  it('classifies office documents, media and installers', () => {
    expect(classifyChatFile('方案.docx', 'file', 'wechat')).toEqual({ kind: 'word', previewable: true })
    expect(classifyChatFile('演示.pptx', 'attachment', 'qq')).toEqual({ kind: 'powerpoint', previewable: true })
    expect(classifyChatFile('视频.mp4', 'video', 'wechat')).toEqual({ kind: 'video', previewable: true })
    expect(classifyChatFile('应用.apk', 'file', 'qq')).toEqual({ kind: 'installer', previewable: false })
  })

  it('lists encrypted WeChat images without pretending they can be previewed', () => {
    expect(classifyChatFile('abc123.dat', 'image', 'wechat')).toEqual({ kind: 'image', previewable: false })
    expect(classifyChatFile('abc123.dat', 'image', 'qq')).toBeUndefined()
  })

  it('does not expose chat databases as removable files', () => {
    expect(classifyChatFile('message.db', 'file', 'wechat')).toBeUndefined()
    expect(classifyChatFile('message.db-wal', 'attachment', 'qq')).toBeUndefined()
  })

  it('keeps unknown received attachments visible but non-previewable', () => {
    expect(classifyChatFile('工程图.dwg', 'file', 'qq')).toEqual({ kind: 'other', previewable: false })
  })
})

describe('chat storage discovery', () => {
  it('discovers WeChat and QQ attachments while excluding message databases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jingpan-chat-'))
    const documents = path.join(root, 'Documents')
    try {
      const wechatFile = path.join(documents, 'WeChat Files', 'wxid_test', 'FileStorage', 'File', '方案.docx')
      const wechatImage = path.join(documents, 'WeChat Files', 'wxid_test', 'FileStorage', 'Image', '2026-01', 'image.dat')
      const wechatDatabase = path.join(documents, 'WeChat Files', 'wxid_test', 'FileStorage', 'File', 'message.db')
      const qqFile = path.join(documents, 'Tencent Files', '12345678', 'FileRecv', '演示.pptx')
      await fs.mkdir(path.dirname(wechatFile), { recursive: true })
      await fs.mkdir(path.dirname(wechatImage), { recursive: true })
      await fs.mkdir(path.dirname(qqFile), { recursive: true })
      await Promise.all([
        fs.writeFile(wechatFile, 'document'),
        fs.writeFile(wechatImage, 'encrypted image'),
        fs.writeFile(wechatDatabase, 'database'),
        fs.writeFile(qqFile, 'presentation')
      ])

      const { result } = await scanChatFiles(
        { cancelled: false },
        () => {},
        { documentRoots: [documents] }
      )
      expect(result.files).toHaveLength(3)
      expect(result.accounts).toHaveLength(2)
      expect(result.files.some((file) => file.name === 'message.db')).toBe(false)
      expect(result.files.find((file) => file.name === 'image.dat')).toMatchObject({
        platform: 'wechat',
        kind: 'image',
        previewable: false
      })
      expect(result.files.find((file) => file.name === '演示.pptx')).toMatchObject({
        platform: 'qq',
        kind: 'powerpoint',
        previewable: true
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
