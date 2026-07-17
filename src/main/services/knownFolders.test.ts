import { describe, expect, it } from 'vitest'
import { parseKnownFolderPayload } from './knownFolders'

describe('Windows known folder parsing', () => {
  it('accepts local and UNC folders while rejecting malformed values', () => {
    expect(parseKnownFolderPayload({
      desktop: 'C:\\Users\\Example\\Desktop',
      downloads: 'D:\\Downloads',
      documents: '\\\\server\\share\\Documents',
      pictures: 'relative\\Pictures',
      videos: '',
      music: 42
    })).toEqual({
      desktop: 'C:\\Users\\Example\\Desktop',
      downloads: 'D:\\Downloads',
      documents: '\\\\server\\share\\Documents'
    })
  })
})
