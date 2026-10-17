import { promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'

/** 只有这 4 个键属于应用排列数据，落盘到 data/app/launchapp-app.json */
export const APP_STORE_KEYS = [
  'launchapp-order',
  'launchapp-dock',
  'launchapp-grid',
  'launchapp-lastpage'
]

export interface DataLayout {
  userDataDir: string
  dataDir: string
  settingsFile: string
  appDir: string
  appFile: string
  /** 上次扫描结果，开机先渲染它 */
  appsCacheFile: string
  iconsDir: string
  websiteDir: string
  /** 网址 logo 按 id 一个文件，避免每次改网址都重写整份 base64 */
  logoDir: string
  /** 坏文件留档处，单独成一组，不混进网址数据 */
  recoveryDir: string
  websiteFile(name: string): string
}

/** 渲染层上报的网址条目（icon 为 logo dataURL，落盘时拆成 logos/<id>.<ext>） */
export interface StoredLink {
  id: string
  name: string
  url: string
  icon: string
  plate?: boolean
}

/** links.jsonl 里的一行 */
interface LinkRow {
  id: string
  name: string
  url: string
  cat: string
  plate: boolean
  logo: string
}

function rowFrom(r: Record<string, unknown>): LinkRow {
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    url: String(r.url ?? ''),
    cat: typeof r.cat === 'string' ? r.cat : '',
    plate: r.plate !== false,
    logo: typeof r.logo === 'string' ? r.logo : ''
  }
}

function toLink(l: LinkRow, icon: string): Record<string, unknown> {
  return { id: l.id, name: l.name, url: l.url, icon, plate: l.plate }
}

/** 并集且保序：声明过但暂时没有条目的分类不会因此消失 */
function unionOrdered(...lists: string[][]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const v of list) {
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

export function createLayout(userDataDir: string): DataLayout {
  const dataDir = join(userDataDir, 'data')
  const appDir = join(dataDir, 'app')
  const websiteDir = join(dataDir, 'website')
  return {
    userDataDir,
    dataDir,
    settingsFile: join(dataDir, 'launchapp-settings.json'),
    appDir,
    appFile: join(appDir, 'launchapp-app.json'),
    appsCacheFile: join(appDir, 'launchapp-apps-cache.json'),
    iconsDir: join(appDir, 'icons'),
    websiteDir,
    logoDir: join(websiteDir, 'logos'),
    recoveryDir: join(dataDir, '_recovered'),
    websiteFile: (name: string) => join(websiteDir, name)
  }
}

/** 原子写：先写 .tmp 再 rename，崩溃时最多留一个临时文件，不会截断正式文件 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/** 把坏掉/将被清空的原件改名留档，绝不再写回原路径，也不删除 */
async function archiveDamaged(L: DataLayout, file: string, tag: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  try {
    await fs.mkdir(L.recoveryDir, { recursive: true })
    await fs.rename(file, join(L.recoveryDir, basename(file) + '.' + stamp + '.' + tag))
  } catch {
    /* 归档失败也不能继续覆盖 */
  }
}

/** 读 { 键: JSON字符串 } 形式的存储文件；不存在返回 null，损坏则归档后返回 null */
export async function readJsonFile(
  L: DataLayout,
  file: string
): Promise<Record<string, string> | null> {
  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : null
  } catch {
    await archiveDamaged(L, file, 'corrupt')
    return null
  }
}

/** 数组序列化为 JSON Lines（每行一个对象） */
function toLines(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}

/** 读 JSON Lines：只跳过坏行，不整文件作废；有坏行时先归档原件 */
async function readJsonl(L: DataLayout, file: string): Promise<Record<string, unknown>[]> {
  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const rows: Record<string, unknown>[] = []
  let bad = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t) as unknown
      if (v && typeof v === 'object') rows.push(v as Record<string, unknown>)
      else bad += 1
    } catch {
      bad += 1
    }
  }
  if (bad > 0) await archiveDamaged(L, file, 'bad')
  return rows
}

/** 与磁盘现有内容合并后写入：本次没上报的键保持原值，drop 用于把已迁走的键彻底删掉 */
async function mergeJsonFile(
  L: DataLayout,
  file: string,
  incoming: Record<string, string>,
  drop: string[] = []
): Promise<void> {
  const prev = (await readJsonFile(L, file)) || {}
  const next = { ...prev, ...incoming }
  for (const k of drop) delete next[k]
  await writeTextAtomic(file, JSON.stringify(next))
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
    const v = JSON.parse(raw || '{}') as unknown
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const k of Object.keys(v)) {
      const item = (v as Record<string, unknown>)[k]
      if (typeof item === 'string') out[k] = item
    }
    return out
  } catch {
    return {}
  }
}

/** 目标不存在时，按顺序尝试把旧位置整体搬过来（同盘 rename，不复制不删除） */
async function moveInto(dst: string, ...srcs: string[]): Promise<void> {
  try {
    await fs.access(dst)
    return
  } catch {
    /* 目标不存在，继续迁移 */
  }
  await fs.mkdir(dirname(dst), { recursive: true })
  for (const src of srcs) {
    try {
      await fs.rename(src, dst)
      return
    } catch {
      /* 该旧位置不存在，试下一个 */
    }
  }
}

