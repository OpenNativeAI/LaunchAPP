import { net } from 'electron'

export interface LinkMeta {
  /** 规范化后的可访问 URL（带协议） */
  url: string
  /** 从网页 <title> 解析出的站点名，失败为空 */
  title: string
  /** 自动识别到的图标 dataURL，失败为空字符串 */
  icon: string
  /** 主机名，用作兜底显示名 */
  host: string
  /** 识别结果原因，供界面给出可读提示 */
  reason: 'ok' | 'unreachable' | 'no-icon' | 'invalid'
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 补全协议，非法返回 null */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname || !u.hostname.includes('.')) return null
    return u.toString()
  } catch {
    return null
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 给候选 <link rel=icon> 打分，越大越优先 */
function iconScore(rel: string, sizes: string): number {
  let s = 0
  if (/apple-touch-icon/i.test(rel)) s += 60
  if (/(^|[\s])icon([\s]|$)/i.test(rel)) s += 40
  if (/shortcut icon/i.test(rel)) s += 30
  if (/fluid-icon/i.test(rel)) s += 25
  if (/mask-icon/i.test(rel)) s -= 20
  const m = sizes.match(/(\d+)\s*x\s*(\d+)/i)
  if (m) s += Math.min(parseInt(m[1], 10), 192) / 3
  return s
}

function getAttr(tag: string, name: string): string {
  const m = tag.match(new RegExp(name + '\s*=\s*"([^"]+)"|' + name + "\s*=\s*'([^']+)'", 'i'))
  if (!m) return ''
  return m[1] || m[2] || ''
}

async function fetchText(url: string): Promise<string> {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') || ''
  if (!/html|xml|text/i.test(type)) throw new Error('非 HTML 响应')
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf).subarray(0, Math.min(buf.byteLength, 512 * 1024))
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** 下载图标并转成 dataURL；不是有效图片或过小则返回 null */
async function tryIconDataUrl(url: string, referer: string): Promise<string | null> {
  try {
    if (url.startsWith('data:image/')) return url.length > 64 ? url : null
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5'
    }
    if (referer) headers.Referer = referer
    const res = await net.fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(9000)
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') || ''
    if (/html|xml|text/i.test(type)) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 100 || buf.byteLength > 512 * 1024) return null
    let mime = type.split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/')) {
      // 部分服务对 .ico/.png 返回 octet-stream，按扩展名兜底
      if (/\.svg/i.test(url)) mime = 'image/svg+xml'
      else if (/\.png/i.test(url)) mime = 'image/png'
      else if (/\.jpe?g/i.test(url)) mime = 'image/jpeg'
      else if (/\.webp/i.test(url)) mime = 'image/webp'
      else if (/\.gif/i.test(url)) mime = 'image/gif'
      else if (/\.ico/i.test(url)) mime = 'image/x-icon'
      else mime = ''
    }
    if (!mime.startsWith('image/')) return null
    const base64 = Buffer.from(buf).toString('base64')
    return `data:${mime};base64,${base64}`
  } catch {
    return null
  }
}

/**
 * 准确识别网站图标与标题：
 * 1) 抓取页面，解析 <title>、rel 含 icon 的 <link> 以及 og:image，按优先级逐个尝试；
 * 2) 兜底 /favicon.ico；
 * 3) 再兜底第三方 favicon 服务（可能被网络屏蔽，失败则跳过）。
 */
export async function fetchLinkMeta(rawUrl: string): Promise<LinkMeta> {
  const url = normalizeUrl(rawUrl) || ''
  let host = ''
  let title = ''
  let pageOk = false
  const ordered: string[] = []
  const push = (u: string): void => {
    if (u && !ordered.includes(u)) ordered.push(u)
  }
  if (!url) return { url: '', title: '', icon: '', host: '', reason: 'invalid' }
  try {
    host = new URL(url).host
  } catch {
    host = ''
  }

  try {
    const html = await fetchText(url)
    pageOk = true
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (tm) title = decodeEntities(tm[1])
    const scored: { href: string; score: number }[] = []
    const linkRe = /<link\b[^>]*>/gi
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html))) {
      const tag = m[0]
      const rel = getAttr(tag, 'rel') || (tag.match(/rel\s*=\s*([^"'\s>]+)/i) || [])[1] || ''
      const href = getAttr(tag, 'href')
      const sizes = getAttr(tag, 'sizes')
      if (!href || !/icon/i.test(rel)) continue
      try {
        scored.push({ href: new URL(href, url).toString(), score: iconScore(rel, sizes) })
      } catch {
        /* 忽略无法解析的 href */
      }
    }
    scored.sort((a, b) => b.score - a.score)
    // og:image / twitter:image 通常是清晰的品牌图，优先于普通 favicon
    for (const og of html.matchAll(
      /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image:secure_url|og:image|twitter:image)["'][^>]*>/gi
    )) {
      const c = getAttr(og[0], 'content')
      if (c) {
        try {
          push(new URL(c, url).toString())
        } catch {
          /* ignore */
        }
      }
    }
    for (const s of scored) push(s.href)
  } catch {
    /* 抓不到页面则走兜底 */
  }

  push(new URL('/favicon.ico', url).toString())
  if (host) {
    push(`https://www.google.com/s2/favicons?domain=${host}&sz=128`)
    push(`https://icons.duckduckgo.com/ip3/${host}.ico`)
  }

  for (const c of ordered) {
    const icon = await tryIconDataUrl(c, url)
    if (icon) return { url, title, icon, host, reason: 'ok' }
  }
  return { url, title, icon: '', host, reason: pageOk ? 'no-icon' : 'unreachable' }
}
