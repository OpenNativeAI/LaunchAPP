import { execFile, spawn } from 'child_process'
import { basename } from 'path'

export interface BrowserInfo {
  /** StartMenuInternet 下的注册表键名，如 "Google Chrome"、"Microsoft Edge" */
  key: string
  name: string
  exe: string
}

export interface BrowserList {
  browsers: BrowserInfo[]
  /** 系统默认浏览器对应的 key，识别不到时为 '' */
  defaultKey: string
}

const ROOTS = [
  'HKLM\\SOFTWARE\\Clients\\StartMenuInternet',
  'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet',
  'HKCU\\SOFTWARE\\Clients\\StartMenuInternet'
]

// 中文系统的默认值行标的是本地化的“(默认)”，所以只按括号形状匹配
const DEFAULT_RE = /^\([^)]*\)\s+REG_\w+\s+(.*)$/
const NAMED_RE = /^(\S+)\s+REG_\w+\s+(.*)$/

/** reg.exe 在中文控制台输出 GBK，UTF-8 解出乱码时回退按 GBK 解码 */
function decode(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

function regQuery(key: string, valueName?: string): Promise<string> {
  return new Promise((resolve) => {
    const args = ['query', key]
    if (valueName) args.push('/v', valueName)
    execFile('reg.exe', args, { windowsHide: true, encoding: 'buffer' }, (err, out) => {
      resolve(err ? '' : decode(out as unknown as Buffer))
    })
  })
}

function parseValue(out: string, name: string): string {
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (name === '(Default)') {
      const m = DEFAULT_RE.exec(line)
      if (m) return m[1].trim()
    } else {
      const m = NAMED_RE.exec(line)
      if (m && m[1] === name) return m[2].trim()
    }
  }
  return ''
}

function exeFromCommand(cmd: string): string {
  const c = cmd.trim()
  if (!c) return ''
  if (c.startsWith('"')) {
    const end = c.indexOf('"', 1)
    return end > 1 ? c.slice(1, end) : ''
  }
  const m = /^(.*?\.exe)/i.exec(c)
  return m ? m[1] : c.split(/\s+/)[0]
}

async function scanRoot(root: string, seen: Set<string>, out: BrowserInfo[]): Promise<void> {
  const listing = await regQuery(root)
  const keys: string[] = []
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.trim()
    if (!/^HKEY_/i.test(line)) continue
    const key = line.split('\\').pop() || ''
    if (!key || seen.has(key.toLowerCase())) continue
    if (/^iexplore.exe$/i.test(key)) continue
    keys.push(key)
  }
  for (const key of keys) {
    const sub = root + '\\' + key
    const name = parseValue(await regQuery(sub), '(Default)') || key
    const cmd = parseValue(await regQuery(sub + '\\shell\\open\\command'), '(Default)')
    const exe = exeFromCommand(cmd)
    if (!exe) continue
    const exeKey = 'exe:' + exe.toLowerCase()
    if (seen.has(exeKey)) continue
    seen.add(key.toLowerCase())
    seen.add(exeKey)
    out.push({ key, name: name.trim(), exe })
  }
}

export async function listBrowsers(): Promise<BrowserInfo[]> {
  const out: BrowserInfo[] = []
  const seen = new Set<string>()
  for (const root of ROOTS) await scanRoot(root, seen, out)
  return out
}

/** 读 http 关联的 ProgId，再按可执行文件名对应回浏览器列表 */
export async function detectBrowsers(): Promise<BrowserList> {
  const browsers = await listBrowsers()
  const progId = parseValue(
    await regQuery(
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
      'ProgId'
    ),
    'ProgId'
  )
  let defaultKey = ''
  if (progId && /^[\w.-]+$/.test(progId)) {
    const cmd = await regQuery('HKCR\\' + progId + '\\shell\\open\\command')
    const exe = exeFromCommand(parseValue(cmd, '(Default)'))
    const base = exe ? basename(exe).toLowerCase() : ''
    const hit =
      (base && browsers.find((b) => basename(b.exe).toLowerCase() === base)) ||
      browsers.find((b) => {
        const pid = progId.toLowerCase()
        return b.key
          .split(/\s+/)
          .filter((w) => w.length >= 4)
          .some((w) => pid.includes(w.toLowerCase()))
      })
    if (hit) defaultKey = hit.key
  }
  return { browsers, defaultKey }
}

export function openWithBrowser(exe: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      const child = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', () => done(false))
      child.once('spawn', () => {
        child.unref()
        done(true)
      })
      setTimeout(() => done(false), 5000)
    } catch {
      done(false)
    }
  })
}