/** 自有数据布局：data/launchapp-settings.json + data/app/{icons,launchapp-app.json} + data/website/ */
export async function migrateLegacyStorage(L: DataLayout): Promise<void> {
  await fs.mkdir(L.dataDir, { recursive: true })
  await moveInto(L.settingsFile, join(L.userDataDir, 'launchapp-settings.json'))
  await moveInto(L.appFile, join(L.dataDir, 'launchapp-app.json'))
  await moveInto(L.iconsDir, join(L.dataDir, 'icons'), join(L.userDataDir, 'icons'))
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
}
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon'
}

/** dataURL -> 二进制；解不出来就返回 null，让调用方保留原图标而不是写坏文件 */
function parseDataUrl(s: string): { ext: string; bytes: Buffer } | null {
  const comma = s.indexOf(',')
  if (comma < 0) return null
  const head = s.slice(0, comma)
  if (!head.startsWith('data:') || !head.includes(';base64')) return null
  const mime = head.slice(5).split(';')[0].trim()
  const bytes = Buffer.from(s.slice(comma + 1), 'base64')
  if (bytes.length === 0) return null
  return { ext: MIME_EXT[mime] || 'png', bytes }
}

function logoBase(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'link'
}

/** 按 id 找已存在的 logo 文件（老数据没记录文件名时的兜底） */
async function findLogoFile(L: DataLayout, id: string, hint: string): Promise<string> {
  const prefix = logoBase(id)
  try {
    const names = await fs.readdir(L.logoDir)
    if (hint && names.includes(hint)) return hint
    return names.find((n) => n.startsWith(prefix + '.')) || ''
  } catch {
    return ''
  }
}

async function readLogoDataUrl(L: DataLayout, file: string): Promise<string> {
  if (!file) return ''
  try {
    const bytes = await fs.readFile(join(L.logoDir, file))
    const mime = EXT_MIME[extname(file).slice(1)] || 'image/png'
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return ''
  }
}

/** 只有字节真的变了才重写，且只重写这一个文件 */
async function writeLogoFile(L: DataLayout, id: string, dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return ''
  const file = logoBase(id) + '.' + parsed.ext
  const target = join(L.logoDir, file)
  try {
    if ((await fs.readFile(target)).equals(parsed.bytes)) return file
  } catch {
    /* 首次写入 */
  }
  await fs.mkdir(L.logoDir, { recursive: true })
  const tmp = target + '.tmp'
  await fs.writeFile(tmp, parsed.bytes)
  await fs.rename(tmp, target)
  return file
}

/** 旧布局把整份 base64 堆在 logos.jsonl 里：拆成按 id 命名的文件，原件改名留档 */
async function migrateLogoFiles(L: DataLayout): Promise<void> {
  const file = L.websiteFile('logos.jsonl')
  const rows = await readJsonl(L, file)
  if (rows.length === 0) return
  let moved = 0
  for (const r of rows) {
    const id = typeof r.id === 'string' ? r.id : ''
    if (!id) continue
    if (await writeLogoFile(L, id, String(r.data ?? ''))) moved += 1
  }
  if (moved > 0) await archiveDamaged(L, file, 'logos-to-files')
}

/**
 * 读回渲染层期望的单一键表。
 * 返回 null 表示所有来源都读不到（全新安装或整盘损坏）；
 * 单个来源损坏时只丢那一份，坏文件已留档。
 */
export async function readStore(L: DataLayout): Promise<Record<string, string> | null> {
  const settings = await readJsonFile(L, L.settingsFile)
  let app = await readJsonFile(L, L.appFile)
  if (settings === null && app === null) return null
  const merged = { ...(settings || {}) }
  if (app === null) {
    // 旧版本把排列数据混在设置文件里，首次读取时拆分成两个文件
    app = {}
    let split = false
    for (const k of APP_STORE_KEYS) {
      if (merged[k] === undefined) continue
      app[k] = merged[k]
      delete merged[k]
      split = true
    }
    if (split) {
      await writeTextAtomic(L.appFile, JSON.stringify(app))
      await writeTextAtomic(L.settingsFile, JSON.stringify(merged))
    }
  }
  const obj: Record<string, string> = { ...merged, ...app }
  await migrateLogoFiles(L)
  // 把 website 文件夹里的网址数据重新合并回渲染层期望的键结构
  const cats = parseCats(obj['launchapp-cats'])
  const linkCats = (await readJsonl(L, L.websiteFile('categories.jsonl')))
    .map((r) => (typeof r.name === 'string' ? r.name : ''))
    .filter(Boolean)
  obj['launchapp-cats'] = JSON.stringify({ app: cats.app, link: linkCats })

  const apptags = parseApptags(obj['launchapp-apptags'])
  const links: Record<string, unknown>[] = []
  for (const r of (await readJsonl(L, L.websiteFile('links.jsonl'))).map(rowFrom)) {
    if (r.cat && r.id) apptags['l:' + r.id] = r.cat
    const icon = await readLogoDataUrl(L, await findLogoFile(L, r.id, r.logo))
    links.push(toLink(r, icon))
  }
  obj['launchapp-apptags'] = JSON.stringify(apptags)
  obj['launchapp-links'] = JSON.stringify(links)
  return obj
}

