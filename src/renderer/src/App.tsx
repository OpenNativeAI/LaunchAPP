import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import SettingsPanel from './SettingsPanel'
import Dock, { type DockApp } from './Dock'
import AddLinkModal from './AddLinkModal'
import { t, setLang } from './i18n'
import dropSoundUrl from './assets/voice/drop.wav'
import notifySoundUrl from './assets/voice/notify.wav'
import {
  loadSettings,
  saveSettings,
  loadLinks,
  LINKS_KEY,
  GRID_KEY,
  FOLDERS_KEY,
  ICON_RADIUS,
  loadGrid,
  saveGrid,
  loadFolders,
  saveFolders,
  loadItemCat,
  saveItemCat,
  loadCategories,
  saveCategories,
  loadHidden,
  saveHidden,
  refKey,
  cellKey,
  displayShortcut,
  isMouseAccelerator,
  type Settings,
  type CategoryPools,
  type WebLink,
  type Cell,
  type Ref,
  type Folder
} from './settings'
import { getStore, setStore, clearStore, flushNow } from './persist'

interface AppInfo {
  id: string
  name: string
  target: string
  args: string
  workdir: string
  lnk: string
  iconFile: string
}

interface UninstallPlan {
  kind: 'win32' | 'store' | 'local' | 'notfound' | 'failed'
  displayName: string
  how: string
  cmd: string
  message: string
}

interface Progress {
  done: number
  total: number
}

const SOUND_URLS: Record<string, string> = {
  drop: dropSoundUrl,
  notify: notifySoundUrl
}

// 用 Web Audio 预解码缓冲，出现/收起时零延迟播放（避免每次现加载 wav 的延迟）
let sctx: AudioContext | null = null
const sbuf: Record<string, AudioBuffer> = {}
const spending: Record<string, boolean> = {}

function getAudioCtx(): AudioContext | null {
  if (!sctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    sctx = new Ctor()
  }
  if (sctx.state === 'suspended') void sctx.resume()
  return sctx
}

function preloadSound(id: string): void {
  const url = SOUND_URLS[id]
  if (!url || sbuf[id] || spending[id]) return
  spending[id] = true
  fetch(url)
    .then((r) => r.arrayBuffer())
    .then((ab) => {
      const ctx = getAudioCtx()
      if (!ctx) return undefined
      return ctx.decodeAudioData(ab).then((buf) => {
        sbuf[id] = buf
      })
    })
    .catch(() => undefined)
    .finally(() => {
      spending[id] = false
    })
}

function playSound(id: string): void {
  const buf = sbuf[id]
  if (!buf) {
    preloadSound(id)
    return
  }
  const ctx = getAudioCtx()
  if (!ctx) return
  const src = ctx.createBufferSource()
  src.buffer = buf
  const gain = ctx.createGain()
  gain.gain.value = 0.6
  src.connect(gain)
  gain.connect(ctx.destination)
  src.start()
}

const LAST_PAGE_KEY = 'launchapp-lastpage'
const DOCK_KEY = 'launchapp-dock'
const ORDER_KEY = 'launchapp-order'

function isSystemApp(a: AppInfo): boolean {
  return /^\\\\?\\[a-z]:\\windows\\/i.test(a.target) || /^[a-z]:\\windows\\/i.test(a.target)
}

let _blankImg: HTMLImageElement | null = null
function blankDragImage(): HTMLImageElement {
  if (!_blankImg) {
    _blankImg = document.createElement('img')
    _blankImg.src =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  }
  return _blankImg
}

/** 渲染层统一视图模型：应用 / 网址 / 文件夹 */
interface AppView {
  key: string
  kind: 'app'
  name: string
  iconUrl: string
  app: AppInfo
}
interface LinkView {
  key: string
  kind: 'link'
  name: string
  iconUrl: string
  link: WebLink
}
interface FolderView {
  key: string
  kind: 'folder'
  name: string
  folderId: string
  members: (AppView | LinkView)[]
}
type View = AppView | LinkView | FolderView
type LeafView = AppView | LinkView

function appViewOf(a: AppInfo): AppView {
  return {
    key: 'a:' + a.lnk,
    kind: 'app',
    name: a.name,
    iconUrl: a.iconFile ? 'appicon:///' + a.iconFile : '',
    app: a
  }
}
function linkViewOf(l: WebLink): LinkView {
  return { key: 'l:' + l.id, kind: 'link', name: l.name, iconUrl: l.icon, link: l }
}
function viewToCell(v: View): Cell {
  if (v.kind === 'folder') return { k: 'folder', id: v.folderId }
  if (v.kind === 'app') return { k: 'app', id: v.app.lnk }
  return { k: 'link', id: v.link.id }
}
function refOfLeaf(v: LeafView): Ref {
  return v.kind === 'app' ? { k: 'app', id: v.app.lnk } : { k: 'link', id: v.link.id }
}
function genFolderId(): string {
  return 'folder-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function useGridLayout(settings: Settings): { cols: number; rows: number } {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = (): void => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  if (!settings.autoGrid) return { cols: settings.cols, rows: settings.rows }
  const cell = Math.max(110, settings.iconSize + 46)
  const cols = Math.max(3, Math.min(12, Math.floor((size.w - 80) / cell)))
  const reserve = 200 + (settings.dockVisible ? 110 : 0)
  const rows = Math.max(2, Math.floor((size.h - reserve) / cell))
  return { cols, rows }
}

function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(timer)
  }, [])
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const date = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
  return (
    <div className="clock">
      <span className="clock-time">{time}</span>
      <span className="clock-date">{date}</span>
    </div>
  )
}

