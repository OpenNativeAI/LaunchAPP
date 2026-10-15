import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  protocol,
  net,
  screen,
  Tray,
  Menu,
  globalShortcut
} from 'electron'
import { execFile, spawn } from 'child_process'
import { uIOhook } from 'uiohook-napi'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { scanApps, clearIconCache, getIconsDir, type AppInfo } from './scanner'
import { uninstallApp, removeShortcut, type UninstallResult } from './uninstall'
import { fetchLinkMeta, normalizeUrl } from './links'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appicon',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let currentShortcut: string | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function getDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

function getSettingsFile(): string {
  return join(getDataDir(), 'launchapp-settings.json')
}

// ===== 网址(website)独立存储：data/website/ 下三个 jsonl =====
function getWebsiteDir(): string {
  return join(getDataDir(), 'website')
}
function getWebsiteFile(name: string): string {
  return join(getWebsiteDir(), name)
}
/** 数组序列化为 JSON Lines（每行一个对象） */
function toLines(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}
/** 读取 JSON Lines，文件不存在返回空数组 */
async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}
/** 解析分类池键（{app,link}），异常时给空池 */
function parseCats(raw?: string): { app: string[]; link: string[] } {
  try {
    const c = JSON.parse(raw || '{}') as Record<string, unknown>
    return {
      app: Array.isArray(c.app) ? (c.app as string[]) : [],
      link: Array.isArray(c.link) ? (c.link as string[]) : []
    }
  } catch {
    return { app: [], link: [] }
  }
}
/** 解析条目分类映射（key -> 单个分类），异常时给空表 */
function parseApptags(raw?: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || '{}')
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const k of Object.keys(v)) if (typeof v[k] === 'string') out[k] = v[k]
    return out
  } catch {
    return {}
  }
}

/** 把旧的 userData 根目录下的自有数据迁移到 userData/data 子文件夹 */
async function migrateLegacyStorage(): Promise<void> {
  const ud = app.getPath('userData')
  const dataDir = getDataDir()
  await fs.mkdir(dataDir, { recursive: true })
  const newJson = getSettingsFile()
  try {
    await fs.access(newJson)
  } catch {
    try {
      await fs.rename(join(ud, 'launchapp-settings.json'), newJson)
    } catch {
      /* 无旧设置文件 */
    }
  }
  const newIcons = join(dataDir, 'icons')
  try {
    await fs.access(newIcons)
  } catch {
    try {
      await fs.rename(join(ud, 'icons'), newIcons)
    } catch {
      /* 无旧图标目录 */
    }
  }
}

async function captureWallpaper(): Promise<string> {
  try {
    const display = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: display.size.width * display.scaleFactor,
        height: display.size.height * display.scaleFactor
      }
    })
    const target = sources.find((s) => s.display_id === String(display.id)) || sources[0]
    return target ? target.thumbnail.toDataURL() : ''
  } catch {
    return ''
  }
}

function splitArgs(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}

async function fallbackLaunch(info: AppInfo): Promise<void> {
  // 用系统 shell 打开 .lnk 快捷方式（处理非 exe / Store 应用等）
  const err = await shell.openPath(info.lnk)
  if (!err) return
  const ps = `Start-Process -FilePath '${info.lnk.replace(/'/g, "''")}'`
  await new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
      (e) => (e ? reject(e) : resolve())
    )
  })
}

async function launchApp(info: AppInfo): Promise<void> {
  // 最快路径：直接 CreateProcess 拉起目标 exe，绕过快捷方式解析与 PowerShell
  if (info.target && /.exe$/i.test(info.target)) {
    try {
      const child = spawn(info.target, splitArgs(info.args || ''), {
        cwd: info.workdir || undefined,
        detached: true,
        stdio: 'ignore'
      })
      child.on('error', () => void fallbackLaunch(info))
      child.unref()
      return
    } catch {
      /* fall through to shell fallback */
    }
  }
  await fallbackLaunch(info)
}