/**
 * 写盘。渲染层现在按单个键上报，所以：
 * - 两个 JSON 文件与磁盘内容合并，没上报的键保持原值，值为 null 的键才真删
 * - 分类/标签只在本次带了对应键时才重算，否则单键写入会把分类清成空
 * - 网址文件只在本次涉及网址、标签或分类时才动；网址键缺失或解析失败就完全不动
 * - 要写空网址表时先归档旧文件
 */
export async function writeStore(
  L: DataLayout,
  data: Record<string, string | null>
): Promise<boolean> {
  const safe: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!k.startsWith('launchapp-')) continue
    if (typeof v === 'string') safe[k] = v
    else if (v === null) dropped.push(k)
  }
  const prevSettings = (await readJsonFile(L, L.settingsFile)) || {}
  const incomingTags = 'launchapp-apptags' in safe ? parseApptags(safe['launchapp-apptags']) : null
  const incomingCats = 'launchapp-cats' in safe ? parseCats(safe['launchapp-cats']) : null
  const tags = incomingTags || parseApptags(prevSettings['launchapp-apptags'])
  const cats = incomingCats || parseCats(prevSettings['launchapp-cats'])

  let links: StoredLink[] | null = null
  const linksRaw = safe['launchapp-links']
  if (linksRaw !== undefined) {
    try {
      const parsed = JSON.parse(linksRaw) as unknown
      if (Array.isArray(parsed)) links = parsed as StoredLink[]
    } catch {
      links = null
    }
  }

  const linksFile = L.websiteFile('links.jsonl')
  const rowsOnDisk = (await readJsonl(L, linksFile)).map(rowFrom)
  let rows = rowsOnDisk
  if (links) {
    rows = links.map((l) => {
      const old = rowsOnDisk.find((r) => r.id === l.id)
      const cat = tags['l:' + l.id] || old?.cat || ''
      return {
        id: l.id,
        name: l.name,
        url: l.url,
        cat,
        plate: l.plate !== false,
        logo: old?.logo || ''
      }
    })
    if (rows.length === 0 && rowsOnDisk.length > 0) await archiveDamaged(L, linksFile, 'before-empty')
  } else if (dropped.includes('launchapp-links')) {
    rows = []
  } else if (incomingTags) {
    rows = rowsOnDisk.map((r) => {
      const c = incomingTags['l:' + r.id]
      return c === undefined ? r : { ...r, cat: c }
    })
  }

  if (links || incomingTags || incomingCats || dropped.includes('launchapp-links')) {
    for (const row of rows) {
      const src = links?.find((l) => l.id === row.id)
      if (!src?.icon) continue
      const file = await writeLogoFile(L, row.id, src.icon)
      if (file) row.logo = file
    }
    const poolNames = (await readJsonl(L, L.websiteFile('categories.jsonl')))
      .map((r) => (typeof r.name === 'string' ? r.name : ''))
      .filter(Boolean)
    await writeTextAtomic(
      L.websiteFile('categories.jsonl'),
      toLines(unionOrdered(cats.link, poolNames, rows.map((r) => r.cat)).map((n) => ({ name: n })))
    )
    await writeTextAtomic(
      linksFile,
      toLines(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          url: r.url,
          cat: r.cat,
          plate: r.plate,
          logo: r.logo
        }))
      )
    )
  }

  // 设置文件：cats 只留 app 池，apptags 只留非 l: 键，links 永远不进设置文件
  if (incomingTags || incomingCats) {
    const appPool = unionOrdered(
      cats.app,
      Object.keys(tags)
        .filter((k) => k.startsWith('a:') && tags[k])
        .map((k) => tags[k])
    )
    safe['launchapp-cats'] = JSON.stringify({ app: appPool, link: [] })
    const appTags: Record<string, string> = {}
    for (const k of Object.keys(tags)) if (!k.startsWith('l:')) appTags[k] = tags[k]
    safe['launchapp-apptags'] = JSON.stringify(appTags)
  }
  delete safe['launchapp-links']

  const appPart: Record<string, string> = {}
  for (const k of APP_STORE_KEYS) {
    if (safe[k] !== undefined) {
      appPart[k] = safe[k]
      delete safe[k]
    }
  }
  const dropApp = APP_STORE_KEYS.filter((k) => dropped.includes(k))
  const dropSet = dropped.filter((k) => !APP_STORE_KEYS.includes(k))
  await mergeJsonFile(L, L.appFile, appPart, dropApp)
  await mergeJsonFile(L, L.settingsFile, safe, [...APP_STORE_KEYS, 'launchapp-links', ...dropSet])
  return true
}