const GridTile = memo(function GridTile({
  view,
  draggable,
  dimmed,
  mergeArmed,
  onActivate,
  onMenu,
  onDragStart,
  onDragEnter,
  onDragLeave,
  onDrop,
  onDragEnd
}: {
  view: View
  draggable: boolean
  dimmed: boolean
  mergeArmed: boolean
  onActivate: (v: View) => void
  onMenu: (v: View, x: number, y: number) => void
  onDragStart: (key: string, x: number, y: number) => void
  onDragEnter: (key: string) => void
  onDragLeave: (key: string) => void
  onDrop: (key: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const isFolder = view.kind === 'folder'
  let cls = 'tile'
  if (view.kind === 'link') {
    cls += ' link-tile'
    if (view.link.plate === false) cls += ' no-plate'
  }
  if (isFolder) cls += ' folder-tile'
  if (dimmed) cls += ' dragging'
  if (mergeArmed) cls += ' merge-armed'
  const title = isFolder
    ? view.name
    : draggable
      ? view.name + t('dragHint')
      : view.name
  return (
    <button
      className={cls}
      title={title}
      draggable={draggable}
      onClick={() => onActivate(view)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(view, e.clientX, e.clientY)
      }}
      onDragStart={(e) => {
        if (!draggable) {
          e.preventDefault()
          return
        }
        const plain = view.kind === 'app' ? view.app.lnk : view.key
        e.dataTransfer.setData('text/plain', plain)
        e.dataTransfer.setData('application/x-cell', view.key)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setDragImage(blankDragImage(), 0, 0)
        onDragStart(view.key, e.clientX, e.clientY)
      }}
      onDragEnd={onDragEnd}
      onDragEnter={() => {
        if (draggable) onDragEnter(view.key)
      }}
      onDragOver={(e) => {
        if (draggable && e.dataTransfer.types.includes('application/x-cell')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          onDragEnter(view.key)
        }
      }}
      onDragLeave={() => {
        if (draggable) onDragLeave(view.key)
      }}
      onDrop={(e) => {
        if (!draggable || !e.dataTransfer.types.includes('application/x-cell')) return
        e.preventDefault()
        e.stopPropagation()
        onDrop(view.key)
      }}
    >
      {isFolder ? (
        <>
          <div className="folder-box">
            <div className="folder-thumbs">
              {view.members.slice(0, 4).map((m) =>
                m.iconUrl ? (
                  <img key={m.key} className="folder-thumb" src={m.iconUrl} alt="" draggable={false} />
                ) : (
                  <div key={m.key} className="folder-thumb fb">
                    {m.name.slice(0, 1)}
                  </div>
                )
              )}
            </div>
          </div>
          <span className="tile-name">{view.name}</span>
        </>
      ) : view.iconUrl ? (
        <>
          <img className="tile-icon" src={view.iconUrl} alt="" draggable={false} />
          <span className="tile-name">{view.name}</span>
        </>
      ) : (
        <>
          <div className="tile-icon tile-icon-fallback">{view.name.slice(0, 1)}</div>
          <span className="tile-name">{view.name}</span>
        </>
      )}
    </button>
  )
})

function Dropdown({
  value,
  options,
  onChange
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const cur = options.find((o) => o.value === value)
  return (
    <div className={'dd' + (open ? ' dd-open' : '')} ref={rootRef}>
      <button type="button" className="dd-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="dd-label">{cur ? t(cur.label) : ''}</span>
        <svg
          className="dd-arrow"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="dd-menu">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={'dd-item' + (o.value === value ? ' dd-item-on' : '')}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              {t(o.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TagEditor({
  name,
  tags,
  current,
  onAssign,
  onCreate,
  onDelete,
  onClose
}: {
  name: string
  tags: string[]
  current: string
  onAssign: (cat: string) => void
  onCreate: (raw: string) => void
  onDelete: (cat: string) => void
  onClose: () => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const submit = (): void => {
    const t = draft.trim()
    if (t) onCreate(t)
    setDraft('')
    setAdding(false)
  }
  return (
    <div className="folder-mask" onMouseDown={onClose}>
      <div className="tag-pop" onMouseDown={(e) => e.stopPropagation()}>
        <header className="tag-pop-title">
          <span>{t('catOf', { name })}</span>
          <button className="settings-close" onClick={onClose} title={t('closeEsc')}>
            ✕
          </button>
        </header>
        <div className="tag-field">
          <div className="tag-field-label">{t('assignedCat')}</div>
          <Dropdown
            value={current}
            options={[{ value: '', label: t('uncategorized') }].concat(
              tags.map((t) => ({ value: t, label: t }))
            )}
            onChange={onAssign}
          />
        </div>
        <div className="tag-manage">
          <div className="tag-manage-head">
            <span className="tag-field-label">{t('catManage')}</span>
            <button
              type="button"
              className="tag-add-btn"
              title={t('newCategory')}
              onClick={() => setAdding(true)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          {adding && (
            <div className="tag-pop-add">
              <input
                className="tag-pop-input"
                autoFocus
                value={draft}
                placeholder={t('newCatPlaceholder')}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                  else if (e.key === 'Escape') {
                    setAdding(false)
                    setDraft('')
                  }
                }}
              />
              <button className="set-button small" onClick={submit}>
                {t('ok')}
              </button>
              <button
                className="tag-pop-cancel"
                onClick={() => {
                  setAdding(false)
                  setDraft('')
                }}
              >
                {t('cancel')}
              </button>
            </div>
          )}
          {tags.length === 0 && !adding && (
            <div className="tag-pop-empty">{t('noCatsHint')}</div>
          )}
          <div className="tag-mgmt-list">
            {tags.map((c) => (
              <div key={c} className="tag-mgmt-item">
                <span className="tag-mgmt-name">{c}</span>
                <button
                  type="button"
                  className="tag-mgmt-del"
                  title={t('deleteCategory')}
                  onClick={() => onDelete(c)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function App(): JSX.Element {
  const [apps, setApps] = useState<AppInfo[]>([])
  // 刷新结果提示（9 秒后自动消失）
  const [scanNote, setScanNote] = useState<string | null>(null)
  const scanNoteTimer = useRef<number>(0)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  // 先于子组件渲染同步语言，切语言时整棵界面立刻跟着变
  setLang(settings.language)
  const [dockLnks, setDockLnks] = useState<string[]>(() => {
    try {
      const v = JSON.parse(getStore(DOCK_KEY) || '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  })
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const v = JSON.parse(getStore(ORDER_KEY) || '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  })
  const [links, setLinks] = useState<WebLink[]>(loadLinks)
  const [grid, setGrid] = useState<Cell[] | null>(() => loadGrid())
  const [folders, setFolders] = useState<Folder[]>(() => loadFolders())
  const [itemCat, setItemCat] = useState<Record<string, string>>(() => loadItemCat())
  const [cats, setCats] = useState<CategoryPools>(() => loadCategories())
  const [hiddenLnks, setHiddenLnks] = useState<string[]>(() => loadHidden())
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [tagEdit, setTagEdit] = useState<{ key: string; name: string } | null>(null)
  const [openFolder, setOpenFolder] = useState<FolderView | null>(null)
  const [addLink, setAddLink] = useState<{ open: boolean; editing: WebLink | null }>({
    open: false,
    editing: null
  })
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [armedKey, setArmedKey] = useState<string | null>(null)
  const [lp, setLp] = useState<{ key: string; x: number; y: number } | null>(null)
  const [filter, setFilter] = useState<'all' | 'app' | 'link'>('app')
  const [page, setPageRaw] = useState(() => {
    const s = loadSettings()
    if (!s.rememberPage) return 0
    const saved = parseInt(getStore(LAST_PAGE_KEY) || '0', 10)
    return Number.isFinite(saved) ? saved : 0
  })
  const [wallpaper, setWallpaper] = useState('')
  const [launchedId, setLaunchedId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; view: View } | null>(null)
  const [infoApp, setInfoApp] = useState<AppInfo | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<AppInfo | null>(null)
  const [uninstallResult, setUninstallResult] = useState<
    { ok?: boolean; message: string; kind: string } | null
  >(null)
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const [uninstallPlan, setUninstallPlan] = useState<UninstallPlan | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const scannedRef = useRef(false)
  /** 本次扫描走后台静默：有缓存可看时不再遮挡整屏 */
  const silentScanRef = useRef(false)
  const { cols, rows } = useGridLayout(settings)
  const pageSize = cols * rows

  const setPage = useCallback((updater: number | ((p: number) => number)): void => {
    setPageRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      setStore(LAST_PAGE_KEY, String(next))
      return next
    })
  }, [])

  // 用户主动翻页（滚轮/方向键/滑动/页码点击）：仅当页码真的变了才播翻页音效
  const turnPage = useCallback(
    (dir: number): void => {
      const cur = safePageRef.current
      const target = Math.min(Math.max(cur + dir, 0), (pageCountRef.current || 1) - 1)
      if (target === cur) return
      setPage(target)
      if (settings.soundEnabled && settings.pageSound) playSound(settings.pageSound)
    },
    [settings.soundEnabled, settings.pageSound, setPage]
  )
  const gotoPage = useCallback(
    (p: number): void => {
      if (p === safePageRef.current) return
      setPage(p)
      if (settings.soundEnabled && settings.pageSound) playSound(settings.pageSound)
    },
    [settings.soundEnabled, settings.pageSound, setPage]
  )

  const patchSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  const startScan = useCallback(async (force = false, silent = false): Promise<AppInfo[]> => {
    setError(null)
    silentScanRef.current = silent
    if (!silent) setProgress({ done: 0, total: 0 })
    try {
      const list = await window.api.scanApps(force)
      setApps(list)
      return list
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return []
    } finally {
      silentScanRef.current = false
      setProgress(null)
    }
  }, [])

  // 顶栏刷新：扫完直接告诉用户结果，别让"没反应"和"真的没有"长得一样
  const refreshApps = useCallback(async (): Promise<void> => {
    const before = apps.length
    const list = await startScan(false)
    const added = list.length - before
    setScanNote(added > 0 ? t('scanNew', { n: added }) : t('scanNone'))
    if (scanNoteTimer.current) clearTimeout(scanNoteTimer.current)
    scanNoteTimer.current = window.setTimeout(() => setScanNote(null), 9000)
  }, [apps.length, startScan])

  useEffect(() => {
    const off = window.api.onScanProgress((p) => {
      // 静默重扫时不接进度，否则又会把图标挡住
      if (silentScanRef.current) return
      setProgress(p)
    })
    window.api.onWallpaper((dataUrl) => {
      if (dataUrl) setWallpaper(dataUrl)
    })
    window.api.onRescan(() => startScan(true))
    if (!scannedRef.current) {
      scannedRef.current = true
      // 先铺上次的扫描结果（几乎瞬间就有图标），再在后台静默重扫校正
      void window.api
        .cachedApps()
        .then((cached) => {
          if (cached.length > 0) setApps(cached)
          return cached.length > 0
        })
        .catch(() => false)
        .then((hadCache) => startScan(false, hadCache))
    }
    return off
  }, [startScan])

  // 窗口唤起时播放"启动"音效（搜索框不再自动聚焦，保持低调，只有鼠标点击时才亮）
  useEffect(() => {
    const off = window.api.onWindowShown(() => {
      if (settings.soundEnabled && settings.openSound) playSound(settings.openSound)
    })
    return off
  }, [settings.soundEnabled, settings.openSound])

  // 收起窗口就意味着用户可能马上退出，先把没落盘的改动写进 userData
  useEffect(() => {
    const off = window.api.onWindowHidden(flushNow)
    window.addEventListener('beforeunload', flushNow)
    return () => {
      off()
      window.removeEventListener('beforeunload', flushNow)
    }
  }, [])

  // 界面收起时播放音效
  useEffect(() => {
    if (!settings.soundEnabled || !settings.closeSound) return
    if (typeof window.api.onWindowHidden !== 'function') return
    const off = window.api.onWindowHidden(() => playSound(settings.closeSound))
    return off
  }, [settings.soundEnabled, settings.closeSound])

  // 开启音效时预先解码，唤起瞬时出声
  useEffect(() => {
    if (!settings.soundEnabled) return
    if (settings.openSound) preloadSound(settings.openSound)
    if (settings.closeSound) preloadSound(settings.closeSound)
    if (settings.pageSound) preloadSound(settings.pageSound)
  }, [settings.soundEnabled, settings.openSound, settings.closeSound, settings.pageSound])

  useEffect(() => {
    window.api.setUiLang(settings.language).catch(() => undefined)
  }, [settings.language])

  useEffect(() => {
    window.api
      .setShortcut(settings.globalShortcut)
      .then((ok) => {
        if (!ok && settings.globalShortcut) {
          const label = displayShortcut(settings.globalShortcut)
          setError(
            isMouseAccelerator(settings.globalShortcut)
              ? t('errMouseShortcut', { label })
              : t('errKeyShortcut', { label })
          )
        }
      })
      .catch(() => undefined)
  }, [settings.globalShortcut])

  useEffect(() => {
    window.api.setAutoLaunch(settings.autoLaunch).catch(() => undefined)
  }, [settings.autoLaunch])

  // 侧键导航只在网址视图可用时才有意义；关掉时顺手把钩子让出来
  useEffect(() => {
    const on = settings.mouseSideNav && settings.linksEnabled
    window.api.setMouseNav(on).catch(() => undefined)
    if (!on) return
    const onNav = (view: 'app' | 'link'): void => setFilter(view)
    // Chromium 把侧键当浏览器前进/后退，抢在默认行为前吃掉
    const blockDefault = (e: MouseEvent): void => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
    }
    window.addEventListener('pointerdown', blockDefault, true)
    window.addEventListener('mouseup', blockDefault, true)
    window.addEventListener('auxclick', blockDefault, true)
    const off = window.api.onMouseNavigate(onNav)
    return () => {
      window.removeEventListener('pointerdown', blockDefault, true)
      window.removeEventListener('mouseup', blockDefault, true)
      window.removeEventListener('auxclick', blockDefault, true)
      off()
    }
  }, [settings.mouseSideNav, settings.linksEnabled])

  const dismiss = useCallback((): void => {
    if (settings.closeQuits) window.api.quitApp()
    else window.api.hideWindow()
  }, [settings.closeQuits])

  // 失去焦点自动隐藏：仅在开启时监听，隐藏到托盘（不退出不受 closeQuits 影响）
  useEffect(() => {
    if (!settings.autoHideOnBlur) return
    const onBlur = (): void => window.api.hideWindow()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [settings.autoHideOnBlur])

  const openMenu = useCallback((view: View, x: number, y: number): void => {
    setCtxMenu({
      view,
      x: Math.min(x, window.innerWidth - 180),
      y: Math.min(y, window.innerHeight - 170)
    })
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent): void => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    const onBlur = (): void => setCtxMenu(null)
    // 用 mousedown 捕获：右键别处时先关闭旧菜单，再弹新菜单
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [ctxMenu])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (uninstallTarget) {
          setUninstallTarget(null)
          setUninstallResult(null)
        } else if (ctxMenu) setCtxMenu(null)
        else if (openFolder) setOpenFolder(null)
        else if (addLink.open) setAddLink({ open: false, editing: null })
        else if (settingsOpen) setSettingsOpen(false)
        else if (query) setQuery('')
        else dismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, settingsOpen, ctxMenu, openFolder, addLink.open, uninstallTarget, dismiss])

  // "仅移除图标"的隐藏集合：命中的快捷方式不显示，但磁盘 .lnk 原封不动
  const hiddenSet = useMemo(() => new Set(hiddenLnks), [hiddenLnks])

  // 供设置面板管理：当前处于隐藏状态的应用（保留图标与名称便于恢复）
  const hiddenApps = useMemo(
    () =>
      apps
        .filter((a) => hiddenSet.has(a.lnk))
        .map((a) => ({ lnk: a.lnk, name: a.name, iconFile: a.iconFile })),
    [apps, hiddenSet]
  )

  // 派生统一网格视图（应用 + 网址 + 文件夹），grid 为空时从 order/links 迁移
  const views = useMemo<View[]>(() => {
    const appMap = new Map(apps.map((a) => [a.lnk, a]))
    const linkMap = new Map(links.map((l) => [l.id, l]))
    const folderMap = new Map(folders.map((f) => [f.id, f]))
    const hidden = (a: AppInfo): boolean =>
      hiddenSet.has(a.lnk) || (settings.hideSystemApps && isSystemApp(a))
    const resolveRef = (r: Ref): LeafView | null => {
      if (r.k === 'app') {
        const a = appMap.get(r.id)
        return a && !hidden(a) ? appViewOf(a) : null
      }
      const l = linkMap.get(r.id)
      return l ? linkViewOf(l) : null
    }
    let cells: Cell[] = []
    if (grid) cells = grid
    else {
      const seen = new Set<string>()
      for (const lnk of order) {
        if (appMap.has(lnk) && !seen.has(lnk)) {
          cells.push({ k: 'app', id: lnk })
          seen.add(lnk)
        }
      }
      for (const a of apps) {
        if (!seen.has(a.lnk)) {
          cells.push({ k: 'app', id: a.lnk })
          seen.add(a.lnk)
        }
      }
      for (const l of links) cells.push({ k: 'link', id: l.id })
    }
    const used = new Set<string>()
    const out: View[] = []
    for (const c of cells) {
      if (c.k === 'folder') {
        const f = folderMap.get(c.id)
        if (!f) continue
        const members = f.items.map(resolveRef).filter((m): m is LeafView => !!m)
        for (const m of members) used.add(m.key)
        if (members.length === 0) continue
        if (members.length === 1) {
          out.push(members[0])
          continue
        }
        out.push({ key: 'f:' + c.id, kind: 'folder', name: f.name, folderId: c.id, members })
      } else {
        const key = refKey(c)
        if (used.has(key)) continue
        const v = resolveRef(c)
        if (v) {
          used.add(key)
          out.push(v)
        }
      }
    }
    const pushApp = (a: AppInfo): void => {
      const key = 'a:' + a.lnk
      if (used.has(key) || hidden(a)) return
      used.add(key)
      out.push(appViewOf(a))
    }
    const pushLink = (l: WebLink): void => {
      const key = 'l:' + l.id
      if (used.has(key)) return
      used.add(key)
      out.push(linkViewOf(l))
    }
    if (settings.appSort === 'name') {
      ;[...apps].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')).forEach(pushApp)
    } else {
      apps.forEach(pushApp)
    }
    if (settings.linksEnabled) links.forEach(pushLink)
    return out
  }, [apps, links, folders, grid, order, settings.hideSystemApps, settings.appSort, settings.linksEnabled, hiddenSet])

  const viewsRef = useRef(views)
  viewsRef.current = views

  // 搜索：扁平匹配所有应用与网址（含文件夹内成员），忽略分组与拖拽
  const searchViews = useMemo<LeafView[] | null>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const out: LeafView[] = []
    for (const a of apps) {
      if (hiddenSet.has(a.lnk) || (settings.hideSystemApps && isSystemApp(a))) continue
      if (a.name.toLowerCase().includes(q) || a.target.toLowerCase().includes(q)) out.push(appViewOf(a))
    }
    if (settings.linksEnabled) {
      for (const l of links) {
        if (l.name.toLowerCase().includes(q) || l.url.toLowerCase().includes(q)) out.push(linkViewOf(l))
      }
    }
    return out
  }, [query, apps, links, settings.hideSystemApps, settings.linksEnabled, hiddenSet])

  const renderList: View[] = searchViews ?? views
  // 分类名按视图独立派生：应用用 a: 前缀条目，网址用 l: 前缀条目
  const appTagNames = useMemo<string[]>(() => {
    const seen = new Set<string>(cats.app)
    for (const k of Object.keys(itemCat)) if (k.startsWith('a:') && itemCat[k]) seen.add(itemCat[k])
    return [...seen]
  }, [cats, itemCat])
  const linkTagNames = useMemo<string[]>(() => {
    const seen = new Set<string>(cats.link)
    for (const k of Object.keys(itemCat)) if (k.startsWith('l:') && itemCat[k]) seen.add(itemCat[k])
    return [...seen]
  }, [cats, itemCat])

  const displayList: View[] = useMemo(() => {
    if (query) return renderList
    let list = renderList
    if (filter === 'link') list = list.filter((v) => v.kind === 'link')
    else if (filter === 'app') list = list.filter((v) => v.kind === 'app' || v.kind === 'folder')
    if (activeTag)
      list = list.filter((v) => v.kind !== 'folder' && (itemCat[v.key] || '') === activeTag)
    return list
  }, [query, renderList, activeTag, itemCat, filter])
  const pageCount = Math.max(1, Math.ceil(displayList.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)

  useEffect(() => {
    setPage(0)
    setActiveTag(null)
  }, [query, cols, rows, filter])

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!settings.wheelPaging || settingsOpen) return
      if (e.deltaY > 30) turnPage(1)
      else if (e.deltaY < -30) turnPage(-1)
    },
    [settings.wheelPaging, settingsOpen, turnPage]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (settingsOpen || openFolder || query) return
      if (e.key === 'ArrowRight') turnPage(1)
      if (e.key === 'ArrowLeft') turnPage(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, openFolder, query, turnPage])

  const launch = useCallback(async (info: AppInfo): Promise<void> => {
    setLaunchedId(info.id)
    try {
      window.api.hideWindow()
      await window.api.launchApp(info)
    } catch (e) {
      setError(
        t('errLaunch', { name: info.name, msg: e instanceof Error ? e.message : String(e) })
      )
    } finally {
      setTimeout(() => setLaunchedId(null), 600)
    }
  }, [])

  const commitDock = useCallback((next: string[]): void => {
    setDockLnks(next)
    setStore(DOCK_KEY, JSON.stringify(next))
  }, [])

  const commitLinks = useCallback((next: WebLink[]): void => {
    setLinks(next)
    setStore(LINKS_KEY, JSON.stringify(next))
  }, [])

  const openLink = useCallback(
    async (l: WebLink): Promise<void> => {
      const ok = await window.api.openLink(l.url, settings.linkBrowser || undefined)
      if (!ok) setError(t('errOpenLink', { url: l.url }))
      else window.api.hideWindow()
    },
    [settings.linkBrowser]
  )

  const activate = useCallback(
    (v: View): void => {
      if (v.kind === 'app') void launch(v.app)
      else if (v.kind === 'link') void openLink(v.link)
      else setOpenFolder(v)
    },
    [launch, openLink]
  )

  const commitItemCat = useCallback((next: Record<string, string>): void => {
    setItemCat(next)
    saveItemCat(next)
  }, [])
  const commitCats = useCallback((next: CategoryPools): void => {
    setCats(next)
    saveCategories(next)
  }, [])

  const saveLink = useCallback(
    (link: WebLink, cat: string): void => {
      setAddLink({ open: false, editing: null })
      const exists = links.some((l) => l.id === link.id)
      commitLinks(exists ? links.map((l) => (l.id === link.id ? link : l)) : [...links, link])
      const key = 'l:' + link.id
      const cur = itemCat[key] || ''
      if (cur !== cat) {
        const next = { ...itemCat }
        if (cat) next[key] = cat
        else delete next[key]
        commitItemCat(next)
      }
    },
    [links, commitLinks, itemCat, commitItemCat]
  )

  const deleteLink = useCallback(
    (id: string): void => {
      commitLinks(links.filter((l) => l.id !== id))
      setCtxMenu(null)
    },
    [links, commitLinks]
  )


  const addToDock = useCallback(
    (lnk: string): void => {
      if (!apps.some((a) => a.lnk === lnk)) return
      commitDock(dockLnks.includes(lnk) ? dockLnks : [...dockLnks, lnk])
    },
    [apps, dockLnks, commitDock]
  )

  const removeFromDock = useCallback(
    (lnk: string): void => commitDock(dockLnks.filter((l) => l !== lnk)),
    [dockLnks, commitDock]
  )

  const reorderDock = useCallback(
    (from: number, to: number): void => {
      if (from === to || from < 0 || to < 0) return
      const next = [...dockLnks]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      commitDock(next)
    },
    [dockLnks, commitDock]
  )

  // 从网格拖入 Dock：把应用插到 Dock 的指定位置（已在 Dock 里则等于移动）
  const insertIntoDock = useCallback(
    (lnk: string, at: number): void => {
      if (!apps.some((a) => a.lnk === lnk)) return
      const next = dockLnks.filter((l) => l !== lnk)
      next.splice(Math.min(Math.max(at, 0), next.length), 0, lnk)
      commitDock(next)
    },
    [apps, dockLnks, commitDock]
  )

  const commitCells = useCallback((next: Cell[]): void => {
    setGrid(next)
    saveGrid(next)
  }, [])

  const commitFolders = useCallback((next: Folder[]): void => {
    setFolders(next)
    saveFolders(next)
  }, [])

  const setItemCategory = useCallback(
    (key: string, cat: string): void => {
      const next = { ...itemCat }
      if (cat) next[key] = cat
      else delete next[key]
      commitItemCat(next)
    },
    [itemCat, commitItemCat]
  )
  const createCategory = useCallback(
    (kind: 'app' | 'link', raw: string): void => {
      const name = raw.trim()
      if (!name) return
      const list = kind === 'link' ? cats.link : cats.app
      if (list.includes(name)) return
      commitCats(kind === 'link' ? { ...cats, link: [...list, name] } : { ...cats, app: [...list, name] })
    },
    [cats, commitCats]
  )
  const removeCategory = useCallback(
    (kind: 'app' | 'link', name: string): void => {
      const prefix = kind === 'link' ? 'l:' : 'a:'
      const list = kind === 'link' ? cats.link : cats.app
      commitCats(
        kind === 'link'
          ? { ...cats, link: list.filter((t) => t !== name) }
          : { ...cats, app: list.filter((t) => t !== name) }
      )
      const next: Record<string, string> = {}
      for (const k of Object.keys(itemCat)) {
        if (k.startsWith(prefix) && itemCat[k] === name) continue
        next[k] = itemCat[k]
      }
      commitItemCat(next)
      if (activeTag === name) setActiveTag(null)
    },
    [cats, itemCat, activeTag, commitCats, commitItemCat]
  )
  const reorder = useCallback(
    (srcKey: string, targetKey: string): void => {
      const g = viewsRef.current.map(viewToCell)
      const s = g.findIndex((c) => cellKey(c) === srcKey)
      const t = g.findIndex((c) => cellKey(c) === targetKey)
      if (s < 0 || t < 0 || s === t) return
      const [m] = g.splice(s, 1)
      g.splice(t, 0, m)
      commitCells(g)
    },
    [commitCells]
  )

  // 把某个格子移动到“当前可见列表”的第 at 个位置（映射回完整网格索引，兼容筛选视图）
  const moveToDisplayIndex = useCallback(
    (key: string, at: number): void => {
      const g = viewsRef.current.map(viewToCell)
      const s = g.findIndex((c) => cellKey(c) === key)
      if (s < 0) return
      const [m] = g.splice(s, 1)
      let insertAt: number
      if (at >= displayList.length) {
        insertAt = g.length
      } else {
        const anchorKey = displayList[Math.max(0, at)].key
        insertAt = g.findIndex((c) => cellKey(c) === anchorKey)
        if (insertAt < 0) insertAt = g.length
      }
      g.splice(insertAt, 0, m)
      commitCells(g)
    },
    [displayList, commitCells]
  )

  const merge = useCallback(
    (srcKey: string, targetKey: string): void => {
      const list = viewsRef.current
      const src = list.find((v) => v.key === srcKey)
      const tgt = list.find((v) => v.key === targetKey)
      if (!src || !tgt || src === tgt || src.kind === 'folder') return
      const g = list.map(viewToCell)
      const sIdx = g.findIndex((c) => cellKey(c) === srcKey)
      const tCell = g.find((c) => cellKey(c) === targetKey)
      if (sIdx < 0 || !tCell) return
      const srcRef = viewToCell(src) as Ref
      if (tCell.k === 'folder') {
        const nf = folders.map((f) => (f.id === tCell.id ? { ...f, items: [...f.items, srcRef] } : f))
        g.splice(sIdx, 1)
        commitCells(g)
        commitFolders(nf)
        return
      }
      const fid = genFolderId()
      const nf: Folder[] = [...folders, { id: fid, name: t('folder'), items: [tCell as Ref, srcRef] }]
      g.splice(sIdx, 1)
      const nt = g.findIndex((c) => cellKey(c) === targetKey)
      if (nt < 0) return
      g.splice(nt, 1, { k: 'folder', id: fid })
      commitCells(g)
      commitFolders(nf)
    },
    [folders, commitCells, commitFolders]
  )

  const dragKeyRef = useRef<string | null>(null)
  const hoverRef = useRef<string | null>(null)
  const armedRef = useRef<string | null>(null)
  const mergeTimer = useRef<number | null>(null)

  const clearMergeTimer = useCallback((): void => {
    if (mergeTimer.current !== null) {
      window.clearTimeout(mergeTimer.current)
      mergeTimer.current = null
    }
  }, [])

  const endDrag = useCallback((): void => {
    clearMergeTimer()
    dragKeyRef.current = null
    hoverRef.current = null
    armedRef.current = null
    setDragKey(null)
    setArmedKey(null)
    setLp(null)
  }, [clearMergeTimer])

  const onCellDragStart = useCallback((key: string, x: number, y: number): void => {
    dragKeyRef.current = key
    setDragKey(key)
    setLp({ key, x, y })
  }, [])

  const onCellDragEnter = useCallback(
    (key: string): void => {
      const src = dragKeyRef.current
      if (!src || src === key) return
      reorder(src, key)
      if (hoverRef.current !== key) {
        hoverRef.current = key
        clearMergeTimer()
        armedRef.current = null
        setArmedKey(null)
        mergeTimer.current = window.setTimeout(() => {
          armedRef.current = key
          setArmedKey(key)
        }, 350)
      }
    },
    [reorder, clearMergeTimer]
  )

  const onCellDragLeave = useCallback(
    (key: string): void => {
      if (hoverRef.current === key) {
        hoverRef.current = null
        clearMergeTimer()
        armedRef.current = null
        setArmedKey(null)
      }
    },
    [clearMergeTimer]
  )

  const onCellDrop = useCallback(
    (key: string): void => {
      const src = dragKeyRef.current
      if (src && src !== key && armedRef.current === key) merge(src, key)
      endDrag()
    },
    [merge, endDrag]
  )

  useEffect(() => {
    if (!dragKey) return
    window.addEventListener('dragend', endDrag, true)
    window.addEventListener('drop', endDrag, true)
    return () => {
      window.removeEventListener('dragend', endDrag, true)
      window.removeEventListener('drop', endDrag, true)
    }
  }, [dragKey, endDrag])

  useEffect(() => {
    if (!dragKey) return
    const onOver = (e: DragEvent): void => {
      setLp((cur) => (cur ? { key: cur.key, x: e.clientX, y: e.clientY } : { key: dragKey, x: e.clientX, y: e.clientY }))
    }
    window.addEventListener('dragover', onOver)
    return () => window.removeEventListener('dragover', onOver)
  }, [dragKey])

  const edgeTimer = useRef<number | null>(null)
  const edgeDir = useRef(0)
  const edgeEnterPage = useRef(0)
  const pageCountRef = useRef(pageCount)
  pageCountRef.current = pageCount
  const safePageRef = useRef(safePage)
  safePageRef.current = safePage

  const stopEdgePaging = useCallback((): void => {
    if (edgeTimer.current !== null) {
      window.clearInterval(edgeTimer.current)
      edgeTimer.current = null
    }
    edgeDir.current = 0
  }, [])

  const startEdgePaging = useCallback(
    (dir: number): void => {
      if (edgeDir.current === dir) return
      stopEdgePaging()
      edgeDir.current = dir
      edgeEnterPage.current = safePageRef.current
      edgeTimer.current = window.setInterval(() => {
        setPage((p) => Math.min(Math.max(p + dir, 0), pageCountRef.current - 1))
      }, 400)
    },
    [setPage, stopEdgePaging]
  )

  const dropAtEdge = useCallback(
    (dir: number, key: string): void => {
      const cur = safePageRef.current
      const target =
        dir === 1
          ? Math.max(cur, Math.min(edgeEnterPage.current + 1, pageCountRef.current - 1))
          : Math.min(cur, Math.max(edgeEnterPage.current - 1, 0))
      moveToDisplayIndex(key, target * pageSize)
      setPage(target)
    },
    [moveToDisplayIndex, pageSize, setPage]
  )

  useEffect(() => stopEdgePaging, [dragKey, stopEdgePaging])

  // 拖拽时：光标靠近窗口左右边缘即自动翻页（比 36px 触发条更可靠）
  useEffect(() => {
    if (!dragKey) return
    const onOver = (e: DragEvent): void => {
      const w = window.innerWidth
      const m = Math.max(80, Math.round(w * 0.12))
      if (e.clientX < m) startEdgePaging(-1)
      else if (e.clientX > w - m) startEdgePaging(1)
      else stopEdgePaging()
    }
    window.addEventListener('dragover', onOver)
    return () => {
      window.removeEventListener('dragover', onOver)
      stopEdgePaging()
    }
  }, [dragKey, startEdgePaging, stopEdgePaging])

  // 翻页后把被拖的图标带到当前可见页，让它跟着光标继续走
  useEffect(() => {
    if (!dragKey) return
    const idx = displayList.findIndex((v) => v.key === dragKey)
    if (idx < 0) return
    if (Math.floor(idx / pageSize) !== safePage) moveToDisplayIndex(dragKey, safePage * pageSize)
  }, [dragKey, safePage, displayList, pageSize, moveToDisplayIndex])

  const orderSaveTimer = useRef<number | null>(null)
  const commitOrder = useCallback((next: string[]): void => {
    setOrder(next)
    if (orderSaveTimer.current !== null) window.clearTimeout(orderSaveTimer.current)
    orderSaveTimer.current = window.setTimeout(() => {
      orderSaveTimer.current = null
      setStore(ORDER_KEY, JSON.stringify(next))
    }, 300)
  }, [])

  const resetOrder = useCallback((): void => {
    commitOrder([])
    setGrid(null)
    clearStore(GRID_KEY)
    setFolders([])
    clearStore(FOLDERS_KEY)
  }, [commitOrder])

  const purgeRef = useCallback(
    (ref: Ref): void => {
      if (grid) {
        const g = grid.filter((c) => !(c.k === ref.k && c.id === ref.id))
        if (g.length !== grid.length) commitCells(g)
      }
      commitFolders(
        folders.map((f) => {
          const items = f.items.filter((i) => !(i.k === ref.k && i.id === ref.id))
          return items.length === f.items.length ? f : { ...f, items }
        })
      )
    },
    [grid, folders, commitCells, commitFolders]
  )

  /** 弹窗一打开就查卸载入口，把「将运行哪个卸载程序、依据什么找到它」先给用户看 */
  useEffect(() => {
    if (!uninstallTarget) {
      setUninstallPlan(null)
      return
    }
    let alive = true
    setUninstallPlan(null)
    window.api
      .planUninstall(uninstallTarget)
      .then((p) => {
        if (alive) setUninstallPlan(p)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setUninstallPlan({
          kind: 'failed',
          displayName: uninstallTarget.name,
          how: '',
          cmd: '',
          message: t('errPlanUninstall', {
            msg: e instanceof Error ? e.message : String(e)
          })
        })
      })
    return () => {
      alive = false
    }
  }, [uninstallTarget])

  const removeOnly = useCallback((): void => {
    if (!uninstallTarget) return
    const lnk = uninstallTarget.lnk
    // 不删磁盘快捷方式（系统级开始菜单需管理员权限，删不掉还会报错），
    // 只记入隐藏名单，启动器过滤展示；重扫/重启都不会再出现，也不影响卸载
    const next = hiddenLnks.includes(lnk) ? hiddenLnks : [...hiddenLnks, lnk]
    saveHidden(next)
    setHiddenLnks(next)
    setUninstallResult({
      message: t('removedMsg'),
      kind: 'removed'
    })
  }, [uninstallTarget, hiddenLnks])

  // 从隐藏名单恢复单个/全部图标
  const unhideApp = useCallback(
    (lnk: string): void => {
      const next = hiddenLnks.filter((l) => l !== lnk)
      saveHidden(next)
      setHiddenLnks(next)
    },
    [hiddenLnks]
  )
  const unhideAll = useCallback((): void => {
    saveHidden([])
    setHiddenLnks([])
  }, [])


  const confirmUninstall = useCallback(async (): Promise<void> => {
    if (!uninstallTarget) return
    setUninstallBusy(true)
    try {
      const res = await window.api.uninstallApp(uninstallTarget)
      if (res.ok) {
        const lnk = uninstallTarget.lnk
        setApps((list) => list.filter((a) => a.lnk !== lnk))
        commitOrder(order.filter((l) => l !== lnk))
        commitDock(dockLnks.filter((l) => l !== lnk))
        purgeRef({ k: 'app', id: lnk })
      }
      setUninstallResult(res)
    } catch (e) {
      setUninstallResult({ message: e instanceof Error ? e.message : String(e), kind: 'failed' })
    } finally {
      setUninstallBusy(false)
    }
  }, [uninstallTarget, order, dockLnks, commitOrder, commitDock, purgeRef])

  const dockItems = useMemo<DockApp[]>(
    () =>
      dockLnks
        .map((l) => apps.find((a) => a.lnk === l))
        .filter((a): a is AppInfo => !!a)
        .map((a) => ({ lnk: a.lnk, name: a.name, iconFile: a.iconFile })),
    [dockLnks, apps]
  )

  const launchFromDock = useCallback(
    (d: DockApp): void => {
      const full = apps.find((a) => a.lnk === d.lnk)
      if (full) void launch(full)
    },
    [apps, launch]
  )

  const renameFolder = useCallback(
    (id: string, name: string): void => {
      commitFolders(folders.map((f) => (f.id === id ? { ...f, name } : f)))
    },
    [folders, commitFolders]
  )

  const unfolder = useCallback(
    (id: string): void => {
      const g = viewsRef.current.map(viewToCell)
      const gi = g.findIndex((c) => c.k === 'folder' && c.id === id)
      if (gi < 0) return
      const f = folders.find((x) => x.id === id)
      const items = f ? f.items : []
      g.splice(gi, 1, ...items)
      commitCells(g)
      commitFolders(folders.filter((x) => x.id !== id))
      setOpenFolder(null)
    },
    [folders, commitCells, commitFolders]
  )

  const moveOut = useCallback(
    (folderId: string, member: LeafView): void => {
      const f = folders.find((x) => x.id === folderId)
      if (!f) return
      const items = f.items.filter((i) => refKey(i) !== member.key)
      const g = viewsRef.current.map(viewToCell)
      const gi = g.findIndex((c) => c.k === 'folder' && c.id === folderId)
      if (gi < 0) return
      const mref = refOfLeaf(member)
      let nextGrid: Cell[]
      let nextFolders: Folder[]
      if (items.length >= 2) {
        nextGrid = g.slice()
        nextGrid.splice(gi + 1, 0, mref)
        nextFolders = folders.map((x) => (x.id === folderId ? { ...x, items } : x))
      } else {
        nextGrid = g.slice()
        nextGrid.splice(gi, 1, ...items, mref)
        nextFolders = folders.filter((x) => x.id !== folderId)
      }
      commitCells(nextGrid)
      commitFolders(nextFolders)
    },
    [folders, commitCells, commitFolders]
  )

  const openFolderLive = useMemo<FolderView | null>(() => {
    if (!openFolder) return null
    return (
      views.find((v): v is FolderView => v.kind === 'folder' && v.folderId === openFolder.folderId) ??
      null
    )
  }, [openFolder, views])

  const dragAppLnk = dragKey && dragKey.startsWith('a:') ? dragKey.slice(2) : null

  // 抓页跟手滑动翻页：在空白处按住左键拖动，页面跟手平移，松手按阈值翻页或回弹
  const viewportRef = useRef<HTMLElement | null>(null)
  const pageDrag = useRef<{ startX: number; moved: boolean; onBlank: boolean } | null>(null)
  const [dragPx, setDragPx] = useState(0)
  const [dragging, setDragging] = useState(false)

  const onViewportMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      if (e.button !== 0) return
      if (settingsOpen) return
      const target = e.target as HTMLElement
      // 落在图标/文件夹/添加格上：交给它自己的拖拽或点击，不触发翻页
      if (target.closest('.tile')) return
      const startPage = safePage
      pageDrag.current = { startX: e.clientX, moved: false, onBlank: e.target === e.currentTarget }

      const onMove = (ev: MouseEvent): void => {
        const st = pageDrag.current
        if (!st) return
        const dx = ev.clientX - st.startX
        if (!st.moved && Math.abs(dx) > 6) {
          st.moved = true
          setDragging(true)
        }
        if (!st.moved) return
        // 首页向右 / 末页向左拖时阻尼回弹
        const atEdge = (startPage === 0 && dx > 0) || (startPage === pageCount - 1 && dx < 0)
        setDragPx(atEdge ? dx * 0.35 : dx)
      }
      const onUp = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        const st = pageDrag.current
        pageDrag.current = null
        setDragging(false)
        setDragPx(0)
        if (!st) return
        if (!st.moved) {
          if (settings.clickBlankToHide && st.onBlank) dismiss()
          return
        }
        const dx = ev.clientX - st.startX
        const w = viewportRef.current?.clientWidth || window.innerWidth || 1
        const frac = dx / w
        if (frac <= -0.18) turnPage(1)
        else if (frac >= 0.18) turnPage(-1)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [settingsOpen, safePage, pageCount, settings.clickBlankToHide, dismiss, turnPage]
  )

  const scanning = progress !== null

  function ctxItems(v: View): JSX.Element {
    if (v.kind === 'app') {
      return (
        <>
          <button
            className="ctx-item"
            onClick={() => {
              const a = v.app
              setCtxMenu(null)
              void launch(a)
            }}
          >
            {t('open')}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setInfoApp(v.app)
              setCtxMenu(null)
            }}
          >
            {t('details')}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setTagEdit({ key: v.key, name: v.app.name })
              setCtxMenu(null)
            }}
          >
            {t('setCategory')}
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              const a = v.app
              setCtxMenu(null)
              setUninstallResult(null)
              setUninstallTarget(a)
            }}
          >
            {t('uninstallApp')}
          </button>
          {dockLnks.includes(v.app.lnk) && (
            <button
              className="ctx-item danger"
              onClick={() => {
                removeFromDock(v.app.lnk)
                setCtxMenu(null)
              }}
            >
              {t('removeFromDock')}
            </button>
          )}
        </>
      )
    }
    if (v.kind === 'link') {
      return (
        <>
          <button
            className="ctx-item"
            onClick={() => {
              const l = v.link
              setCtxMenu(null)
              void openLink(l)
            }}
          >
            {t('open')}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setAddLink({ open: true, editing: v.link })
              setCtxMenu(null)
            }}
          >
            {t('edit')}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setTagEdit({ key: v.key, name: v.link.name })
              setCtxMenu(null)
            }}
          >
            {t('setCategory')}
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              deleteLink(v.link.id)
            }}
          >
            {t('remove')}
          </button>
        </>
      )
    }
    return (
      <>
        <button
          className="ctx-item"
          onClick={() => {
            setOpenFolder(v)
            setCtxMenu(null)
          }}
        >
          {t('open')}
        </button>
        <button
          className="ctx-item danger"
          onClick={() => {
            unfolder(v.folderId)
          }}
        >
          {t('unfolder')}
        </button>
      </>
    )
  }

  const planRunnable =
    !!uninstallPlan && (uninstallPlan.kind === 'win32' || uninstallPlan.kind === 'local')
  const resultDone =
    !!uninstallResult && (uninstallResult.ok === true || uninstallResult.kind === 'removed')

  return (
    <div
      className={`launchpad bg-${settings.bgStyle}${settings.showAppNames ? '' : ' hide-names'}`}
      style={
        {
          '--icon-size': `${settings.iconSize}px`,
          '--font-size': `${settings.fontSize}px`,
          '--blur': `${settings.blur}px`,
          '--dim': settings.dim,
          '--anim': `${settings.anim}ms`,
          '--bg-color': settings.bgColor,
          '--icon-radius': ICON_RADIUS[settings.iconShape],
          '--gap': `${settings.gridGap}px`
        } as CSSProperties
      }
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {settings.bgStyle !== 'solid' && wallpaper && (
        <img className="wallpaper" src={wallpaper} alt="" draggable={false} />
      )}
      {settings.bgStyle !== 'solid' && <div className="dim" />}
      {settings.bgStyle === 'fog' && <div className="fog" />}

      <header className="topbar">
        {settings.showClock && <Clock />}
        <div className="search">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            spellCheck={false}
            tabIndex={-1}
          />
        </div>
        <div className="topbar-right">
          <button
            type="button"
            className={scanning ? 'refresh scanning' : 'refresh'}
            onClick={() => void refreshApps()}
            disabled={scanning}
            title={t('refreshHint')}
            aria-label={t('refresh')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M20 12a8 8 0 1 1-2.34-5.66" />
              <path d="M20 4v4h-4" />
            </svg>
          </button>
          {!query && (filter === 'link' ? linkTagNames : appTagNames).length > 0 && (
            <Dropdown
              value={activeTag ?? ''}
              options={[{ value: '', label: t('all') }].concat(
                (filter === 'link' ? linkTagNames : appTagNames).map((t) => ({ value: t, label: t }))
              )}
              onChange={(v) => setActiveTag(v === '' ? null : v)}
            />
          )}
          <Dropdown
            value={filter}
            options={[
              { value: 'app', label: t('tabApps') },
              { value: 'link', label: t('tabLinks') }
            ]}
            onChange={(v) => setFilter(v as 'app' | 'link')}
          />
        </div>
        <button
          className={`gear${settingsOpen ? ' active' : ''}`}
          onClick={() => setSettingsOpen((o) => !o)}
          title={t('settingsTitle')}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
          </svg>
        </button>
        {scanNote && !scanning && <div className="scan-note">{scanNote}</div>}
      </header>


      {scanning && (
        <div className="progress-overlay">
          <div className="spinner" />
          <div className="progress-text">
            {progress && progress.total > 0
              ? t('scanningApps', { done: progress.done, total: progress.total })
              : t('scanningAppsEllipsis')}
          </div>
        </div>
      )}

      {error && (
        <div className="error-box">
          <span>{error}</span>
          <button
            onClick={() => {
              setError(null)
              startScan(true)
            }}
          >
            {t('rescan')}
          </button>
          <button onClick={() => setError(null)}>{t('dismiss')}</button>
        </div>
      )}

      {!scanning && displayList.length === 0 && !error && (
        <div className="empty">{query ? t('noMatch') : t('noApps')}</div>
      )}

      <main
        ref={viewportRef}
        className={'viewport' + (dragging ? ' grabbing' : '')}
        onMouseDown={onViewportMouseDown}
      >
        <div
          className="track"
          style={{
            transform:
              'translateX(calc(' +
              -safePage * (100 / pageCount) +
              '% + ' +
              dragPx +
              'px))',
            width: pageCount * 100 + '%',
            transitionDuration: dragging ? '0ms' : settings.anim + 'ms'
          }}
        >
          {Array.from({ length: pageCount }, (_, p) => (
            <div
              key={p}
              className="grid"
              style={{
                width: 100 / pageCount + '%',
                gridTemplateColumns: 'repeat(' + cols + ', 1fr)',
                gridTemplateRows: 'repeat(' + rows + ', 1fr)'
              }}
              onDragOver={(e) => {
                if (!query && dragKey && e.dataTransfer.types.includes('application/x-cell'))
                  e.preventDefault()
              }}
              onDrop={(e) => {
                if (query || !dragKey || e.target !== e.currentTarget) return
                if (!e.dataTransfer.types.includes('application/x-cell')) return
                e.preventDefault()
                moveToDisplayIndex(dragKey, (p + 1) * pageSize - 1)
              }}
            >
              {displayList.slice(p * pageSize, (p + 1) * pageSize).map((v) => (
                <GridTile
                  key={v.key}
                  view={v}
                  draggable={!query}
                  dimmed={dragKey === v.key}
                  mergeArmed={armedKey === v.key}
                  onActivate={activate}
                  onMenu={openMenu}
                  onDragStart={onCellDragStart}
                  onDragEnter={onCellDragEnter}
                  onDragLeave={onCellDragLeave}
                  onDrop={onCellDrop}
                  onDragEnd={endDrag}
                />
              ))}
              {p === pageCount - 1 && !query && settings.linksEnabled && filter === 'link' && (
                <button
                  className="tile add-tile"
                  title={t('addLink')}
                  onClick={() => setAddLink({ open: true, editing: null })}
                >
                  <div className="add-icon">+</div>
                  <span className="tile-name">{t('addLink')}</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </main>

      {lp && (
        <div className="lp-ghost" style={{ left: lp.x, top: lp.y }}>
          {(() => {
            const v = views.find((x) => x.key === lp.key)
            if (!v) return null
            if (v.kind === 'folder')
              return (
                <div className="folder-box">
                  <div className="folder-thumbs">
                    {v.members.slice(0, 4).map((m) =>
                      m.iconUrl ? (
                        <img
                          key={m.key}
                          className="folder-thumb"
                          src={m.iconUrl}
                          alt=""
                          draggable={false}
                        />
                      ) : (
                        <div key={m.key} className="folder-thumb fb">
                          {m.name.slice(0, 1)}
                        </div>
                      )
                    )}
                  </div>
                </div>
              )
            return v.iconUrl ? (
              <img className="tile-icon" src={v.iconUrl} alt="" draggable={false} />
            ) : (
              <div className="tile-icon tile-icon-fallback">{v.name.slice(0, 1)}</div>
            )
          })()}
        </div>
      )}

      {dragKey && pageCount > 1 && (
        <>
          <div
            className="drag-edge left"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-cell')) {
                e.preventDefault()
                startEdgePaging(-1)
              }
            }}
            onDragLeave={stopEdgePaging}
            onDrop={(e) => {
              e.preventDefault()
              stopEdgePaging()
              const key = e.dataTransfer.getData('application/x-cell')
              if (key) dropAtEdge(-1, key)
            }}
          />
          <div
            className="drag-edge right"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-cell')) {
                e.preventDefault()
                startEdgePaging(1)
              }
            }}
            onDragLeave={stopEdgePaging}
            onDrop={(e) => {
              e.preventDefault()
              stopEdgePaging()
              const key = e.dataTransfer.getData('application/x-cell')
              if (key) dropAtEdge(1, key)
            }}
          />
        </>
      )}

      {pageCount > 1 && !query && (
        <nav className={'dots' + (settings.dockVisible ? ' with-dock' : '')}>
          {settings.indicator === 'dots' ? (
            Array.from({ length: pageCount }, (_, p) => (
              <button
                key={p}
                className={'dot' + (p === safePage ? ' active' : '')}
                onClick={() => gotoPage(p)}
                title={t('dropToPage', { n: p + 1 })}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-cell')) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const key = e.dataTransfer.getData('application/x-cell')
                  if (key) moveToDisplayIndex(key, p * pageSize)
                }}
              />
            ))
          ) : (
            <span className="page-number">
              {safePage + 1} / {pageCount}
            </span>
          )}
        </nav>
      )}

      {launchedId && <div className="launch-flash" />}

      {ctxMenu && (
        <div
          ref={ctxRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="ctx-title">{ctxMenu.view.name}</div>
          {ctxItems(ctxMenu.view)}
        </div>
      )}

      {openFolderLive && (
        <div className="folder-mask" onMouseDown={() => setOpenFolder(null)}>
          <div className="folder-pop" onMouseDown={(e) => e.stopPropagation()}>
            <header className="folder-pop-head">
              <input
                className="folder-name-input"
                value={openFolderLive.name}
                placeholder={t('folderNamePlaceholder')}
                spellCheck={false}
                onChange={(e) => renameFolder(openFolderLive.folderId, e.target.value)}
              />
              <button className="settings-close" onClick={() => setOpenFolder(null)} title={t('closeEsc')}>
                ✕
              </button>
            </header>
            <div className="folder-pop-grid">
              {openFolderLive.members.map((m) => (
                <div className="folder-member" key={m.key}>
                  <button
                    className="tile"
                    onClick={() => {
                      void (m.kind === 'app' ? launch(m.app) : openLink(m.link))
                      setOpenFolder(null)
                    }}
                  >
                    {m.iconUrl ? (
                      <img className="tile-icon" src={m.iconUrl} alt="" draggable={false} />
                    ) : (
                      <div className="tile-icon tile-icon-fallback">{m.name.slice(0, 1)}</div>
                    )}
                    <span className="tile-name">{m.name}</span>
                  </button>
                  <button
                    className="folder-member-out"
                    title={t('moveOut')}
                    onClick={() => moveOut(openFolderLive.folderId, m)}
                  >
                    ↗
                  </button>
                </div>
              ))}
            </div>
            <div className="folder-pop-actions">
              <button className="set-button" onClick={() => unfolder(openFolderLive.folderId)}>
                {t('unfolder')}
              </button>
            </div>
          </div>
        </div>
      )}

      {infoApp && (
        <div className="info-mask" onMouseDown={() => setInfoApp(null)}>
          <div className="info-card" onMouseDown={(e) => e.stopPropagation()}>
            <header className="info-head">
              <h3>{infoApp.name}</h3>
              <button className="settings-close" onClick={() => setInfoApp(null)} title={t('closeEsc')}>
                ✕
              </button>
            </header>
            <div className="info-rows">
              <div className="info-row">
                <span className="k">{t('infoName')}</span>
                <span className="v">{infoApp.name}</span>
              </div>
              <div className="info-row">
                <span className="k">{t('infoTarget')}</span>
                <span className="v">{infoApp.target}</span>
              </div>
              <div className="info-row">
                <span className="k">{t('infoArgs')}</span>
                <span className="v">{infoApp.args || t('noneDash')}</span>
              </div>
              <div className="info-row">
                <span className="k">{t('infoWorkdir')}</span>
                <span className="v">{infoApp.workdir || t('noneWorkdir')}</span>
              </div>
              <div className="info-row">
                <span className="k">{t('infoLnk')}</span>
                <span className="v">{infoApp.lnk}</span>
              </div>
              <div className="info-row">
                <span className="k">{t('infoIcon')}</span>
                <span className="v">{infoApp.iconFile || t('noneIcon')}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {uninstallTarget && (
        <div
          className="info-mask"
          onMouseDown={() => {
            if (!uninstallBusy) setUninstallTarget(null)
          }}
        >
          <div className="info-card uninstall-card" onMouseDown={(e) => e.stopPropagation()}>
            <header className="info-head">
              <h3>
                {uninstallResult
                  ? t('uninstallResult')
                  : t('uninstallConfirm', { name: uninstallTarget.name })}
              </h3>
            </header>
            {uninstallResult ? (
              <div className="uninstall-msg">{uninstallResult.message}</div>
            ) : !uninstallPlan ? (
              <div className="uninstall-msg">{t('findingUninstaller', { name: uninstallTarget.name })}</div>
            ) : planRunnable ? (
              <>
                <div className="uninstall-msg">
                  {t('uninstallWillRun')}
                </div>
                <div className="uninstall-plan">
                  <div className="up-how">{uninstallPlan.how}</div>
                  <div className="up-cmd">{uninstallPlan.cmd}</div>
                </div>
              </>
            ) : (
              <div className="uninstall-msg">{uninstallPlan.message}</div>
            )}
            <div className="uninstall-actions">
              {uninstallResult ? (
                <>
                  {!resultDone && (
                    <button className="set-button danger-btn" onClick={() => void removeOnly()}>
                      {t('removeIconOnly')}
                    </button>
                  )}
                  <button className="set-button" onClick={() => setUninstallTarget(null)}>
                    {t('close')}
                  </button>
                </>
              ) : (
                <>
                  <button className="set-button" disabled={uninstallBusy} onClick={() => setUninstallTarget(null)}>
                    {t('cancel')}
                  </button>
                  {uninstallPlan?.kind === 'store' && (
                    <button
                      className="set-button"
                      onClick={() => void window.api.openUninstallSettings()}
                    >
                      {t('openSystemSettings')}
                    </button>
                  )}
                  {!planRunnable && (
                    <button className="set-button" disabled={uninstallBusy} onClick={() => void removeOnly()}>
                      {t('removeIconOnly')}
                    </button>
                  )}
                  {planRunnable && (
                    <button
                      className="set-button danger-btn"
                      disabled={uninstallBusy}
                      onClick={() => void confirmUninstall()}
                    >
                      {uninstallBusy ? t('startingUninstaller') : t('confirmUninstall')}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {settings.dockVisible && (
        <Dock
          items={dockItems}
          draggingLnk={dragAppLnk}
          magnify={settings.dockMagnify}
          onDropApp={addToDock}
          onInsertAt={insertIntoDock}
          onReorder={reorderDock}
          onLaunch={launchFromDock}
          onMenu={(lnk, x, y) => {
            const full = apps.find((a) => a.lnk === lnk)
            if (full) openMenu(appViewOf(full), x, y)
          }}
        />
      )}

      {tagEdit && (
        <TagEditor
          name={tagEdit.name}
          tags={tagEdit.key.startsWith('l:') ? linkTagNames : appTagNames}
          current={itemCat[tagEdit.key] || ''}
          onAssign={(t) => setItemCategory(tagEdit.key, t)}
          onCreate={(t) => createCategory(tagEdit.key.startsWith('l:') ? 'link' : 'app', t)}
          onDelete={(t) => removeCategory(tagEdit.key.startsWith('l:') ? 'link' : 'app', t)}
          onClose={() => setTagEdit(null)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={patchSettings}
          onClose={() => setSettingsOpen(false)}
          onRescan={() => startScan(true)}
          onResetOrder={resetOrder}
          scanning={scanning}
          links={links}
          usedIcons={apps.map((a) => a.iconFile).filter(Boolean)}
          hiddenApps={hiddenApps}
          onUnhide={unhideApp}
          onUnhideAll={unhideAll}
          onDeleteLink={deleteLink}
          onEditLink={(l) => {
            setSettingsOpen(false)
            setAddLink({ open: true, editing: l })
          }}
        />
      )}

      {addLink.open && (
        <AddLinkModal
          initial={addLink.editing}
          categories={linkTagNames}
          initialCat={addLink.editing ? itemCat['l:' + addLink.editing.id] || '' : ''}
          onClose={() => setAddLink({ open: false, editing: null })}
          onSave={saveLink}
        />
      )}
    </div>
  )
}

export default App
