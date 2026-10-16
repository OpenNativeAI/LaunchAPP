import { ElectronAPI } from '@electron-toolkit/preload'

interface UninstallPlan {
  /** win32=注册表里的卸载命令；local=应用自己目录里的卸载器；store=商店应用；notfound=确实查不到 */
  kind: 'win32' | 'store' | 'local' | 'notfound' | 'failed'
  displayName: string
  how: string
  cmd: string
  message: string
}

interface UninstallResult {
  ok: boolean
  kind: 'win32' | 'store' | 'local' | 'notfound' | 'failed'
  message: string
}

interface AppInfo {
  id: string
  name: string
  target: string
  args: string
  workdir: string
  lnk: string
  iconFile: string
}

interface LinkMeta {
  url: string
  title: string
  icon: string
  host: string
  reason: 'ok' | 'unreachable' | 'no-icon' | 'invalid'
}

interface BrowserInfo {
  key: string
  name: string
  exe: string
}

interface BrowserList {
  browsers: BrowserInfo[]
  defaultKey: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      scanApps: (force?: boolean) => Promise<AppInfo[]>
      launchApp: (info: AppInfo) => Promise<boolean>
      uninstallApp: (info: AppInfo) => Promise<UninstallResult>
      planUninstall: (info: AppInfo) => Promise<UninstallPlan>
      removeShortcut: (lnk: string) => Promise<void>
      openUninstallSettings: () => Promise<void>
      fetchLinkMeta: (url: string) => Promise<LinkMeta>
      openLink: (url: string, browserKey?: string) => Promise<boolean>
      listBrowsers: () => Promise<BrowserList>
      refreshBrowsers: () => Promise<BrowserList>
      storeRead: () => Promise<Record<string, string> | null>
      storeWrite: (data: Record<string, string>) => Promise<boolean>
      storageInfo: () => Promise<{
        dir: string
        iconsDir: string
        settingsFile: string
        settingsSize: number
        iconsCount: number
        iconsSize: number
      }>
      analyzeStorage: (
        usedIcons: string[] | null
      ) => Promise<{
        dir: string
        total: number
        files: number
        groups: { label: string; bytes: number; files: number }[]
        orphans: { count: number; bytes: number; sample: string[] } | null
      }>
      openStorage: (target: 'root' | 'icons' | 'recovered') => Promise<string>
      hideWindow: () => void
      quitApp: () => void
      setShortcut: (accel: string | null) => Promise<boolean>
      startMouseCapture: () => Promise<boolean>
      stopMouseCapture: () => Promise<void>
      onMouseCaptured: (cb: (button: number) => void) => () => void
      setAutoLaunch: (enabled: boolean) => Promise<boolean>
      onScanProgress: (cb: (progress: { done: number; total: number }) => void) => () => void
      onWallpaper: (cb: (dataUrl: string) => void) => void
      onRescan: (cb: () => void) => void
      onWindowShown: (cb: () => void) => () => void
      onWindowHidden: (cb: () => void) => () => void
    }
  }
}
