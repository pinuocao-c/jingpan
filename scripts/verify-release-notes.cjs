const fs = require('node:fs')
const path = require('node:path')

const notesPath = path.resolve(process.argv[2] || 'RELEASE_NOTES.md')
const notes = fs.readFileSync(notesPath, 'utf8')
const cjkCharacters = notes.match(/[\u3400-\u9fff]/g) ?? []

if (notes.includes('\uFFFD')) {
  throw new Error('Release notes contain Unicode replacement characters.')
}

if (/\?{4,}/.test(notes)) {
  throw new Error('Release notes contain a suspicious run of question marks.')
}

if (cjkCharacters.length < 20) {
  throw new Error('Release notes do not contain the expected Chinese content.')
}

console.log(`Release notes encoding verified: ${notesPath}`)