async function statSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return 0
  }
}

async function dirStats(dir: string): Promise<{ count: number; size: number }> {
  let count = 0
  let size = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile()) {
        count += 1
        size += await statSize(join(dir, e.name))
      }
    }
  } catch {
    /* 目录不存在时按 0 处理 */
  }
  return { count, size }
}

async function showWindow(): Promise<void> {
  if (!mainWindow) createWindow()
  if (!mainWindow) return
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.show()
  mainWindow.moveTop()
  mainWindow.focus()
  // 通知渲染层窗口已重新唤起（用于按设置重新聚焦搜索框等）
  mainWindow.webContents.send('window:shown')
  const wallpaper = await captureWallpaper()
  if (wallpaper) mainWindow.webContents.send('wallpaper', wallpaper)
}

// uiohook 鼠标键编码：1 左 / 2 右 / 3 中 / 4 后退侧键 / 5 前进侧键
const MOUSE_BUTTON_CODES: Record<string, number> = {
  MouseMiddle: 3,
  MouseBack: 4,
  MouseForward: 5
}

let uiohookRunning = false
let uiohookListenerBound = false
let mouseButtonActive: number | null = null
// 录入模式：为 true 时，钩子把按下的鼠标键回报给渲染层，而不是触发唤起
let mouseCaptureActive = false

function ensureUiohook(): boolean {
  bindUiohookListener()
  if (uiohookRunning) return true
  try {
    uIOhook.start()
    uiohookRunning = true
    console.log('[LaunchApp] uiohook 鼠标钩子已启动')
    return true
  } catch (e) {
    console.error('[LaunchApp] uiohook 启动失败：' + (e instanceof Error ? e.message : String(e)))
    return false
  }
}

function bindUiohookListener(): void {
  if (uiohookListenerBound) return
  uIOhook.on('mousedown', (e) => {
    if (mouseCaptureActive) {
      mainWindow?.webContents.send('shortcut:mouse-captured', e.button)
      return
    }
    if (mouseButtonActive !== null && e.button === mouseButtonActive) toggleSummon()
  })
  uiohookListenerBound = true
}

// 返回 true=鼠标钩子已就绪（或无需钩子）；false=需要钩子但启动失败
function setMouseSummon(button: number | null): boolean {
  mouseButtonActive = button
  if (button === null) {
    if (uiohookRunning) {
      try {
        uIOhook.stop()
      } catch {
        /* ignore */
      }
      uiohookRunning = false
    }
    return true
  }
  return ensureUiohook()
}

function stopMouseSummon(): void {
  setMouseSummon(null)
}

function toggleSummon(): void {
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.webContents.send('window:hidden')
    mainWindow.setAlwaysOnTop(false)
    mainWindow.hide()
  } else {
    void showWindow()
  }
}

function registerShortcut(accel: string | null): boolean {
  globalShortcut.unregisterAll()
  currentShortcut = null
  if (!accel) {
    setMouseSummon(null)
    return true
  }
  const mb = MOUSE_BUTTON_CODES[accel]
  if (mb !== undefined) {
    const ok = setMouseSummon(mb)
    if (ok) currentShortcut = accel
    return ok
  }
  setMouseSummon(null)
  const ok = globalShortcut.register(accel, () => void showWindow())
  if (ok) currentShortcut = accel
  return ok
}

