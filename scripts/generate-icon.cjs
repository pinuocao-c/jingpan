const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = path.join(root, 'resources', 'icon.svg')
const output = path.join(root, 'resources', 'icon.png')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    webPreferences: { sandbox: true }
  })

  await win.loadFile(source)
  const image = await win.webContents.capturePage()
  fs.writeFileSync(output, image.toPNG({ scaleFactor: 1 }))
  console.log(`Generated ${output}`)
  win.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
