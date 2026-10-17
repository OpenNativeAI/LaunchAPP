import { t } from './i18n'
import { getStore, setStore } from './persist'

export interface Settings {
  // 语言
  language: 'zh' | 'en'
  // 外观
  iconSize: number
  fontSize: number
  blur: number
  dim: number
  anim: number
  bgStyle: 'wallpaper' | 'solid'
  bgColor: string
  iconShape: 'rounded' | 'square' | 'circle'
  showAppNames: boolean
  showClock: boolean
  // 布局
  autoGrid: boolean
  cols: number
  rows: number
  gridGap: number
  indicator: 'dots' | 'numbers'
  // 行为
  closeQuits: boolean
  clickBlankToHide: boolean
  wheelPaging: boolean
  rememberPage: boolean
  autoHideOnBlur: boolean
  dockVisible: boolean
  dockMagnify: boolean
  /** 界面音效总开关 */
  soundEnabled: boolean
  /** 界面出现时播放的音效 id（'' = 不播） */
  openSound: string
  /** 界面收起时播放的音效 id（'' = 不播） */
  closeSound: string
  /** 翻页/滑动切换页时播放的音效 id（'' = 不播） */
  pageSound: string
  // 快捷键与系统
  globalShortcut: string | null
  autoLaunch: boolean
  // 应用
  hideSystemApps: boolean
  appSort: 'custom' | 'name'
  // 网址
  linksEnabled: boolean
  /** 打开网址用的浏览器 key（来自系统识别到的浏览器列表）；'' = 跟随系统默认 */
  linkBrowser: string
}

/** 用户自定义的网址（快捷方式） */
export interface WebLink {
  id: string
  name: string
  url: string
  /** 图标 dataURL；为空则回退首字占位 */
  icon: string
  /** 网址 logo 是否垫白色圆角底板；undefined/true=显示，false=直接渲染 logo */
  plate?: boolean
}

/** 指向一个应用（id=快捷方式 lnk）或一个网址（id=WebLink.id）的引用 */
export type Ref = { k: 'app'; id: string } | { k: 'link'; id: string }
/** 网格中的一个格子：直接是应用/网址，或是一个文件夹 */
export type Cell = Ref | { k: 'folder'; id: string }
/** 文件夹：有序成员引用 */
export interface Folder {
  id: string
  name: string
  items: Ref[]
}

/** 把 Cell/Ref 编码成稳定的字符串 key，用于拖拽与去重 */
export function refKey(r: Ref): string {
  return r.k === 'app' ? `a:${r.id}` : `l:${r.id}`
}
export function cellKey(c: Cell): string {
  return c.k === 'folder' ? `f:${c.id}` : refKey(c)
}
export const BG_COLOR_PRESETS: { value: string; text: string }[] = [
  { value: '#241a12', text: 'colorWarmBrown' },
  { value: '#1a1a1e', text: 'colorSpaceBlack' },
  { value: '#2b2b30', text: 'colorGraphite' },
  { value: '#16213e', text: 'colorMidnight' },
  { value: '#14281d', text: 'colorInkGreen' },
  { value: '#2b1618', text: 'colorWine' }
]

export const ICON_RADIUS: Record<Settings['iconShape'], string> = {
  rounded: '16px',
  square: '4px',
  circle: '50%'
}

/** 可选音效（value 与 App.tsx 的 SOUND_URLS 键对应，'' 表示不播放） */
export const SOUND_OPTIONS: { value: string; text: string }[] = [
  { value: '', text: 'soundNone' },
  { value: 'drop', text: 'soundDrop' },
  { value: 'notify', text: 'soundNotify' }
]

export const DEFAULT_SETTINGS: Settings = {
  language: 'zh',
  iconSize: 72,
  fontSize: 13,
  blur: 60,
  dim: 0.45,
  anim: 320,
  // 默认纯色背景，仅当用户在设置中主动切换时才使用系统壁纸
  bgStyle: 'solid',
  bgColor: BG_COLOR_PRESETS[0].value,
  iconShape: 'rounded',
  showAppNames: true,
  showClock: true,
  autoGrid: true,
  cols: 7,
  rows: 4,
  gridGap: 12,
  indicator: 'dots',
  closeQuits: false,
  clickBlankToHide: false,
  wheelPaging: true,
  rememberPage: false,
  autoHideOnBlur: false,
  dockVisible: true,
  dockMagnify: true,
  soundEnabled: false,
  openSound: 'drop',
  closeSound: 'notify',
  pageSound: 'drop',
  // 唤起方式默认用鼠标中键（全局钩子）；键盘组合随时可在设置里重新录制
  globalShortcut: 'MouseMiddle',
  autoLaunch: false,
  hideSystemApps: false,
  appSort: 'custom',
  linksEnabled: true,
  linkBrowser: ''
}

const KEY = 'launchapp-settings'
export const LINKS_KEY = 'launchapp-links'
export const GRID_KEY = 'launchapp-grid'
export const FOLDERS_KEY = 'launchapp-folders'

function isRef(x: unknown): x is Ref {
  const r = x as Ref
  return !!r && (r.k === 'app' || r.k === 'link') && typeof r.id === 'string' && !!r.id
}

