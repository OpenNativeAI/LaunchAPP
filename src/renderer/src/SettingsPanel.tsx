import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import {
  BG_COLOR_PRESETS,
  DEFAULT_SETTINGS,
  displayShortcut,
  toAccelerator,
  SOUND_OPTIONS,
  type Settings,
  type WebLink
} from './settings'

declare const __APP_VERSION__: string

const AUTHOR = '（待填写作者名）'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  onRescan: () => void
  onResetOrder: () => void
  scanning: boolean
  links: WebLink[]
  onDeleteLink: (id: string) => void
  onEditLink: (link: WebLink) => void
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  disabled,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: string
  disabled?: boolean
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <label className={`set-row${disabled ? ' disabled' : ''}`}>
      <span className="set-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--pct': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="set-value">{display ?? value}</span>
    </label>
  )
}

function Dropdown({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: number
  options: { value: number; text: string }[]
  onChange: (v: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = options.find((o) => o.value === value)
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <div className="dropdown" ref={ref}>
        <button
          type="button"
          className={`dropdown-btn${open ? ' open' : ''}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{current ? current.text : value}</span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className="dropdown-menu">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`dropdown-item${o.value === value ? ' active' : ''}`}
                onClick={() => {
                  setOpen(false)
                  onChange(o.value)
                }}
              >
                {o.text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <button
        type="button"
        className={`switch${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; text: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`seg${o.value === value ? ' active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  )
}

function ColorSwatches({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="set-row">
      <span className="set-label">背景颜色</span>
      <div className="swatches">
        {BG_COLOR_PRESETS.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`swatch${c.value === value ? ' active' : ''}`}
            style={{ background: c.value }}
            title={c.text}
            onClick={() => onChange(c.value)}
          />
        ))}
      </div>
    </div>
  )
}

function ShortcutRecorder({
  value,
  onCommit
}: {
  value: string | null
  onCommit: (accel: string | null) => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const [dbg, setDbg] = useState('')
  // 用 ref 持有最新 onCommit，避免每次父组件渲染都重挂监听（否则会漏掉鼠标事件）
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  useEffect(() => {
    if (!recording) return
    const handler = (e: globalThis.KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const accel = toAccelerator(e)
      if (!accel) return
      setRecording(false)
      commitRef.current(accel)
    }
    window.addEventListener('keydown', handler, true)

    // 鼠标键改由主进程的全局钩子录入：Chromium 会吞掉中键事件，渲染层收不到
    const off = window.api.onMouseCaptured((button) => {
      setDbg('收到鼠标键 #' + button)
      const accel =
        button === 3
          ? 'MouseMiddle'
          : button === 4
            ? 'MouseBack'
            : button === 5
              ? 'MouseForward'
              : null
      if (!accel) {
        setDbg('左/右键不能作唤起键，请按中键或侧键')
        return
      }
      setRecording(false)
      commitRef.current(accel)
    })
    void window.api.startMouseCapture().then((ok) => {
      if (!ok) setDbg('鼠标钩子不可用，无法录入鼠标键')
    })
    return () => {
      window.removeEventListener('keydown', handler, true)
      off()
      void window.api.stopMouseCapture()
    }
  }, [recording])

  return (
    <div className="set-row">
      <span className="set-label">全局唤起快捷键</span>
      <button
        type="button"
        className={`recorder${recording ? ' recording' : ''}`}
        onClick={() => setRecording((r) => !r)}
      >
        {recording ? '按下组合键 或 点击鼠标键…' : value ? displayShortcut(value) : '未设置'}
      </button>
      {recording && <span className="recorder-dbg">{dbg || '等待鼠标事件…'}</span>}
      {value && (
        <button type="button" className="set-button small" onClick={() => onCommit(null)}>
          清除
        </button>
      )}
    </div>
  )
}

const TABS = [
  { id: 'appearance', title: '外观' },
  { id: 'layout', title: '布局' },
  { id: 'behavior', title: '行为' },
  { id: 'system', title: '快捷键与系统' },
  { id: 'apps', title: '应用' },
  { id: 'links', title: '网址' },
  { id: 'storage', title: '存储' },
  { id: 'about', title: '关于' }
] as const

type TabId = (typeof TABS)[number]['id']

interface StorageInfo {
  dir: string
  iconsDir: string
  settingsFile: string
  settingsSize: number
  iconsCount: number
  iconsSize: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function StorageSection(): JSX.Element {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    window.api
      .storageInfo()
      .then((d) => alive && setInfo(d))
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
    }
  }, [])

  const open = (target: 'root' | 'icons'): void => {
    window.api
      .openStorage(target)
      .then((msg) => {
        if (msg) setErr('无法打开文件夹：' + msg)
      })
      .catch((e) => setErr(String(e)))
  }

  return (
    <>
      <div className="set-hint">点击「打开文件夹」可在资源管理器中定位对应存储位置。</div>
      {err && <div className="set-hint">{err}</div>}
      <div className="set-row">
        <span className="set-label">数据与设置存储位置</span>
        <button className="set-button small" onClick={() => open('root')}>
          打开文件夹
        </button>
      </div>
      {info && <div className="storage-path">{info.dir}</div>}
      <div className="set-row">
        <span className="set-label">图标缓存</span>
        <button className="set-button small" onClick={() => open('icons')}>
          打开文件夹
        </button>
      </div>
      {info && (
        <div className="storage-path">
          {info.iconsCount} 个文件 · {formatBytes(info.iconsSize)}
        </div>
      )}
    </>
  )
}

export default function SettingsPanel({
  settings,
  onChange,
  onClose,
  onRescan,
  onResetOrder,
  scanning,
  links,
  onDeleteLink,
  onEditLink
}: Props): JSX.Element {
  const [tab, setTab] = useState<TabId>('appearance')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="nav-head">设置</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`nav-item${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.title}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <header className="settings-head">
            <h2>{TABS.find((t) => t.id === tab)?.title}</h2>
            <button className="settings-close" onClick={onClose} title="关闭 (Esc)">
              ✕
            </button>
          </header>

          <div className="settings-scroll">
            {tab === 'appearance' && (
              <>
                <Segmented
                  label="背景样式"
                  value={settings.bgStyle}
                  options={[
                    { value: 'wallpaper', text: '系统壁纸' },
                    { value: 'solid', text: '纯色' }
                  ]}
                  onChange={(v) => onChange({ bgStyle: v })}
                />
                {settings.bgStyle === 'solid' && (
                  <ColorSwatches
                    value={settings.bgColor}
                    onChange={(v) => onChange({ bgColor: v })}
                  />
                )}
                <Segmented
                  label="图标形状"
                  value={settings.iconShape}
                  options={[
                    { value: 'rounded', text: '圆角' },
                    { value: 'square', text: '方形' },
                    { value: 'circle', text: '圆形' }
                  ]}
                  onChange={(v) => onChange({ iconShape: v })}
                />
                <Slider
                  label="图标大小"
                  value={settings.iconSize}
                  min={48}
                  max={112}
                  step={4}
                  display={`${settings.iconSize}px`}
                  onChange={(v) => onChange({ iconSize: v })}
                />
                <Slider
                  label="文字大小"
                  value={settings.fontSize}
                  min={11}
                  max={18}
                  display={`${settings.fontSize}px`}
                  onChange={(v) => onChange({ fontSize: v })}
                />
                <Toggle
                  label="显示应用名称"
                  checked={settings.showAppNames}
                  onChange={(v) => onChange({ showAppNames: v })}
                />
                <Toggle
                  label="显示时钟"
                  checked={settings.showClock}
                  onChange={(v) => onChange({ showClock: v })}
                />
                <Slider
                  label="背景模糊"
                  value={settings.blur}
                  min={0}
                  max={120}
                  step={2}
                  display={settings.blur === 0 ? '关闭' : `${settings.blur}px`}
                  disabled={settings.bgStyle !== 'wallpaper'}
                  onChange={(v) => onChange({ blur: v })}
                />
                <Slider
                  label="背景压暗"
                  value={Math.round(settings.dim * 100)}
                  min={0}
                  max={80}
                  display={`${Math.round(settings.dim * 100)}%`}
                  disabled={settings.bgStyle !== 'wallpaper'}
                  onChange={(v) => onChange({ dim: v / 100 })}
                />
                <Slider
                  label="翻页动画时长"
                  value={settings.anim}
                  min={0}
                  max={800}
                  step={20}
                  display={settings.anim === 0 ? '关闭' : `${settings.anim}ms`}
                  onChange={(v) => onChange({ anim: v })}
                />
              </>
            )}

            {tab === 'layout' && (
              <>
                <Toggle
                  label="自动网格（按窗口大小）"
                  checked={settings.autoGrid}
                  onChange={(v) => onChange({ autoGrid: v })}
                />
                <Dropdown
                  label="每行列数"
                  value={settings.cols}
                  options={Array.from({ length: 10 }, (_, k) => ({
                    value: k + 3,
                    text: `${k + 3} 列`
                  }))}
                  onChange={(v) => onChange({ cols: v, autoGrid: false })}
                />
                <Dropdown
                  label="每页行数"
                  value={settings.rows}
                  options={Array.from({ length: 7 }, (_, k) => ({
                    value: k + 2,
                    text: `${k + 2} 行`
                  }))}
                  onChange={(v) => onChange({ rows: v, autoGrid: false })}
                />
                <Segmented
                  label="页码指示器"
                  value={settings.indicator}
                  options={[
                    { value: 'dots', text: '圆点' },
                    { value: 'numbers', text: '数字' }
                  ]}
                  onChange={(v) => onChange({ indicator: v })}
                />
                <Slider
                  label="图标间距"
                  value={settings.gridGap}
                  min={0}
                  max={32}
                  step={2}
                  display={`${settings.gridGap}px`}
                  onChange={(v) => onChange({ gridGap: v })}
                />
                <div className="set-hint">手动选择行列数会自动关闭"自动网格"。</div>
              </>
            )}

            {tab === 'behavior' && (
              <>
                <Toggle
                  label="显示底部 Dock 栏"
                  checked={settings.dockVisible}
                  onChange={(v) => onChange({ dockVisible: v })}
                />
                <Toggle
                  label="关闭时退出程序（默认隐藏到托盘）"
                  checked={settings.closeQuits}
                  onChange={(v) => onChange({ closeQuits: v })}
                />
                <Toggle
                  label="点击空白处关闭"
                  checked={settings.clickBlankToHide}
                  onChange={(v) => onChange({ clickBlankToHide: v })}
                />
                <Toggle
                  label="滚轮翻页"
                  checked={settings.wheelPaging}
                  onChange={(v) => onChange({ wheelPaging: v })}
                />
                <Toggle
                  label="记住上次浏览页码"
                  checked={settings.rememberPage}
                  onChange={(v) => onChange({ rememberPage: v })}
                />
                <Toggle
                  label="启动时自动聚焦搜索框"
                  checked={settings.autoFocusSearch}
                  onChange={(v) => onChange({ autoFocusSearch: v })}
                />
                <Toggle
                  label="失去焦点时自动隐藏窗口"
                  checked={settings.autoHideOnBlur}
                  onChange={(v) => onChange({ autoHideOnBlur: v })}
                />
                <Toggle
                  label="Dock 放大镜效果"
                  checked={settings.dockMagnify}
                  onChange={(v) => onChange({ dockMagnify: v })}
                />
                <Toggle
                  label="开启音效"
                  checked={settings.soundEnabled}
                  onChange={(v) => onChange({ soundEnabled: v })}
                />
                {settings.soundEnabled && (
                  <>
                    <Segmented
                      label="出现时"
                      value={settings.openSound}
                      options={SOUND_OPTIONS}
                      onChange={(v) => onChange({ openSound: v })}
                    />
                    <Segmented
                      label="关闭时"
                      value={settings.closeSound}
                      options={SOUND_OPTIONS}
                      onChange={(v) => onChange({ closeSound: v })}
                    />
                  </>
                )}
              </>
            )}

            {tab === 'system' && (
              <>
                <ShortcutRecorder
                  value={settings.globalShortcut}
                  onCommit={(accel) => onChange({ globalShortcut: accel })}
                />
                <Toggle
                  label="开机自动启动"
                  checked={settings.autoLaunch}
                  onChange={(v) => onChange({ autoLaunch: v })}
                />
                <div className="set-hint">
                  提示：托盘图标常驻，左键点击或按全局快捷键唤起，右键菜单可退出程序。
                  按 Esc 只关闭设置页，再按一次才隐藏窗口。
                  全局快捷键支持键盘组合键，也支持单独的鼠标键（中键 / 侧键；鼠标键不能搭配修饰键）。
                </div>
              </>
            )}

            {tab === 'apps' && (
              <>
                <Segmented
                  label="应用排序方式"
                  value={settings.appSort}
                  options={[
                    { value: 'custom', text: '自定义（拖拽）' },
                    { value: 'name', text: '按名称' }
                  ]}
                  onChange={(v) => onChange({ appSort: v })}
                />
                {settings.appSort === 'name' && (
                  <div className="set-hint">按名称排序时，图标位置自动排列，拖拽调整不生效。</div>
                )}
                <Toggle
                  label="隐藏系统工具（控制面板、字符映射表等）"
                  checked={settings.hideSystemApps}
                  onChange={(v) => onChange({ hideSystemApps: v })}
                />
                <div className="set-row">
                  <span className="set-label">恢复默认排序（清除拖拽调整的位置）</span>
                  <button className="set-button" onClick={onResetOrder}>
                    重置排序
                  </button>
                </div>
                <div className="set-row">
                  <span className="set-label">重新扫描并重建图标缓存</span>
                  <button className="set-button" onClick={onRescan} disabled={scanning}>
                    {scanning ? '扫描中…' : '重新扫描'}
                  </button>
                </div>
                <div className="set-row">
                  <span className="set-label">恢复默认设置</span>
                  <button className="set-button" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
                    恢复
                  </button>
                </div>
              </>
            )}

            {tab === 'links' && (
              <>
                <Toggle
                  label="启用网址模块（顶部切换 应用 / 网址）"
                  checked={settings.linksEnabled}
                  onChange={(v) => onChange({ linksEnabled: v })}
                />
                <div className="set-hint">网址与应用各自独立管理，统一汇集在本设置面板中。</div>
                {links.length === 0 ? (
                  <div className="set-hint">还没有网址。切到“网址”视图，点击“+”即可添加。</div>
                ) : (
                  <div className="link-manage">
                    {links.map((l) => (
                      <div key={l.id} className="link-manage-row">
                        {l.icon ? (
                          <img className="link-manage-icon" src={l.icon} alt="" />
                        ) : (
                          <div className="link-manage-icon fallback">{l.name.slice(0, 1)}</div>
                        )}
                        <div className="link-manage-info">
                          <span className="link-manage-name">{l.name}</span>
                          <span className="link-manage-url">{l.url}</span>
                        </div>
                        <button className="set-button small" onClick={() => onEditLink(l)}>
                          编辑
                        </button>
                        <button
                          className="set-button small danger-btn"
                          onClick={() => onDeleteLink(l.id)}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === 'storage' && <StorageSection />}

            {tab === 'about' && (
              <>
                <div className="about-head">
                  <div className="about-name">LaunchApp 启动器</div>
                  <div className="about-version">版本 v{__APP_VERSION__}</div>
                </div>
                <div className="set-hint">
                  一款仿 macOS Launchpad 的 Windows 快捷启动器：自动扫描已安装应用并提取真实图标，
                  支持全屏模糊背景、分页网格、Dock 栏拖拽收藏、全局快捷键与鼠标侧键唤起、网址快捷方式，
                  以及右键真·卸载。所有设置持久化保存在用户数据文件夹中。
                </div>
                <div className="set-row">
                  <span className="set-label">作者</span>
                  <span className="about-value">{AUTHOR}</span>
                </div>
                <div className="set-row">
                  <span className="set-label">技术栈</span>
                  <span className="about-value">Electron · React · TypeScript</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
