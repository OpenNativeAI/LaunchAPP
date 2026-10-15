import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { WebLink } from './settings'

interface Props {
  /** 传入则为编辑，否则为新增 */
  initial?: WebLink | null
  /** 当前网址视图下已有的分类名，供勾选 */
  categories: string[]
  /** 编辑时该网址已选的分类（单选） */
  initialCat?: string
  onClose: () => void
  onSave: (link: WebLink, cat: string) => void
}

/** 补全协议并校验，非法返回空串 */
function normalize(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname || !u.hostname.includes('.')) return ''
    return u.toString()
  } catch {
    return ''
  }
}

function genId(): string {
  return `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const REASON_HINT: Record<string, string> = {
  unreachable: '无法访问该网站（网络受限或被屏蔽），请点上方虚线框手动上传 Logo',
  'no-icon': '该网站未提供可识别的图标，请手动上传 Logo',
  invalid: '网址无效'
}

export default function AddLinkModal({ initial, categories, initialCat, onClose, onSave }: Props): JSX.Element {
  const [url, setUrl] = useState(initial?.url ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? '')
  // 图标来源：auto=自动识别（默认），custom=用户手动上传
  const [iconSource, setIconSource] = useState<'auto' | 'custom'>('auto')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [autoHint, setAutoHint] = useState('')
  const [cat, setCat] = useState<string>(initialCat ?? '')
  const [plate, setPlate] = useState(initial?.plate !== false)
  const [catOpen, setCatOpen] = useState(false)
  const catRef = useRef<HTMLDivElement>(null)

  const nameTouched = useRef(!!initial?.name)
  const reqRef = useRef(0)
  // 记录最近一次已抓取过的规范化 URL，避免编辑时未改网址就覆盖已有图标
  const lastFetched = useRef(normalize(initial?.url ?? ''))
  const fileRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    urlRef.current?.focus()
  }, [])

  // Esc 关闭（捕获阶段拦截，避免触发全局隐藏窗口）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 自动识别：网址变化后防抖抓取 favicon 与标题
  useEffect(() => {
    if (iconSource !== 'auto') return
    const norm = normalize(url)
    if (!norm || norm === lastFetched.current) return
    setLoading(true)
    const reqId = ++reqRef.current
    const t = window.setTimeout(async () => {
      try {
        const meta = await window.api.fetchLinkMeta(norm)
        if (reqId !== reqRef.current) return
        lastFetched.current = norm
        if (meta.icon) {
          setIcon(meta.icon)
          setAutoHint('')
        } else {
          setAutoHint(REASON_HINT[meta.reason] || '自动识别失败，请手动上传 Logo')
        }
        if (!nameTouched.current) setName(meta.title || meta.host || '')
      } catch {
        if (reqId === reqRef.current) setAutoHint('自动识别失败，请手动上传 Logo')
      } finally {
        if (reqId === reqRef.current) setLoading(false)
      }
    }, 600)
    return () => window.clearTimeout(t)
  }, [url, iconSource])

  useEffect(() => {
    if (!catOpen) return
    const onDown = (e: MouseEvent): void => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [catOpen])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = (): void => {
      setIcon(String(reader.result))
      setIconSource('custom')
      setAutoHint('')
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  const useAuto = (): void => {
    setIconSource('auto')
    setIcon('')
    setAutoHint('')
    const norm = normalize(url)
    if (!norm) return
    setLoading(true)
    const reqId = ++reqRef.current
    void (async () => {
      try {
        const meta = await window.api.fetchLinkMeta(norm)
        if (reqId !== reqRef.current) return
        lastFetched.current = norm
        if (meta.icon) {
          setIcon(meta.icon)
          setAutoHint('')
        } else {
          setAutoHint(REASON_HINT[meta.reason] || '自动识别失败，请手动上传 Logo')
        }
        if (!nameTouched.current) setName(meta.title || meta.host || '')
      } catch {
        if (reqId === reqRef.current) setAutoHint('自动识别失败，请手动上传 Logo')
      } finally {
        if (reqId === reqRef.current) setLoading(false)
      }
    })()
  }

  const submit = (): void => {
    const finalUrl = normalize(url)
    if (!finalUrl) {
      setErr('请输入有效的网址，例如 example.com')
      return
    }
    const finalName = name.trim() || new URL(finalUrl).hostname
    onSave({ id: initial?.id || genId(), name: finalName, url: finalUrl, icon, plate }, cat)
  }

  const isEmpty = !name.trim() && !url.trim()
  const letter = (name.trim() || url.trim() || '+').slice(0, 1).toUpperCase()

  return (
    <div className="info-mask" onMouseDown={onClose}>
      <div className="link-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="info-head">
          <h3>{initial ? '编辑网址' : '添加网址'}</h3>
          <button className="settings-close" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </header>

        <div className="link-body">
          <div className="link-preview">
            <button
              type="button"
              className="link-icon-btn"
              title="点击上传 Logo"
              onClick={() => fileRef.current?.click()}
            >
              {loading && !icon ? (
                <div className="tile-icon link-icon loading">
                  <div className="spinner small" />
                </div>
              ) : icon ? (
                <img className="tile-icon link-icon" src={icon} alt="" />
              ) : (
                <div className={`tile-icon link-icon fallback${isEmpty ? ' plus' : ''}`}>{letter}</div>
              )}
              {icon && <span className="link-icon-plus" aria-hidden="true">+</span>}
            </button>
            <div className="link-preview-actions">
              <button
                type="button"
                className={`set-button small${iconSource === 'auto' ? ' active' : ''}`}
                onClick={useAuto}
              >
                自动识别
              </button>
            </div>
            {autoHint && <div className="link-auto-hint">{autoHint}</div>}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={onFile}
            />
          </div>

          <div className="link-fields">
            <label className="field">
              <span>网址</span>
              <input
                ref={urlRef}
                value={url}
                placeholder="example.com"
                spellCheck={false}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setErr('')
                }}
              />
            </label>
            <label className="field">
              <span>名称</span>
              <input
                value={name}
                placeholder="留空则自动识别网站标题"
                spellCheck={false}
                onChange={(e) => {
                  nameTouched.current = true
                  setName(e.target.value)
                }}
              />
            </label>
            <div className="link-cat">
              <span className="link-cat-label">分类</span>
              <div className={'dd dd-block' + (catOpen ? ' dd-open' : '')} ref={catRef}>
                <button type="button" className="dd-trigger" onClick={() => setCatOpen((o) => !o)}>
                  <span className="dd-label">{cat || '未分类'}</span>
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
                {catOpen && (
                  <div className="dd-menu">
                    <button
                      type="button"
                      className={'dd-item' + (cat === '' ? ' dd-item-on' : '')}
                      onClick={() => {
                        setCat('')
                        setCatOpen(false)
                      }}
                    >
                      未分类
                    </button>
                    {categories.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={'dd-item' + (cat === c ? ' dd-item-on' : '')}
                        onClick={() => {
                          setCat(c)
                          setCatOpen(false)
                        }}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="set-row plate-row">
              <span className="set-label">白色底板</span>
              <button
                type="button"
                className={`switch${plate ? ' on' : ''}`}
                onClick={() => setPlate((v) => !v)}
              >
                <span className="knob" />
              </button>
            </div>
            {err && <div className="link-error">{err}</div>}
          </div>
        </div>

        <div className="uninstall-actions">
          <button className="set-button" onClick={onClose}>
            取消
          </button>
          <button className="set-button active-btn" onClick={submit}>
            {initial ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