/** 读取顶层网格；无数据返回 null（交由迁移逻辑生成） */
export function loadGrid(): Cell[] | null {
  try {
    const raw = getStore(GRID_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    return v.filter(
      (c): c is Cell => c && (c.k === 'app' || c.k === 'link' || c.k === 'folder') && typeof c.id === 'string' && !!c.id
    )
  } catch {
    return null
  }
}

export function saveGrid(grid: Cell[]): void {
  setStore(GRID_KEY, JSON.stringify(grid))
}

/** 读取文件夹表 */
export function loadFolders(): Folder[] {
  try {
    const v = JSON.parse(getStore(FOLDERS_KEY) || '[]')
    if (!Array.isArray(v)) return []
    return v
      .filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string' && Array.isArray(f.items))
      .map((f) => ({ id: f.id, name: f.name, items: f.items.filter(isRef) }))
  } catch {
    return []
  }
}

export function saveFolders(folders: Folder[]): void {
  setStore(FOLDERS_KEY, JSON.stringify(folders))
}

export const APPTAGS_KEY = 'launchapp-apptags'

/** 视图 key -> 单一分类（每个条目只属于一个分类） */
export function loadItemCat(): Record<string, string> {
  try {
    const v = JSON.parse(getStore(APPTAGS_KEY) || '{}')
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const k of Object.keys(v)) {
      const val = (v as Record<string, unknown>)[k]
      // 兼容旧的多选数组：取第一个非空分类
      let cat = ''
      if (typeof val === 'string') cat = val
      else if (Array.isArray(val)) cat = val.find((x) => typeof x === 'string' && !!x) || ''
      if (!cat) continue
      // 旧数据以裸 lnk 为键，迁移为视图 key（a: 前缀）
      const nk = k.startsWith('a:') || k.startsWith('l:') ? k : 'a:' + k
      out[nk] = cat
    }
    return out
  } catch {
    return {}
  }
}
export function saveItemCat(map: Record<string, string>): void {
  setStore(APPTAGS_KEY, JSON.stringify(map))
}

export const CATS_KEY = 'launchapp-cats'

/** "仅移除图标"记录的隐藏快捷方式路径（不删磁盘文件，只在启动器过滤掉） */
export const HIDDEN_KEY = 'launchapp-hidden'

export function loadHidden(): string[] {
  try {
    const v = JSON.parse(getStore(HIDDEN_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
  } catch {
    return []
  }
}

export function saveHidden(lnks: string[]): void {
  setStore(HIDDEN_KEY, JSON.stringify(lnks))
}

/** 应用与网址各自独立的分类池（可含暂无条目的分类） */
export interface CategoryPools {
  app: string[]
  link: string[]
}
export function loadCategories(): CategoryPools {
  try {
    const v = JSON.parse(getStore(CATS_KEY) || '{}')
    const pick = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((t): t is string => typeof t === 'string' && !!t) : []
    return { app: pick(v?.app), link: pick(v?.link) }
  } catch {
    return { app: [], link: [] }
  }
}
export function saveCategories(pools: CategoryPools): void {
  setStore(CATS_KEY, JSON.stringify(pools))
}

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(getStore(KEY) || '{}') }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): void {
  setStore(KEY, JSON.stringify(s))
}

/** 读取已保存的网址列表 */
export function loadLinks(): WebLink[] {
  try {
    const v = JSON.parse(getStore(LINKS_KEY) || '[]')
    if (!Array.isArray(v)) return []
    return v
      .filter((x) => x && typeof x.url === 'string' && typeof x.name === 'string')
      .map((x, i) => ({
        id: typeof x.id === 'string' ? x.id : `link-${i}`,
        name: x.name,
        url: x.url,
        icon: typeof x.icon === 'string' ? x.icon : '',
        plate: x.plate !== false
      }))
  } catch {
    return []
  }
}

/** 把键盘事件转成 Electron accelerator，纯修饰键返回 null */
export function toAccelerator(e: KeyboardEvent): string | null {
  const key = e.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  let base = key
  if (key === ' ') base = 'Space'
  else if (key === 'Escape') base = 'Esc'
  else if (key === 'ArrowUp') base = 'Up'
  else if (key === 'ArrowDown') base = 'Down'
  else if (key === 'ArrowLeft') base = 'Left'
  else if (key === 'ArrowRight') base = 'Right'
  else if (key.length === 1) base = key.toUpperCase()
  parts.push(base)
  return parts.join('+')
}

const MOUSE_LABELS: Record<string, string> = {
  MouseLeft: 'mouseLeft',
  MouseMiddle: 'mouseMiddle',
  MouseBack: 'mouseBack',
  MouseForward: 'mouseForward'
}

export function mouseAccelerator(e: MouseEvent): string | null {
  if (e.button === 1) return 'MouseMiddle'
  if (e.button === 3) return 'MouseBack'
  if (e.button === 4) return 'MouseForward'
  return null
}

export function isMouseAccelerator(accel: string): boolean {
  return accel in MOUSE_LABELS
}

export function displayShortcut(accel: string): string {
  if (accel in MOUSE_LABELS) return t(MOUSE_LABELS[accel])
  return accel
    .replace('CommandOrControl', 'Ctrl')
    .replace('Super', 'Win')
    .replace(/\+/g, ' + ')
}
