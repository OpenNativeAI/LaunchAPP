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
import { join, sep } from 'path'
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
import { t, setLang } from '../shared/i18n'
import { detectBrowsers, openWithBrowser, type BrowserList } from './browsers'
import {
  createLayout,
  migrateLegacyStorage,
  readStore,
  writeStore,
  writeTextAtomic,
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

/** 一次遍历拿到清单，才能既分组又列出真正占地方的大文件 */
async function walkFiles(
  dir: string,
  base: string,
  depth: number
): Promise<{ abs: string; rel: string; bytes: number }[]> {
  const out: { abs: string; rel: string; bytes: number }[] = []
  if (depth < 0) return out
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      // 跳过链接：junction 会让遍历绕回自己，统计到死
      if (e.isSymbolicLink()) continue
      const abs = join(dir, e.name)
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) out.push(...(await walkFiles(abs, rel, depth - 1)))
      else if (e.isFile()) out.push({ abs, rel, bytes: await statSize(abs) })
    }
  } catch {
    /* 目录不存在时按空处理 */
  }
  return out
}

const GROUP_LABELS: Record<string, string> = {
  icons: 'sgIconCache',
  grid: 'sgAppGrid',
  links: 'sgLinks',
  settings: 'sgSettings',
  recovered: 'recoveredLabel',
  runtime: 'sgRuntime',
  other: 'sgOther'
}

/** data/ 之外的那堆根目录是 Electron 自己的运行缓存，占了体积大头却从不进报表 */
function groupId(rel: string, abs: string, d: DataLayout): string {
  if (rel.startsWith('data/')) {
    if (abs.startsWith(d.iconsDir + sep)) return 'icons'
    if (abs.startsWith(d.websiteDir + sep)) return 'links'
    if (abs.startsWith(d.recoveryDir + sep)) return 'recovered'
    if (abs === d.settingsFile) return 'settings'
    if (abs === d.appFile || abs === d.appsCacheFile) return 'grid'
    return 'other'
  }
  return rel.includes('/') ? 'runtime' : 'other'
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

/** 托盘文案只能在主进程里翻译，语言变化后要整份重建 */
function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(t('trayTooltip'))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('trayOpen'), click: () => void showWindow() },
      {
        label: t('trayRescan'),
        click: () => mainWindow?.webContents.send('apps:rescan')
      },
      { type: 'separator' },
      { label: t('trayQuit'), click: () => app.quit() }
    ])
  )
}

function createTray(): void {
  if (tray) return
  tray = new Tray(icon)
  refreshTray()
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
    const list = await scanApps((done, total) => {
      sender.send('apps:progress', { done, total })
    })
    await writeTextAtomic(L().appsCacheFile, JSON.stringify(list)).catch(() => undefined)
    return list
  })

  /** 上次扫描的落盘结果：开机先铺这个，后台再静默重扫，省掉全屏转圈 */
  ipcMain.handle('apps:cached', async (): Promise<AppInfo[]> => {
    try {
      const list = JSON.parse(await fs.readFile(L().appsCacheFile, 'utf8')) as AppInfo[]
      if (!Array.isArray(list)) return []
      const names = new Set(await fs.readdir(L().iconsDir))
      // 图标文件已经不在了的条目直接滤掉，免得渲染成破图
      return list.filter(
        (a) => a && typeof a.lnk === 'string' && typeof a.name === 'string' && (!a.iconFile || names.has(a.iconFile))
      )
    } catch {
      return []
    }
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

  // 渲染层现在按单个键频繁写，串行执行，避免两次 read-merge-write 互相覆盖
  let storeWrites: Promise<unknown> = Promise.resolve()
  ipcMain.handle('store:write', (_e, data: Record<string, string | null>): Promise<boolean> => {
    const next = storeWrites
      .catch(() => undefined)
      .then(() => writeStore(L(), data))
    storeWrites = next.catch(() => undefined)
    return next
  })

  ipcMain.handle('storage:info', async () => {
    const dir = L().userDataDir
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

  ipcMain.handle('ui:lang', (_e, lang: unknown): void => {
    setLang(lang === 'en' ? 'en' : 'zh')
    refreshTray()
  })

  ipcMain.handle('storage:analyze', async (_e, referenced: unknown) => {
    // 渲染层还没扫完应用列表时传 null：此时图标文件名不在手上，报孤儿会把全部缓存说成残留
    const used = Array.isArray(referenced)
      ? new Set(referenced.filter((x): x is string => typeof x === 'string'))
      : null
    const d = L()
    const stage = (key: string): void => mainWindow?.webContents.send('storage:stage', key)

    stage('saStageWalk')
    const files = (await walkFiles(app.getPath('userData'), '', 8)).map((f) => ({
      ...f,
      group: groupId(f.rel, f.abs, d)
    }))

    const acc = new Map<string, { bytes: number; files: number }>()
    for (const f of files) {
      const g = acc.get(f.group)
      if (g) {
        g.bytes += f.bytes
        g.files += 1
      } else acc.set(f.group, { bytes: f.bytes, files: 1 })
    }
    const groups = [...acc]
      .map(([id, v]) => ({ id, label: t(GROUP_LABELS[id] ?? 'sgOther'), bytes: v.bytes, files: v.files }))
      .sort((a, b) => b.bytes - a.bytes)

    const total = files.reduce((s, f) => s + f.bytes, 0)
    stage('saStageTop')
    const top = files
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 6)
      .map((f) => ({ path: f.rel, bytes: f.bytes, group: f.group }))

    let orphanBytes = 0
    let orphan: string[] | null = null
    if (used) {
      stage('saStageOrphan')
      orphan = []
      try {
        for (const e of await fs.readdir(d.iconsDir, { withFileTypes: true })) {
          if (!e.isFile() || used.has(e.name)) continue
          orphan.push(e.name)
          orphanBytes += await statSize(join(d.iconsDir, e.name))
        }
      } catch {
        /* 图标目录还没生成 */
      }
      orphan.sort()
    }

    return {
      dir: app.getPath('userData'),
      total,
      files: files.length,
      groups,
      top,
      // null = 应用列表还没就绪，本次不做残留判定
      orphans: orphan ? { count: orphan.length, bytes: orphanBytes, sample: orphan.slice(0, 6) } : null
    }
  })

  ipcMain.handle('storage:open', async (_e, target: 'root' | 'icons' | 'recovered'): Promise<string> => {
    const dir =
      target === 'icons' ? L().iconsDir : target === 'recovered' ? getRecoveryDir() : L().userDataDir
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
