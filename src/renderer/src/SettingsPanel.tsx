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
import { t } from './i18n'

declare const __APP_VERSION__: string

const BG_COLOR_OPTIONS = BG_COLOR_PRESETS.map((c) => ({ ...c, color: c.value }))

const AUTHOR = 'LuPeiZheng'

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
  /** 当前所有应用图标缓存文件名，用于分析失效图标 */
  usedIcons: string[]
  /** 被"仅移除图标"隐藏的应用（展示图标与名称，可恢复） */
  hiddenApps: { lnk: string; name: string; iconFile: string }[]
  onUnhide: (lnk: string) => void
  onUnhideAll: () => void
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

function Dropdown<T extends string | number>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; text: string; color?: string }[]
  onChange: (v: T) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

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
          ref={btnRef}
          type="button"
          className={`dropdown-btn${open ? ' open' : ''}`}
          onClick={() => {
            const box = btnRef.current?.getBoundingClientRect()
            if (box) setUp(window.innerHeight - box.bottom < 250 && box.top > 250)
            setOpen((o) => !o)
          }}
        >
          <span className="dropdown-cur">
            {current?.color && (
              <span className="dropdown-dot" style={{ background: current.color }} />
            )}
            <span>{current ? t(current.text) : String(value)}</span>
          </span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className={`dropdown-menu${up ? ' up' : ''}`}>
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
                {o.color && <span className="dropdown-dot" style={{ background: o.color }} />}
                {t(o.text)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type BrowserList = Awaited<ReturnType<typeof window.api.listBrowsers>>
type AutoLaunchState = Awaited<ReturnType<typeof window.api.getAutoLaunch>>

/** 打开网址用哪个浏览器：默认跟随系统，也可手动指定计算机上已装的浏览器 */
function LinkBrowserRow({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  const [info, setInfo] = useState<BrowserList | null>(null)
  const [err, setErr] = useState('')

  const load = (refresh: boolean): void => {
    setErr('')
    const p = refresh ? window.api.refreshBrowsers() : window.api.listBrowsers()
    p.then((d) => setInfo(d)).catch((e) => setErr(t('errBrowserDetect') + String(e)))
  }

  useEffect(() => {
    load(false)
  }, [])

  const defaultName = info?.browsers.find((b) => b.key === info.defaultKey)?.name || ''
  const options = [{ value: '', text: defaultName ? t('systemDefaultWith', { name: defaultName }) : t('systemDefault') }].concat(
    (info?.browsers || []).map((b) => ({ value: b.key, text: b.name }))
  )
  const stale = Boolean(info && value && !info.browsers.some((b) => b.key === value))

  return (
    <>
      <Dropdown
        label={t('openWithBrowser')}
        value={value}
        options={options}
        onChange={onChange}
      />
      <div className="set-row">
        <span className="set-label">
          {info ? t('browsersDetected', { n: info.browsers.length }) : t('detectingBrowsers')}
        </span>
        <button className="set-button small" onClick={() => load(true)}>
          {t('redetect')}
        </button>
      </div>
      {err && <div className="set-hint">{err}</div>}
      {stale && <div className="set-hint">{t('browserStaleHint')}</div>}
    </>
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

function AutoLaunchRow({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  const [actual, setActual] = useState<AutoLaunchState | null>(null)
  const sync = (v: boolean): void => {
    onChange(v)
    void window.api
      .setAutoLaunch(v)
      .then(setActual)
      .catch(() => setActual(null))
  }
  useEffect(() => {
    void window.api
      .getAutoLaunch()
      .then(setActual)
      .catch(() => setActual(null))
  }, [])
  return (
    <>
      <Toggle label={t('autoLaunch')} checked={checked} onChange={sync} />
      {actual === null ? (
        <div className="set-hint">{t('autoLaunchBlocked')}</div>
      ) : (
        <>
          <div className="set-hint">{actual.error || (actual.openAtLogin ? t('autoLaunchOn') : t('autoLaunchOff'))}</div>
          {actual.openAtLogin && <div className="set-hint">{t('autoLaunchPath', { n: actual.path })}</div>}
        </>
      )}
    </>
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
      setDbg(t('dbgMouseButton', { n: button }))
      const accel =
        button === 3
          ? 'MouseMiddle'
          : button === 4
            ? 'MouseBack'
            : button === 5
              ? 'MouseForward'
              : null
      if (!accel) {
        setDbg(t('dbgBadMouseButton'))
        return
      }
      setRecording(false)
      commitRef.current(accel)
    })
    void window.api.startMouseCapture().then((ok) => {
      if (!ok) setDbg(t('dbgHookUnavailable'))
    })
    return () => {
      window.removeEventListener('keydown', handler, true)
      off()
      void window.api.stopMouseCapture()
    }
  }, [recording])

  return (
    <div className="set-row">
      <span className="set-label">{t('globalShortcut')}</span>
      <button
        type="button"
        className={`recorder${recording ? ' recording' : ''}`}
        onClick={() => setRecording((r) => !r)}
      >
        {recording ? t('pressKeysHint') : value ? displayShortcut(value) : t('notSet')}
      </button>
      {recording && <span className="recorder-dbg">{dbg || t('waitingMouse')}</span>}
      {value && (
        <button type="button" className="set-button small" onClick={() => onCommit(null)}>
          {t('clear')}
        </button>
      )}
    </div>
  )
}

const TABS = [
  { id: 'appearance', title: 'tabAppearance' },
  { id: 'layout', title: 'tabLayout' },
  { id: 'behavior', title: 'tabBehavior' },
  { id: 'system', title: 'tabSystem' },
  { id: 'apps', title: 'tabApps' },
  { id: 'links', title: 'tabLinks' },
  { id: 'storage', title: 'tabStorage' },
  { id: 'about', title: 'tabAbout' }
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

type StorageAnalysis = Awaited<ReturnType<typeof window.api.analyzeStorage>>

function StorageSection({ usedIcons }: { usedIcons: string[] }): JSX.Element {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [analysis, setAnalysis] = useState<StorageAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  // 只在点“分析”时读一次，避免 apps 变化触发重复分析
  const usedRef = useRef(usedIcons)
  usedRef.current = usedIcons

  const analyze = (): void => {
    setBusy(true)
    setStage('')
    setErr('')
    // 应用列表还没扫出来时传 null：主进程手上没有图标文件名，此时判定会把整份缓存说成残留
    const used = usedRef.current.length > 0 ? usedRef.current : null
    window.api
      .analyzeStorage(used)
      .then(setAnalysis)
      .catch((e) => setErr(t('errAnalyze') + String(e)))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    let alive = true
    window.api
      .storageInfo()
      .then((d) => alive && setInfo(d))
      .catch((e) => alive && setErr(String(e)))
    const offStage = window.api.onStorageStage(setStage)
    analyze()
    return () => {
      alive = false
      offStage()
    }
  }, [])

  const open = (target: 'root' | 'icons' | 'recovered'): void => {
    window.api
      .openStorage(target)
      .then((msg) => {
        if (msg) setErr(t('errOpenFolder') + msg)
      })
      .catch((e) => setErr(String(e)))
  }

  return (
    <>
      <div className="set-hint">{t('storageHint')}</div>
      {err && <div className="set-hint">{err}</div>}
      <div className="set-row">
        <span className="set-label">{t('storageLocation')}</span>
        <button className="set-button small" onClick={() => open('root')}>
          {t('openFolder')}
        </button>
      </div>
      {info && <div className="storage-path">{info.dir}</div>}
      <div className="set-row">
        <span className="set-label">{t('iconCache')}</span>
        <button className="set-button small" onClick={() => open('icons')}>
          {t('openFolder')}
        </button>
      </div>
      {info && (
        <div className="storage-path">
          {t('filesCountSize', { n: info.iconsCount, size: formatBytes(info.iconsSize) })}
        </div>
      )}
      <div className="set-row">
        <span className="set-label">{t('usageAnalysis')}</span>
        <button className="set-button small" onClick={analyze} disabled={busy}>
          {busy ? t('analyzing') : t('reanalyze')}
        </button>
      </div>
      {busy && <div className="storage-path">{t(stage || 'saStageWalk')}</div>}
      {analysis && (
        <div className="sa">
          <div className="sa-total">
            {t('saTotal', { size: formatBytes(analysis.total), n: analysis.files })}
          </div>
          {analysis.groups.map((g) => (
            <div className="sa-row" key={g.id}>
              <span className="sa-label">{g.label}</span>
              <span className="sa-bar">
                <span
                  className="sa-fill"
                  style={{
                    width: Math.max(1.5, analysis.total ? (g.bytes / analysis.total) * 100 : 0) + '%'
                  }}
                />
              </span>
              <span className="sa-size">
                {formatBytes(g.bytes)}
                {g.files > 1 ? t('saFiles', { n: g.files }) : ''}
              </span>
            </div>
          ))}
          {analysis.groups.some((g) => g.id === 'runtime') && (
            <div className="set-hint">{t('saRuntimeHint')}</div>
          )}
          <div className="sa-sub">{t('saTopFiles', { n: analysis.top.length })}</div>
          {analysis.top.map((f) => (
            <div className="sa-file" key={f.path}>
              <span className="sa-path" title={f.path}>
                {f.path}
              </span>
              <span className="sa-size">{formatBytes(f.bytes)}</span>
            </div>
          ))}
          {analysis.orphans === null ? (
            <div className="set-hint">{t('saPending')}</div>
          ) : (
            analysis.orphans.count > 0 && (
              <div className="set-hint">
                {t('saOrphans', { n: analysis.orphans.count, size: formatBytes(analysis.orphans.bytes) })}
              </div>
            )
          )}
        </div>
      )}
      {analysis && analysis.groups.some((g) => g.id === 'recovered') && (
        <>
          <div className="set-hint">
            {t('recoveredHint')}
          </div>
          <div className="set-row">
            <span className="set-label">{t('recoveredLabel')}</span>
            <button className="set-button small" onClick={() => open('recovered')}>
              {t('openFolder')}
            </button>
          </div>
        </>
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
  onEditLink,
  usedIcons,
  hiddenApps,
  onUnhide,
  onUnhideAll
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
          <div className="nav-head">{t('settingsTitle')}</div>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${tab === item.id ? ' active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {t(item.title)}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <header className="settings-head">
            <h2>{t(TABS.find((item) => item.id === tab)?.title ?? 'tabAppearance')}</h2>
            <button className="settings-close" onClick={onClose} title={t('closeEsc')}>
              ✕
            </button>
          </header>

          <div className="settings-scroll">
            {tab === 'appearance' && (
              <>
                <Dropdown
                  label={t('languageLabel')}
                  value={settings.language}
                  options={[
                    { value: 'zh', text: '简体中文' },
                    { value: 'en', text: 'English' }
                  ]}
                  onChange={(v) => onChange({ language: v })}
                />
                <Dropdown
                  label={t('bgStyle')}
                  value={settings.bgStyle}
                  options={[
                    { value: 'wallpaper', text: 'bgWallpaper' },
                    { value: 'fog', text: 'bgFog' },
                    { value: 'solid', text: 'bgSolid' }
                  ]}
                  onChange={(v) => onChange({ bgStyle: v })}
                />
                {settings.bgStyle !== 'wallpaper' && (
                  <Dropdown
                    label={t('bgColor')}
                    value={settings.bgColor}
                    options={BG_COLOR_OPTIONS}
                    onChange={(v) => onChange({ bgColor: v })}
                  />
                )}
                <Dropdown
                  label={t('iconShape')}
                  value={settings.iconShape}
                  options={[
                    { value: 'rounded', text: 'shapeRounded' },
                    { value: 'square', text: 'shapeSquare' },
                    { value: 'circle', text: 'shapeCircle' }
                  ]}
                  onChange={(v) => onChange({ iconShape: v })}
                />
                <Slider
                  label={t('iconSize')}
                  value={settings.iconSize}
                  min={48}
                  max={112}
                  step={4}
                  display={`${settings.iconSize}px`}
                  onChange={(v) => onChange({ iconSize: v })}
                />
                <Slider
                  label={t('fontSize')}
                  value={settings.fontSize}
                  min={11}
                  max={18}
                  display={`${settings.fontSize}px`}
                  onChange={(v) => onChange({ fontSize: v })}
                />
                <Toggle
                  label={t('showAppNames')}
                  checked={settings.showAppNames}
                  onChange={(v) => onChange({ showAppNames: v })}
                />
                <Toggle
                  label={t('showClock')}
                  checked={settings.showClock}
                  onChange={(v) => onChange({ showClock: v })}
                />
                <Slider
                  label={t('bgBlur')}
                  value={settings.blur}
                  min={0}
                  max={120}
                  step={2}
                  display={settings.blur === 0 ? t('off') : `${settings.blur}px`}
                  disabled={settings.bgStyle === 'solid'}
                  onChange={(v) => onChange({ blur: v })}
                />
                <Slider
                  label={t('bgDim')}
                  value={Math.round(settings.dim * 100)}
                  min={0}
                  max={80}
                  display={`${Math.round(settings.dim * 100)}%`}
                  disabled={settings.bgStyle === 'solid'}
                  onChange={(v) => onChange({ dim: v / 100 })}
                />
                <Slider
                  label={t('animDuration')}
                  value={settings.anim}
                  min={0}
                  max={800}
                  step={20}
                  display={settings.anim === 0 ? t('off') : `${settings.anim}ms`}
                  onChange={(v) => onChange({ anim: v })}
                />
              </>
            )}

            {tab === 'layout' && (
              <>
                <Toggle
                  label={t('autoGrid')}
                  checked={settings.autoGrid}
                  onChange={(v) => onChange({ autoGrid: v })}
                />
                <Dropdown
                  label={t('colsPerRow')}
                  value={settings.cols}
                  options={Array.from({ length: 10 }, (_, k) => ({
                    value: k + 3,
                    text: t('colsN', { n: k + 3 })
                  }))}
                  onChange={(v) => onChange({ cols: v, autoGrid: false })}
                />
                <Dropdown
                  label={t('rowsPerPage')}
                  value={settings.rows}
                  options={Array.from({ length: 7 }, (_, k) => ({
                    value: k + 2,
                    text: t('rowsN', { n: k + 2 })
                  }))}
                  onChange={(v) => onChange({ rows: v, autoGrid: false })}
                />
                <Dropdown
                  label={t('indicator')}
                  value={settings.indicator}
                  options={[
                    { value: 'dots', text: 'indicatorDots' },
                    { value: 'numbers', text: 'indicatorNumbers' }
                  ]}
                  onChange={(v) => onChange({ indicator: v })}
                />
                <Slider
                  label={t('gridGap')}
                  value={settings.gridGap}
                  min={0}
                  max={32}
                  step={2}
                  display={`${settings.gridGap}px`}
                  onChange={(v) => onChange({ gridGap: v })}
                />
                <div className="set-hint">{t('manualGridHint')}</div>
              </>
            )}

            {tab === 'behavior' && (
              <>
                <Toggle
                  label={t('dockVisible')}
                  checked={settings.dockVisible}
                  onChange={(v) => onChange({ dockVisible: v })}
                />
                <Toggle
                  label={t('closeQuits')}
                  checked={settings.closeQuits}
                  onChange={(v) => onChange({ closeQuits: v })}
                />
                <Toggle
                  label={t('clickBlank')}
                  checked={settings.clickBlankToHide}
                  onChange={(v) => onChange({ clickBlankToHide: v })}
                />
                <Toggle
                  label={t('wheelPaging')}
                  checked={settings.wheelPaging}
                  onChange={(v) => onChange({ wheelPaging: v })}
                />
                <Toggle
                  label={t('rememberPage')}
                  checked={settings.rememberPage}
                  onChange={(v) => onChange({ rememberPage: v })}
                />
                <Toggle
                  label={t('autoHideOnBlur')}
                  checked={settings.autoHideOnBlur}
                  onChange={(v) => onChange({ autoHideOnBlur: v })}
                />
                <Toggle
                  label={t('dockMagnify')}
                  checked={settings.dockMagnify}
                  onChange={(v) => onChange({ dockMagnify: v })}
                />
                <Toggle
                  label={t('soundEnabled')}
                  checked={settings.soundEnabled}
                  onChange={(v) => onChange({ soundEnabled: v })}
                />
                {settings.soundEnabled && (
                  <>
                    <Dropdown
                      label={t('soundOpen')}
                      value={settings.openSound}
                      options={SOUND_OPTIONS}
                      onChange={(v) => onChange({ openSound: v })}
                    />
                    <Dropdown
                      label={t('soundClose')}
                      value={settings.closeSound}
                      options={SOUND_OPTIONS}
                      onChange={(v) => onChange({ closeSound: v })}
                    />
                    <Dropdown
                      label={t('soundPage')}
                      value={settings.pageSound}
                      options={SOUND_OPTIONS}
                      onChange={(v) => onChange({ pageSound: v })}
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
                <AutoLaunchRow
                  checked={settings.autoLaunch}
                  onChange={(v) => onChange({ autoLaunch: v })}
                />
                <Toggle
                  label={t('mouseSideNav')}
                  checked={settings.mouseSideNav}
                  onChange={(v) => onChange({ mouseSideNav: v })}
                />
                <div className="set-hint">{t('mouseSideNavHint')}</div>
                <div className="set-hint">{t('autoLaunchBootHint')}</div>
                <div className="set-hint">{t('systemHint')}</div>
              </>
            )}

            {tab === 'apps' && (
              <>
                <Dropdown
                  label={t('appSort')}
                  value={settings.appSort}
                  options={[
                    { value: 'custom', text: 'appSortCustom' },
                    { value: 'name', text: 'appSortName' }
                  ]}
                  onChange={(v) => onChange({ appSort: v })}
                />
                {settings.appSort === 'name' && (
                  <div className="set-hint">{t('appSortNameHint')}</div>
                )}
                <Toggle
                  label={t('hideSystemApps')}
                  checked={settings.hideSystemApps}
                  onChange={(v) => onChange({ hideSystemApps: v })}
                />
                <div className="set-hint">{t('removedIconsHint')}</div>
                {hiddenApps.length === 0 ? (
                  <div className="set-hint">{t('noRemovedIcons')}</div>
                ) : (
                  <>
                    <div className="set-row">
                      <span className="set-label">{t('removedIconsCount', { n: hiddenApps.length })}</span>
                      <button className="set-button small" onClick={onUnhideAll}>
                        {t('unhideAll')}
                      </button>
                    </div>
                    <div className="link-manage">
                      {hiddenApps.map((a) => (
                        <div key={a.lnk} className="link-manage-row">
                          {a.iconFile ? (
                            <img className="link-manage-icon" src={`appicon:///${a.iconFile}`} alt="" />
                          ) : (
                            <div className="link-manage-icon fallback">{a.name.slice(0, 1)}</div>
                          )}
                          <div className="link-manage-info">
                            <span className="link-manage-name">{a.name}</span>
                          </div>
                          <button className="set-button small" onClick={() => onUnhide(a.lnk)}>
                            {t('unhide')}
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="set-row">
                  <span className="set-label">{t('resetOrderLabel')}</span>
                  <button className="set-button" onClick={onResetOrder}>
                    {t('resetOrder')}
                  </button>
                </div>
                <div className="set-row">
                  <span className="set-label">{t('rescanLabel')}</span>
                  <button className="set-button" onClick={onRescan} disabled={scanning}>
                    {scanning ? t('scanning') : t('rescan')}
                  </button>
                </div>
                <div className="set-row">
                  <span className="set-label">{t('restoreDefaultsLabel')}</span>
                  <button className="set-button" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
                    {t('restore')}
                  </button>
                </div>
              </>
            )}

            {tab === 'links' && (
              <>
                <Toggle
                  label={t('linksEnabled')}
                  checked={settings.linksEnabled}
                  onChange={(v) => onChange({ linksEnabled: v })}
                />
                <LinkBrowserRow
                  value={settings.linkBrowser}
                  onChange={(v) => onChange({ linkBrowser: v })}
                />
                <div className="set-hint">{t('linksHint')}</div>
                {links.length === 0 ? (
                  <div className="set-hint">{t('noLinksHint')}</div>
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
                          {t('edit')}
                        </button>
                        <button
                          className="set-button small danger-btn"
                          onClick={() => onDeleteLink(l.id)}
                        >
                          {t('remove')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === 'storage' && <StorageSection usedIcons={usedIcons} />}

            {tab === 'about' && (
              <>
                <div className="about-head">
                  <div className="about-name">{t('aboutName')}</div>
                  <div className="about-version">{t('version')} v{__APP_VERSION__}</div>
                </div>
                <div className="set-hint">{t('aboutDesc')}</div>
                <div className="set-row">
                  <span className="set-label">{t('author')}</span>
                  <span className="about-value">{AUTHOR}</span>
                </div>
                <div className="set-row">
                  <span className="set-label">{t('techStack')}</span>
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
