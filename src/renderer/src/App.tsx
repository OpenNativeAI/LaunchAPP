import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import SettingsPanel from './SettingsPanel'
import Dock, { type DockApp } from './Dock'
import AddLinkModal from './AddLinkModal'
import dropSoundUrl from './assets/voice/drop.wav'
import notifySoundUrl from './assets/voice/notify.wav'
import {
  loadSettings,
  saveSettings,
  loadLinks,
  LINKS_KEY,
  ICON_RADIUS,
  loadGrid,
  saveGrid,
  loadFolders,
  saveFolders,
  loadItemCat,
  saveItemCat,
  loadCategories,
  saveCategories,
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

interface AppInfo {
  id: string
  name: string
  target: string
  args: string
  workdir: string
  lnk: string
  iconFile: string
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

const STORE_KEYS = [
  'launchapp-settings',
  'launchapp-order',
  'launchapp-dock',
  'launchapp-lastpage',
  'launchapp-links',
  'launchapp-grid',
  'launchapp-folders',
  'launchapp-apptags',
  'launchapp-cats'
]

function collectStore(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of STORE_KEYS) {
    const v = localStorage.getItem(k)
    if (v !== null) out[k] = v
  }
  return out
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
      ? view.name + '（拖动调整位置，拖到另一个上停一下可合并）'
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
        <span className="dd-label">{cur ? cur.label : ''}</span>
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
              {o.label}
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
          <span>分类 · {name}</span>
          <button className="settings-close" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </header>
        <div className="tag-field">
          <div className="tag-field-label">归属分类</div>
          <Dropdown
            value={current}
            options={[{ value: '', label: '未分类' }].concat(
              tags.map((t) => ({ value: t, label: t }))
            )}
            onChange={onAssign}
          />
        </div>
        <div className="tag-manage">
          <div className="tag-manage-head">
            <span className="tag-field-label">分类管理</span>
            <button
              type="button"
              className="tag-add-btn"
              title="新建分类"
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
                placeholder="新分类名称"
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
                确定
              </button>
              <button
                className="tag-pop-cancel"
                onClick={() => {
                  setAdding(false)
                  setDraft('')
                }}
              >
                取消
              </button>
            </div>
          )}
          {tags.length === 0 && !adding && (
            <div className="tag-pop-empty">还没有分类，点右侧 + 新建。</div>
          )}
          <div className="tag-mgmt-list">
            {tags.map((t) => (
              <div key={t} className="tag-mgmt-item">
                <span className="tag-mgmt-name">{t}</span>
                <button
                  type="button"
                  className="tag-mgmt-del"
                  title="删除该分类"
                  onClick={() => onDelete(t)}
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
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [dockLnks, setDockLnks] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(DOCK_KEY) || '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  })
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
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
    const saved = parseInt(localStorage.getItem(LAST_PAGE_KEY) || '0', 10)
    return Number.isFinite(saved) ? saved : 0
  })
  const [wallpaper, setWallpaper] = useState('')
  const [launchedId, setLaunchedId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; view: View } | null>(null)
  const [infoApp, setInfoApp] = useState<AppInfo | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<AppInfo | null>(null)
  const [uninstallResult, setUninstallResult] = useState<{ message: string; kind: string } | null>(
    null
  )
  const [uninstallBusy, setUninstallBusy] = useState(false)
  const ctxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scannedRef = useRef(false)
  const { cols, rows } = useGridLayout(settings)
  const pageSize = cols * rows

  const setPage = useCallback((updater: number | ((p: number) => number)): void => {
    setPageRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      localStorage.setItem(LAST_PAGE_KEY, String(next))
      return next
    })
  }, [])

  const hydratedRef = useRef(false)

  // 启动时从 userData 的 JSON 文件水合设置；文件为空则把旧 localStorage 迁移过去
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const file = await window.api.storeRead()
        if (cancelled) return
        if (file && Object.keys(file).length > 0) {
          for (const [k, v] of Object.entries(file)) localStorage.setItem(k, v)
          const s = loadSettings()
          setSettings(s)
          try {
            const o = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
            if (Array.isArray(o)) setOrder(o.map(String))
            const d = JSON.parse(localStorage.getItem(DOCK_KEY) || '[]')
            if (Array.isArray(d)) setDockLnks(d.map(String))
            setLinks(loadLinks())
            setGrid(loadGrid())
            setFolders(loadFolders())
            setItemCat(loadItemCat())
            setCats(loadCategories())
          } catch { /* 损坏则维持现状 */ }
          // 仅在开启"记住页码"时才恢复上次页码，否则始终从第 0 页开始
          if (s.rememberPage) {
            const pg = parseInt(localStorage.getItem(LAST_PAGE_KEY) || '0', 10)
            if (Number.isFinite(pg)) setPageRaw(pg)
          }
        } else {
          await window.api.storeWrite(collectStore())
        }
      } catch { /* 读文件失败则继续用 localStorage */ }
      if (!cancelled) hydratedRef.current = true
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 任一持久化项变化后，防抖写入 userData 文件
  useEffect(() => {
    if (!hydratedRef.current) return
    const t = window.setTimeout(() => {
      void window.api.storeWrite(collectStore())
    }, 300)
    return () => window.clearTimeout(t)
  }, [settings, order, dockLnks, page, links, grid, folders, itemCat, cats])

  const patchSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  const startScan = useCallback(async (force = false): Promise<void> => {
    setError(null)
    setProgress({ done: 0, total: 0 })
    try {
      const list = await window.api.scanApps(force)
      setApps(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }, [])

  useEffect(() => {
    const off = window.api.onScanProgress(setProgress)
    window.api.onWallpaper((dataUrl) => {
      if (dataUrl) setWallpaper(dataUrl)
    })
    window.api.onRescan(() => startScan(true))
    if (!scannedRef.current) {
      scannedRef.current = true
      startScan()
    }
    return off
  }, [startScan])

  // 窗口重新唤起时按设置重新聚焦搜索框（input 的 autoFocus 仅在首次挂载生效）
  useEffect(() => {
    const off = window.api.onWindowShown(() => {
      if (settings.autoFocusSearch) searchRef.current?.focus()
      if (settings.soundEnabled && settings.openSound) playSound(settings.openSound)
    })
    return off
  }, [settings.autoFocusSearch, settings.soundEnabled, settings.openSound])

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
  }, [settings.soundEnabled, settings.openSound, settings.closeSound])

  useEffect(() => {
    window.api
      .setShortcut(settings.globalShortcut)
      .then((ok) => {
        if (!ok && settings.globalShortcut) {
          const label = displayShortcut(settings.globalShortcut)
          setError(
            isMouseAccelerator(settings.globalShortcut)
              ? `鼠标键「${label}」注册失败：全局鼠标钩子未能启动（可能被安全软件拦截或原生模块未加载）`
              : `快捷键 ${label} 注册失败，可能与其他程序冲突`
          )
        }
      })
      .catch(() => undefined)
  }, [settings.globalShortcut])

  useEffect(() => {
    window.api.setAutoLaunch(settings.autoLaunch).catch(() => undefined)
  }, [settings.autoLaunch])

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

  // 派生统一网格视图（应用 + 网址 + 文件夹），grid 为空时从 order/links 迁移
  const views = useMemo<View[]>(() => {
    const appMap = new Map(apps.map((a) => [a.lnk, a]))
    const linkMap = new Map(links.map((l) => [l.id, l]))
    const folderMap = new Map(folders.map((f) => [f.id, f]))
    const hidden = (a: AppInfo): boolean => settings.hideSystemApps && isSystemApp(a)
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
  }, [apps, links, folders, grid, order, settings.hideSystemApps, settings.appSort, settings.linksEnabled])

  const viewsRef = useRef(views)
  viewsRef.current = views

  // 搜索：扁平匹配所有应用与网址（含文件夹内成员），忽略分组与拖拽
  const searchViews = useMemo<LeafView[] | null>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const out: LeafView[] = []
    for (const a of apps) {
      if (settings.hideSystemApps && isSystemApp(a)) continue
      if (a.name.toLowerCase().includes(q) || a.target.toLowerCase().includes(q)) out.push(appViewOf(a))
    }
    if (settings.linksEnabled) {
      for (const l of links) {
        if (l.name.toLowerCase().includes(q) || l.url.toLowerCase().includes(q)) out.push(linkViewOf(l))
      }
    }
    return out
  }, [query, apps, links, settings.hideSystemApps, settings.linksEnabled])

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
      if (e.deltaY > 30) setPage((p) => Math.min(p + 1, pageCount - 1))
      else if (e.deltaY < -30) setPage((p) => Math.max(p - 1, 0))
    },
    [pageCount, settings.wheelPaging, settingsOpen, setPage]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (settingsOpen || openFolder || query) return
      if (e.key === 'ArrowRight') setPage((p) => Math.min(p + 1, pageCount - 1))
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(p - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pageCount, settingsOpen, openFolder, query, setPage])

  const launch = useCallback(async (info: AppInfo): Promise<void> => {
    setLaunchedId(info.id)
    try {
      window.api.hideWindow()
      await window.api.launchApp(info)
    } catch (e) {
      setError(`无法启动 ${info.name}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTimeout(() => setLaunchedId(null), 600)
    }
  }, [])

  const commitDock = useCallback((next: string[]): void => {
    setDockLnks(next)
    localStorage.setItem(DOCK_KEY, JSON.stringify(next))
  }, [])

  const commitLinks = useCallback((next: WebLink[]): void => {
    setLinks(next)
    localStorage.setItem(LINKS_KEY, JSON.stringify(next))
  }, [])

  const openLink = useCallback(async (l: WebLink): Promise<void> => {
    const ok = await window.api.openLink(l.url)
    if (!ok) setError(`无法打开 ${l.url}`)
    else window.api.hideWindow()
  }, [])

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
      const nf: Folder[] = [...folders, { id: fid, name: '文件夹', items: [tCell as Ref, srcRef] }]
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
      localStorage.setItem(ORDER_KEY, JSON.stringify(next))
    }, 300)
  }, [])

  const resetOrder = useCallback((): void => {
    commitOrder([])
    setGrid(null)
    localStorage.removeItem('launchapp-grid')
    setFolders([])
    localStorage.removeItem('launchapp-folders')
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

  const removeOnly = useCallback(async (): Promise<void> => {
    if (!uninstallTarget) return
    const lnk = uninstallTarget.lnk
    try {
      await window.api.removeShortcut(lnk)
    } catch {
      /* 忽略 */
    }
    setApps((list) => list.filter((a) => a.lnk !== lnk))
    commitOrder(order.filter((l) => l !== lnk))
    commitDock(dockLnks.filter((l) => l !== lnk))
    purgeRef({ k: 'app', id: lnk })
    setUninstallResult({ message: '已从启动器移除该图标（应用本体未卸载）。', kind: 'removed' })
  }, [uninstallTarget, order, dockLnks, commitOrder, commitDock, purgeRef])

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
        if (frac <= -0.18) setPage((pp) => Math.min(pp + 1, pageCount - 1))
        else if (frac >= 0.18) setPage((pp) => Math.max(pp - 1, 0))
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [settingsOpen, safePage, pageCount, settings.clickBlankToHide, dismiss, setPage]
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
            打开
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setInfoApp(v.app)
              setCtxMenu(null)
            }}
          >
            详细信息
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setTagEdit({ key: v.key, name: v.app.name })
              setCtxMenu(null)
            }}
          >
            设置分类…
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
            卸载应用…
          </button>
          {dockLnks.includes(v.app.lnk) && (
            <button
              className="ctx-item danger"
              onClick={() => {
                removeFromDock(v.app.lnk)
                setCtxMenu(null)
              }}
            >
              从 Dock 移除
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
            打开
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setAddLink({ open: true, editing: v.link })
              setCtxMenu(null)
            }}
          >
            编辑
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setTagEdit({ key: v.key, name: v.link.name })
              setCtxMenu(null)
            }}
          >
            设置分类…
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              deleteLink(v.link.id)
            }}
          >
            删除
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
          打开
        </button>
        <button
          className="ctx-item danger"
          onClick={() => {
            unfolder(v.folderId)
          }}
        >
          打散文件夹
        </button>
      </>
    )
  }

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
      {settings.bgStyle === 'wallpaper' && wallpaper && (
        <img className="wallpaper" src={wallpaper} alt="" draggable={false} />
      )}
      {settings.bgStyle === 'wallpaper' && <div className="dim" />}

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
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            spellCheck={false}
            autoFocus={settings.autoFocusSearch}
          />
        </div>
        <div className="topbar-right">
          {!query && (filter === 'link' ? linkTagNames : appTagNames).length > 0 && (
            <Dropdown
              value={activeTag ?? ''}
              options={[{ value: '', label: '全部' }].concat(
                (filter === 'link' ? linkTagNames : appTagNames).map((t) => ({ value: t, label: t }))
              )}
              onChange={(v) => setActiveTag(v === '' ? null : v)}
            />
          )}
          <Dropdown
            value={filter}
            options={[
              { value: 'app', label: '应用' },
              { value: 'link', label: '网址' }
            ]}
            onChange={(v) => setFilter(v as 'app' | 'link')}
          />
        </div>
        <button
          className={`gear${settingsOpen ? ' active' : ''}`}
          onClick={() => setSettingsOpen((o) => !o)}
          title="设置"
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
      </header>


      {scanning && (
        <div className="progress-overlay">
          <div className="spinner" />
          <div className="progress-text">
            {progress && progress.total > 0
              ? `正在扫描应用 ${progress.done}/${progress.total}`
              : '正在扫描应用…'}
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
            重新扫描
          </button>
          <button onClick={() => setError(null)}>忽略</button>
        </div>
      )}

      {!scanning && displayList.length === 0 && !error && (
        <div className="empty">{query ? '未找到匹配项' : '未发现可启动的应用'}</div>
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
                  title="添加网址"
                  onClick={() => setAddLink({ open: true, editing: null })}
                >
                  <div className="add-icon">+</div>
                  <span className="tile-name">添加网址</span>
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
                onClick={() => setPage(p)}
                title={'拖到此处：把图标移到第 ' + (p + 1) + ' 页'}
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
                placeholder="文件夹名称"
                spellCheck={false}
                onChange={(e) => renameFolder(openFolderLive.folderId, e.target.value)}
              />
              <button className="settings-close" onClick={() => setOpenFolder(null)} title="关闭 (Esc)">
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
                    title="移出文件夹"
                    onClick={() => moveOut(openFolderLive.folderId, m)}
                  >
                    ↗
                  </button>
                </div>
              ))}
            </div>
            <div className="folder-pop-actions">
              <button className="set-button" onClick={() => unfolder(openFolderLive.folderId)}>
                打散文件夹
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
              <button className="settings-close" onClick={() => setInfoApp(null)} title="关闭 (Esc)">
                ✕
              </button>
            </header>
            <div className="info-rows">
              <div className="info-row">
                <span className="k">名称</span>
                <span className="v">{infoApp.name}</span>
              </div>
              <div className="info-row">
                <span className="k">程序位置</span>
                <span className="v">{infoApp.target}</span>
              </div>
              <div className="info-row">
                <span className="k">启动参数</span>
                <span className="v">{infoApp.args || '（无）'}</span>
              </div>
              <div className="info-row">
                <span className="k">工作目录</span>
                <span className="v">{infoApp.workdir || '（未设置）'}</span>
              </div>
              <div className="info-row">
                <span className="k">快捷方式</span>
                <span className="v">{infoApp.lnk}</span>
              </div>
              <div className="info-row">
                <span className="k">图标文件</span>
                <span className="v">{infoApp.iconFile || '（无，显示首字占位）'}</span>
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
              <h3>{uninstallResult ? '卸载结果' : '卸载 ' + uninstallTarget.name + '？'}</h3>
            </header>
            {uninstallResult ? (
              <div className="uninstall-msg">{uninstallResult.message}</div>
            ) : (
              <div className="uninstall-msg">
                这会调用该应用自己的官方卸载程序（不是只从启动器移除图标）。
                卸载向导弹出后，请在其中完成确认。
              </div>
            )}
            <div className="uninstall-actions">
              {uninstallResult ? (
                <>
                  {uninstallResult.kind === 'notfound' && (
                    <button className="set-button danger-btn" onClick={() => void removeOnly()}>
                      仅移除图标
                    </button>
                  )}
                  <button className="set-button" onClick={() => setUninstallTarget(null)}>
                    关闭
                  </button>
                </>
              ) : (
                <>
                  <button className="set-button" disabled={uninstallBusy} onClick={() => setUninstallTarget(null)}>
                    取消
                  </button>
                  <button className="set-button danger-btn" disabled={uninstallBusy} onClick={() => void confirmUninstall()}>
                    {uninstallBusy ? '正在启动卸载程序…' : '确认卸载'}
                  </button>
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
