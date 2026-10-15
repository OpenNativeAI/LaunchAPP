import { ElectronAPI } from '@electron-toolkit/preload'

interface UninstallResult {
  ok: boolean
  kind: 'win32' | 'store' | 'mssettings' | 'notfound' | 'failed'
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

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      scanApps: (force?: boolean) => Promise<AppInfo[]>
      launchApp: (info: AppInfo) => Promise<boolean>
      uninstallApp: (info: AppInfo) => Promise<UninstallResult>
      removeShortcut: (lnk: string) => Promise<void>
      fetchLinkMeta: (url: string) => Promise<LinkMeta>
      openLink: (url: string) => Promise<boolean>
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
      openStorage: (target: 'root' | 'icons') => Promise<string>
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
