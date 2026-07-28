const path = require('node:path')
const fs = require('node:fs')
const { _electron: electron } = require('playwright')

async function main() {
  const root = path.resolve(__dirname, '..')
  const output = path.join(root, 'release', 'ui-qa-webgl')
  fs.mkdirSync(output, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const packaged = process.argv.includes('--packaged')
  const app = await electron.launch({
    executablePath: packaged
      ? path.join(root, 'release', 'win-unpacked', '净盘.exe')
      : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: packaged ? [] : ['.'],
    cwd: root,
    env
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1260, height: 940 })
    await page.waitForTimeout(2_300)

    const audit = await page.evaluate(() => {
      const read = (selector) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`)
        const style = getComputedStyle(element)
        return {
          selector,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderColor: style.borderTopColor,
          boxShadow: style.boxShadow,
          before: getComputedStyle(element, '::before').content,
          after: getComputedStyle(element, '::after').content
        }
      }
      const canvas = document.querySelector('.liquid-glass-canvas')
      return {
        renderer: document.documentElement.dataset.glassRenderer,
        fallback: document.documentElement.dataset.glassFallback ?? null,
        canvas: canvas instanceof HTMLCanvasElement
          ? { width: canvas.width, height: canvas.height }
          : null,
        surfaces: [
          read('.hero-card'),
          read('.metric-card'),
          read('.content-card'),
          read('.sidebar nav button')
        ],
        disk: read('.disk-ring')
      }
    })

    if (audit.renderer !== 'webgl2' || audit.fallback) {
      throw new Error(`WebGL material unavailable: ${JSON.stringify(audit)}`)
    }
    for (const surface of audit.surfaces) {
      if (
        surface.backgroundColor !== 'rgba(0, 0, 0, 0)'
        || surface.backgroundImage !== 'none'
        || surface.boxShadow !== 'none'
      ) {
        throw new Error(`DOM underlay still visible: ${JSON.stringify(surface)}`)
      }
    }
    if (audit.surfaces[0].before !== 'none' || audit.surfaces[0].after !== 'none') {
      throw new Error(`Hero contains a second decorative layer: ${JSON.stringify(audit.surfaces[0])}`)
    }

    await page.mouse.move(930, 360)
    await page.waitForTimeout(260)
    await page.screenshot({ path: path.join(output, 'overview-solid-glass.png') })

    const action = page.locator('.action-list button').nth(1)
    await action.hover()
    await page.waitForTimeout(220)
    const hoverTransform = await action.evaluate((element) => getComputedStyle(element).transform)
    if (hoverTransform === 'none') throw new Error('Overview action hover motion is missing')
    await page.screenshot({ path: path.join(output, 'overview-hover.png') })

    await page.getByRole('button', { name: /智能迁移/ }).click()
    await page.waitForTimeout(420)
    const migrationSurface = await page.evaluate(() => {
      const element = document.querySelector('.migration-safety')
      if (!(element instanceof HTMLElement)) throw new Error('migration surface missing')
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow
      }
    })
    if (
      migrationSurface.backgroundColor !== 'rgba(0, 0, 0, 0)'
      || migrationSurface.backgroundImage !== 'none'
      || migrationSurface.boxShadow !== 'none'
    ) {
      throw new Error(`Migration glass has a DOM underlay: ${JSON.stringify(migrationSurface)}`)
    }
    await page.mouse.move(740, 305)
    await page.waitForTimeout(220)
    await page.screenshot({ path: path.join(output, 'migration-empty.png') })

    let migrationScan = null
    if (process.argv.includes('--scan-migration')) {
      await page.getByRole('button', { name: '开始识别', exact: true }).click()
      await page.locator('.overlay').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(350)
      const progressSurface = await page.evaluate(() => {
        const dialog = document.querySelector('.progress-dialog')
        if (!(dialog instanceof HTMLElement)) throw new Error('progress dialog missing')
        const style = getComputedStyle(dialog)
        const overlay = getComputedStyle(document.querySelector('.overlay'))
        return {
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
          backdropFilter: style.backdropFilter,
          overlayBackdropFilter: overlay.backdropFilter
        }
      })
      await page.screenshot({ path: path.join(output, 'migration-scan-progress.png') })
      await page.locator('.overlay').waitFor({ state: 'detached', timeout: 240_000 })
      await page.waitForTimeout(500)
      migrationScan = {
        ...await page.evaluate(() => ({
          summary: [...document.querySelectorAll('.migration-summary > div')].map((item) => item.textContent?.trim()),
          rows: document.querySelectorAll('.migration-row').length,
          selected: document.querySelector('.migration-action')?.textContent?.trim() ?? null
        })),
        progressSurface
      }
      await page.screenshot({ path: path.join(output, 'migration-scanned.png') })
    }

    let fileThumbnailAudit = null
    if (process.argv.includes('--scan-files')) {
      await page.getByRole('button', { name: /^个人文件/ }).click()
      await page.waitForTimeout(420)
      await page.getByRole('button', { name: '扫描个人文件', exact: true }).click()
      await page.locator('.overlay').waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator('.overlay').waitFor({ state: 'detached', timeout: 240_000 })
      await page.locator('.file-row').first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(2_500)
      fileThumbnailAudit = await page.evaluate(() => ({
        previewableRows: document.querySelectorAll('.file-thumbnail[data-kind="image"], .file-thumbnail[data-kind="video"]').length,
        loadedThumbnails: document.querySelectorAll('.file-thumbnail.has-preview img').length,
        imageThumbnails: document.querySelectorAll('.file-thumbnail[data-kind="image"].has-preview img').length,
        videoThumbnails: document.querySelectorAll('.file-thumbnail[data-kind="video"].has-preview img').length,
        sample: (() => {
          const thumbnail = document.querySelector('.file-thumbnail[data-kind="image"], .file-thumbnail[data-kind="video"]')
          return thumbnail instanceof HTMLElement
            ? {
                id: thumbnail.dataset.fileId ?? null,
                scope: thumbnail.dataset.thumbnailScope ?? null,
                path: thumbnail.parentElement?.querySelector('small')?.textContent ?? null
              }
            : null
        })()
      }))
      if (fileThumbnailAudit.previewableRows > 0 && fileThumbnailAudit.loadedThumbnails === 0) {
        const direct = await page.evaluate(async ({ sample }) => {
          if (!sample?.id || !sample.scope) return { resultLength: 0, error: 'missing sample identity' }
          try {
            const result = await window.jingpan.getFileThumbnail(sample.scope, sample.id)
            return { resultLength: result?.length ?? 0, error: null }
          } catch (error) {
            return { resultLength: 0, error: error instanceof Error ? error.message : String(error) }
          }
        }, { sample: fileThumbnailAudit.sample })
        throw new Error(`Visible image/video rows did not load thumbnails: ${JSON.stringify({ fileThumbnailAudit, direct })}`)
      }
      await page.screenshot({ path: path.join(output, 'personal-file-thumbnails.png') })

      const imageTab = page.locator('.file-kind-tabs button').filter({ hasText: '图片' }).first()
      await imageTab.click()
      await page.waitForTimeout(2_500)
      const loadedImageThumbnails = await page.locator('.file-thumbnail[data-kind="image"].has-preview img').count()
      if (loadedImageThumbnails === 0) {
        throw new Error('Visible image rows did not load Windows image thumbnails')
      }
      fileThumbnailAudit.loadedImageTabThumbnails = loadedImageThumbnails
      await page.screenshot({ path: path.join(output, 'personal-image-thumbnails.png') })
    }

    await page.getByRole('button', { name: /设置与帮助/ }).click()
    await page.waitForTimeout(380)
    const setting = page.locator('.settings-list > div').nth(3)
    await setting.hover()
    await page.waitForTimeout(220)
    const settingTransform = await setting.evaluate((element) => getComputedStyle(element).transform)
    if (settingTransform === 'none') throw new Error('Settings option hover motion is missing')
    await page.screenshot({ path: path.join(output, 'settings-hover.png') })

    console.log(JSON.stringify({
      audit,
      hoverTransform,
      settingTransform,
      reducedMotion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      migrationSurface,
      migrationScan,
      fileThumbnailAudit,
      output
    }, null, 2))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
