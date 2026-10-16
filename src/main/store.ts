import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'

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
  iconsDir: string
  websiteDir: string
  /** 坏文件留档处，单独成一组，不混进网址数据 */
  recoveryDir: string
  websiteFile(name: string): string
}

/** 渲染层上报的网址条目（icon 为 logo base64，落盘时拆到 logos.jsonl） */
export interface StoredLink {
  id: string
  name: string
  url: string
  icon: string
  plate?: boolean
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
    iconsDir: join(appDir, 'icons'),
    websiteDir,
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
  // 把 website 文件夹里的网址数据重新合并回渲染层期望的键结构
  const cats = parseCats(obj['launchapp-cats'])
  const linkCats = (await readJsonl(L, L.websiteFile('categories.jsonl')))
    .map((r) => (typeof r.name === 'string' ? r.name : ''))
    .filter(Boolean)
  obj['launchapp-cats'] = JSON.stringify({ app: cats.app, link: linkCats })

  const linkRows = await readJsonl(L, L.websiteFile('links.jsonl'))
  const logoRows = await readJsonl(L, L.websiteFile('logos.jsonl'))
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
}

/**
 * 写盘。渲染层只上报 localStorage 里实际存在的键，所以：
 * - 两个 JSON 文件与磁盘内容合并，没上报的键保持原值
 * - 网址键缺失或解析失败时完全不动网址文件
 * - 要写空网址表时先归档旧文件
 */
export async function writeStore(
  L: DataLayout,
  data: Record<string, string>
): Promise<boolean> {
  const safe: Record<string, string> = {}
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k.startsWith('launchapp-') && typeof v === 'string') safe[k] = v
  }
  const cats = parseCats(safe['launchapp-cats'])
  const apptags = parseApptags(safe['launchapp-apptags'])
  const linksRaw = safe['launchapp-links']
  let links: StoredLink[] | null = null
  if (linksRaw !== undefined) {
    try {
      const parsed = JSON.parse(linksRaw) as unknown
      if (Array.isArray(parsed)) links = parsed as StoredLink[]
    } catch {
      links = null
    }
  }
  // 分类池 = 已声明池 ∪ 实际被条目使用的分类（自愈：只赋值未建池也不会漏写）
  const linkPool = new Set(cats.link)
  if (links) {
    for (const l of links) {
      const c = apptags['l:' + l.id]
      if (c) linkPool.add(c)
    }
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

  if (links) {
    const linksFile = L.websiteFile('links.jsonl')
    const rows = await readJsonl(L, linksFile)
    if (links.length === 0 && rows.length > 0) await archiveDamaged(L, linksFile, 'before-empty')
    const linkRows = links.map((l) => ({
      id: l.id,
      name: l.name,
      url: l.url,
      cat: apptags['l:' + l.id] || '',
      plate: l.plate !== false
    }))
    const logoRows = links.map((l) => ({ id: l.id, data: l.icon || '' })).filter((r) => r.data)
    await writeTextAtomic(
      L.websiteFile('categories.jsonl'),
      toLines([...linkPool].map((n) => ({ name: n })))
    )
    await writeTextAtomic(linksFile, toLines(linkRows))
    await writeTextAtomic(L.websiteFile('logos.jsonl'), toLines(logoRows))
  }

  const appPart: Record<string, string> = {}
  for (const k of APP_STORE_KEYS) {
    if (safe[k] !== undefined) {
      appPart[k] = safe[k]
      delete safe[k]
    }
  }
  await mergeJsonFile(L, L.appFile, appPart)
  await mergeJsonFile(L, L.settingsFile, safe, [...APP_STORE_KEYS, 'launchapp-links'])
  return true
}
