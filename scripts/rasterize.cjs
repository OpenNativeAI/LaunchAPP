// 用 Electron 离屏渲染把 windows.svg 光栅化成多尺寸 PNG 图标
// 策略：单个 1024x1024 离屏窗口渲染一次，截图后缩放出各尺寸
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SVG = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'windows.svg')
const OUT = path.join(__dirname, 'icon-out')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const RENDER = 1024

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const svg = fs
    .readFileSync(SVG, 'utf8')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
  const htmlFile = path.join(os.tmpdir(), 'launchapp-icon-render.html')
  fs.writeFileSync(
    htmlFile,
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
      `svg{display:block;width:${RENDER}px;height:${RENDER}px}</style></head><body>${svg}</body></html>`,
    'utf8'
  )
  const win = new BrowserWindow({
    width: RENDER,
    height: RENDER,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  await win.loadFile(htmlFile)
  await new Promise((r) => setTimeout(r, 400))
  const big = await win.webContents.capturePage()
  for (const size of SIZES) {
    const img = size === RENDER ? big : big.resize({ width: size, height: size })
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), img.toPNG())
    console.log(`OK ${size}x${size}`)
  }
  win.destroy()
  app.quit()
})