function createTray(): void {
  if (tray) return
  tray = new Tray(icon)
  tray.setToolTip('LaunchApp 启动器')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开启动器', click: () => void showWindow() },
      {
        label: '重新扫描应用',
        click: () => mainWindow?.webContents.send('apps:rescan')
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', () => void showWindow())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    // 唤起时置于所有窗口最上层；界面隐藏（启动应用/失焦/最小化）时不再遮挡
    alwaysOnTop: true,
    backgroundColor: '#1a1410',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      // 允许在无用户手势时播放音效（快捷键/托盘唤起界面时也响）
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  mainWindow.on('ready-to-show', async () => {
    const wallpaper = await captureWallpaper()
    mainWindow?.webContents.send('wallpaper', wallpaper)
    mainWindow?.show()
    // 首次出现也通知渲染层（用于播放"启动"音效）
    mainWindow?.webContents.send('window:shown')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => (mainWindow = null))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.launchapp')
  await migrateLegacyStorage()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  protocol.handle('appicon', async (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.slice(1) || url.host)
    const iconsDir = getIconsDir()
    const file = join(iconsDir, name)
    if (!file.startsWith(iconsDir)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })

  ipcMain.handle('apps:scan', async (e, force = false) => {
    if (force) await clearIconCache()
    const sender = e.sender
    return scanApps((done, total) => {
      sender.send('apps:progress', { done, total })
    })
  })

  ipcMain.handle('apps:launch', async (_e, info: AppInfo) => {
    await launchApp(info)
    return true
  })

  ipcMain.handle(
    'apps:uninstall',
    (_e, info: AppInfo): Promise<UninstallResult> => uninstallApp(info.name, info.lnk)
  )

  ipcMain.handle('apps:remove-shortcut', (_e, lnk: string): Promise<void> => removeShortcut(lnk))

  ipcMain.handle('links:fetch-meta', (_e, url: string) => fetchLinkMeta(url))

  ipcMain.handle('links:open', async (_e, url: string): Promise<boolean> => {
    const norm = normalizeUrl(url)
    if (!norm) return false
    await shell.openExternal(norm)
    return true
  })

  ipcMain.handle('store:read', async (): Promise<Record<string, string> | null> => {
    try {
      const raw = await fs.readFile(getSettingsFile(), 'utf8')
      const obj = JSON.parse(raw) as Record<string, string>
      // 把 website 文件夹里的网址数据重新合并回渲染层期望的键结构
      const cats = parseCats(obj['launchapp-cats'])
      const linkCats = (await readJsonl(getWebsiteFile('categories.jsonl')))
        .map((r) => (typeof r.name === 'string' ? r.name : ''))
        .filter(Boolean)
      obj['launchapp-cats'] = JSON.stringify({ app: cats.app, link: linkCats })

      const linkRows = await readJsonl(getWebsiteFile('links.jsonl'))
      const logoRows = await readJsonl(getWebsiteFile('logos.jsonl'))
      const logoMap: Record<string, string> = {}
      for (const r of logoRows) if (typeof r.id === 'string') logoMap[r.id] = String(r.data ?? '')
      const apptags = parseApptags(obj['launchapp-apptags'])
      const links = linkRows.map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        url: String(r.url ?? ''),
        icon: logoMap[String(r.id ?? '')] || '',
        plate: r.plate !== false
      }))
      for (const r of linkRows) {
        const cat = typeof r.cat === 'string' ? r.cat : ''
        if (cat && r.id) apptags['l:' + r.id] = cat
      }
      obj['launchapp-apptags'] = JSON.stringify(apptags)
      obj['launchapp-links'] = JSON.stringify(links)
      return obj
    } catch {
      return null
    }
  })

  ipcMain.handle('store:write', async (_e, data: Record<string, string>): Promise<boolean> => {
    // 允许渲染层所有自有持久化键（launchapp-* 前缀），避免新增功能时白名单漏掉导致不落盘
    const safe: Record<string, string> = {}
    for (const [k, v] of Object.entries(data ?? {})) {
      if (k.startsWith('launchapp-') && typeof v === 'string') safe[k] = v
    }
    // 网址数据分流到 data/website/ 的三个 jsonl，设置文件里不再保存
    const cats = parseCats(safe['launchapp-cats'])
    const apptags = parseApptags(safe['launchapp-apptags'])
    let links: { id: string; name: string; url: string; icon: string; plate?: boolean }[] = []
    try {
      const parsed = JSON.parse(safe['launchapp-links'] || '[]')
      if (Array.isArray(parsed)) links = parsed
    } catch {
      links = []
    }
    // 分类池 = 已声明池 ∪ 实际被条目使用的分类（自愈：只赋值未建池也不会漏写）
    const linkPool = new Set(cats.link)
    for (const l of links) {
      const c = apptags['l:' + l.id]
      if (c) linkPool.add(c)
    }
    const appPool = new Set(cats.app)
    for (const k of Object.keys(apptags)) {
      if (k.startsWith('a:') && apptags[k]) appPool.add(apptags[k])
    }
    // 设置文件：cats 只留 app 池，apptags 只留非 l: 键，去掉 links
    safe['launchapp-cats'] = JSON.stringify({ app: [...appPool], link: [] })
    const appTags: Record<string, string> = {}
    for (const k of Object.keys(apptags)) if (!k.startsWith('l:')) appTags[k] = apptags[k]
    safe['launchapp-apptags'] = JSON.stringify(appTags)
    delete safe['launchapp-links']

    const wdir = getWebsiteDir()
    await fs.mkdir(wdir, { recursive: true })
    const linkRows = links.map((l) => ({ id: l.id, name: l.name, url: l.url, cat: apptags['l:' + l.id] || '', plate: l.plate !== false }))
    const logoRows = links.map((l) => ({ id: l.id, data: l.icon || '' })).filter((r) => r.data)
    await fs.writeFile(getWebsiteFile('categories.jsonl'), toLines([...linkPool].map((n) => ({ name: n }))), 'utf8')
    await fs.writeFile(getWebsiteFile('links.jsonl'), toLines(linkRows), 'utf8')
    await fs.writeFile(getWebsiteFile('logos.jsonl'), toLines(logoRows), 'utf8')

    const file = getSettingsFile()
    await fs.mkdir(getDataDir(), { recursive: true })
    await fs.writeFile(file + '.tmp', JSON.stringify(safe), 'utf8')
    await fs.rename(file + '.tmp', file)
    return true
  })

  ipcMain.handle('storage:info', async () => {
    const dir = getDataDir()
    const iconsDir = getIconsDir()
    const settingsFile = getSettingsFile()
    const icons = await dirStats(iconsDir)
    return {
      dir,
      iconsDir,
      settingsFile,
      settingsSize: await statSize(settingsFile),
      iconsCount: icons.count,
      iconsSize: icons.size
    }
  })

  ipcMain.handle('storage:open', async (_e, target: 'root' | 'icons'): Promise<string> => {
    const dir = target === 'icons' ? getIconsDir() : getDataDir()
    return shell.openPath(dir)
  })

  ipcMain.on('window:hide', () => {
    // 先通知渲染层播放"收起"音效（窗口隐藏后渲染进程仍存活可发声）
    mainWindow?.webContents.send('window:hidden')
    mainWindow?.setAlwaysOnTop(false)
    mainWindow?.hide()
  })
  ipcMain.on('app:quit', () => app.quit())

  ipcMain.handle('shortcut:set', (_e, accel: string | null) => {
    if (accel && currentShortcut === accel) return true
    return registerShortcut(accel)
  })

  ipcMain.handle('shortcut:capture-start', () => {
    if (!ensureUiohook()) return false
    mouseCaptureActive = true
    return true
  })
  ipcMain.handle('shortcut:capture-stop', () => {
    mouseCaptureActive = false
    // 未配置鼠标唤起时，关掉钩子省资源
    if (!currentShortcut || MOUSE_BUTTON_CODES[currentShortcut] === undefined) {
      if (uiohookRunning) {
        try {
          uIOhook.stop()
        } catch {
          /* ignore */
        }
        uiohookRunning = false
      }
    }
    return true
  })

  ipcMain.handle('autolaunch:set', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    return true
  })

  app.on('second-instance', () => void showWindow())

  createTray()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  stopMouseSummon()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit()
  }
})
