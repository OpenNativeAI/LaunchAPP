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
import { scanApps, clearIconCache, type AppInfo } from './scanner'
import {
  uninstallApp,
  planUninstall,
  removeShortcut,
  openAppsSettings,
  type UninstallPlan,
  type UninstallResult
} from './uninstall'
import { fetchLinkMeta, normalizeUrl } from './links'
import { detectBrowsers, openWithBrowser, type BrowserList } from './browsers'
import {
  createLayout,
  migrateLegacyStorage,
  readStore,
  writeStore,
  type DataLayout
} from './store'

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

let layoutCache: DataLayout | null = null
function L(): DataLayout {
  if (!layoutCache) layoutCache = createLayout(app.getPath('userData'))
  return layoutCache
}

function getDataDir(): string {
  return L().dataDir
}

/** 坏文件留档处，分析里单独成一组，不混进网址数据 */
function getRecoveryDir(): string {
  return L().recoveryDir
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
  const re = /"([^"]*)"|(\S+)/g
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

/** 递归统计目录下所有文件数量与总字节 */
async function treeStats(dir: string): Promise<{ count: number; size: number }> {
  let count = 0
  let size = 0
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p2 = join(dir, e.name)
      if (e.isDirectory()) {
        const sub = await treeStats(p2)
        count += sub.count
        size += sub.size
      } else if (e.isFile()) {
        count += 1
        size += await statSize(p2)
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

function hideWindow(): void {
  if (!mainWindow) return
  // 先通知渲染层播放"收起"音效（窗口隐藏后渲染进程仍存活可发声）
  mainWindow.webContents.send('window:hidden')
  mainWindow.setAlwaysOnTop(false)
  mainWindow.hide()
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
    hideWindow()
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
  await migrateLegacyStorage(L())

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  protocol.handle('appicon', async (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.slice(1) || url.host)
    const iconsDir = L().iconsDir
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

  ipcMain.handle(
    'apps:uninstall-plan',
    (_e, info: AppInfo): Promise<UninstallPlan> => planUninstall(info.name, info.lnk)
  )

  ipcMain.handle('apps:remove-shortcut', (_e, lnk: string): Promise<void> => removeShortcut(lnk))

  ipcMain.handle('apps:open-uninstall-settings', (): Promise<void> => openAppsSettings())

  ipcMain.handle('links:fetch-meta', (_e, url: string) => fetchLinkMeta(url))

  let browserCache: BrowserList | null = null
  const getBrowsers = async (): Promise<BrowserList> => {
    if (!browserCache) browserCache = await detectBrowsers()
    return browserCache
  }

  ipcMain.handle('browsers:list', () => getBrowsers())

  ipcMain.handle('browsers:refresh', async (): Promise<BrowserList> => {
    browserCache = await detectBrowsers()
    return browserCache
  })

  ipcMain.handle(
    'links:open',
    async (_e, url: string, browserKey?: string): Promise<boolean> => {
      const norm = normalizeUrl(url)
      if (!norm) return false
      if (browserKey) {
        const { browsers } = await getBrowsers()
        const b = browsers.find((x) => x.key === browserKey)
        if (b && (await openWithBrowser(b.exe, norm))) return true
      }
      await shell.openExternal(norm)
      return true
    }
  )

  ipcMain.handle('store:read', (): Promise<Record<string, string> | null> => readStore(L()))

  ipcMain.handle(
    'store:write',
    (_e, data: Record<string, string>): Promise<boolean> => writeStore(L(), data)
  )

  ipcMain.handle('storage:info', async () => {
    const dir = getDataDir()
    const iconsDir = L().iconsDir
    const settingsFile = L().settingsFile
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

  ipcMain.handle('storage:analyze', async (_e, referenced: unknown) => {
    // 渲染层还没扫完应用列表时传 null：此时图标文件名不在手上，报孤儿会把全部缓存说成残留
    const used = Array.isArray(referenced)
      ? new Set(referenced.filter((x): x is string => typeof x === 'string'))
      : null
    const groups: { label: string; bytes: number; files: number }[] = []
    const icons = await dirStats(L().iconsDir)
    groups.push({ label: '应用图标缓存', bytes: icons.size, files: icons.count })
    const appBytes = await statSize(L().appFile)
    groups.push({ label: '应用排列数据', bytes: appBytes, files: appBytes > 0 ? 1 : 0 })
    const site = await dirStats(L().websiteDir)
    groups.push({ label: '网址数据', bytes: site.size, files: site.count })
    const setBytes = await statSize(L().settingsFile)
    groups.push({ label: '设置', bytes: setBytes, files: setBytes > 0 ? 1 : 0 })
    const rec = await dirStats(getRecoveryDir())
    if (rec.count > 0) groups.push({ label: '损坏留档', bytes: rec.size, files: rec.count })

    const tree = await treeStats(getDataDir())
    const knownBytes = groups.reduce((s, g) => s + g.bytes, 0)
    const knownFiles = groups.reduce((s, g) => s + g.files, 0)
    if (tree.size - knownBytes > 0) {
      groups.push({
        label: '其他',
        bytes: tree.size - knownBytes,
        files: Math.max(0, tree.count - knownFiles)
      })
    }

    const orphan: string[] = []
    let orphanBytes = 0
    if (used) {
      try {
        const iconsDir = L().iconsDir
        for (const e of await fs.readdir(iconsDir, { withFileTypes: true })) {
          if (!e.isFile() || used.has(e.name)) continue
          orphan.push(e.name)
          orphanBytes += await statSize(join(iconsDir, e.name))
        }
      } catch {
        /* 图标目录还没生成 */
      }
    }
    orphan.sort()

    return {
      dir: getDataDir(),
      total: tree.size,
      files: tree.count,
      groups: groups.sort((a, b) => b.bytes - a.bytes),
      // null = 应用列表还没就绪，本次不做残留判定
      orphans: used ? { count: orphan.length, bytes: orphanBytes, sample: orphan.slice(0, 6) } : null
    }
  })

  ipcMain.handle('storage:open', async (_e, target: 'root' | 'icons' | 'recovered'): Promise<string> => {
    const dir =
      target === 'icons' ? L().iconsDir : target === 'recovered' ? getRecoveryDir() : getDataDir()
    // 本窗口是全屏置顶的，不先收起就会盖住资源管理器
    hideWindow()
    return shell.openPath(dir)
  })

  ipcMain.on('window:hide', hideWindow)
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
