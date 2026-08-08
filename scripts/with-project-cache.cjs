const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const cacheRoot = path.join(root, '.cache')
const directories = {
  npm: path.join(cacheRoot, 'npm'),
  electron: path.join(cacheRoot, 'electron'),
  builder: path.join(cacheRoot, 'electron-builder'),
  temp: path.join(cacheRoot, 'temp')
}

for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true })

const [command, ...args] = process.argv.slice(2)
if (!command) {
  process.stderr.write('Missing command.\n')
  process.exit(2)
}

const result = spawnSync(command, args, {
  cwd: root,
  env: {
    ...process.env,
    npm_config_cache: directories.npm,
    ELECTRON_CACHE: directories.electron,
    ELECTRON_BUILDER_CACHE: directories.builder,
    TEMP: directories.temp,
    TMP: directories.temp
  },
  shell: process.platform === 'win32',
  stdio: 'inherit'
})

if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(1)
}

process.exit(result.status ?? 1)
