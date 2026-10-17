/**
 * 渲染层唯一的持久化出口：状态直接读写 userData 里的文件。
 * localStorage 只在第一次启动时当旧数据源用一次，改动落盘并复读校验通过后就从 localStorage 清掉。
 */
export const STORE_KEYS = [
  'launchapp-settings',
  'launchapp-order',
  'launchapp-dock',
  'launchapp-lastpage',
  'launchapp-links',
  'launchapp-grid',
  'launchapp-folders',
  'launchapp-apptags',
  'launchapp-cats',
  'launchapp-hidden'
]

const cache = new Map<string, string>()
const dirty = new Map<string, string | null>()
let flushTimer: number | null = null
let booting: Promise<void> | null = null

/** ''、[]、{} 都算空值 */
function isEmptyStored(v: string | undefined): boolean {
  if (v === undefined) return true
  const s = v.trim()
  return s === '' || s === '[]' || s === '{}'
}

async function flush(map: Map<string, string | null>): Promise<void> {
  if (map.size === 0) return
  const payload: Record<string, string | null> = Object.fromEntries(map)
  map.clear()
  try {
    await window.api.storeWrite(payload)
  } catch {
    // 写盘失败就把改动放回队列，等新值覆盖或下次 flush 再试；不能吞掉
    for (const [k, v] of Object.entries(payload)) if (!map.has(k)) map.set(k, v)
  }
}

async function doBootstrap(): Promise<void> {
  let disk: Record<string, string> | null = null
  try {
    disk = await window.api.storeRead()
  } catch {
    disk = null
  }
  const fromDisk = disk || {}
  const rescue: Record<string, string> = {}
  for (const k of STORE_KEYS) {
    const d = fromDisk[k]
    // 磁盘上有这个键就认磁盘（空值代表"确实没有"，例如重置过排列），只有完全缺失才回落到旧的 localStorage
    if (d !== undefined) {
      cache.set(k, d)
      continue
    }
    const local = localStorage.getItem(k)
    if (local !== null && !isEmptyStored(local)) {
      cache.set(k, local)
      rescue[k] = local
    }
  }
  const keys = Object.keys(rescue)
  if (keys.length === 0) return
  await flush(new Map(keys.map((k) => [k, rescue[k]])))
  try {
    const back = await window.api.storeRead()
    if (!back) return
    if (keys.every((k) => !isEmptyStored(back[k]))) {
      for (const k of keys) localStorage.removeItem(k)
    }
  } catch {
    /* 校验读不到就保留本地旧键，下次启动再迁一次 */
  }
}

/** 必须在首次渲染前 await：之后 getStore 才是同步的 */
export function bootstrap(): Promise<void> {
  if (!booting) booting = doBootstrap()
  return booting
}

export function getStore(key: string): string | null {
  return cache.get(key) ?? null
}

export function setStore(key: string, value: string): void {
  cache.set(key, value)
  dirty.set(key, value)
  schedule()
}

/** 磁盘上彻底删掉这个键，界面上等价于"没有这份数据" */
export function clearStore(key: string): void {
  cache.delete(key)
  dirty.set(key, null)
  localStorage.removeItem(key)
  schedule()
}

function schedule(): void {
  if (flushTimer !== null) window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    void flush(dirty)
  }, 200)
}

/** 收起窗口意味着用户很可能马上就退出，别把没落盘的改动留在内存里 */
export function flushNow(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  void flush(dirty)
}
