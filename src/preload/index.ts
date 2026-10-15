import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface AppInfo {
  id: string
  name: string
  target: string
  args: string
  workdir: string
  lnk: string
  iconFile: string
}

export interface UninstallResult {
  ok: boolean
  kind: 'win32' | 'store' | 'mssettings' | 'notfound' | 'failed'
  message: string
}

export interface LinkMeta {
  url: string
  title: string
  icon: string
  host: string
  reason: 'ok' | 'unreachable' | 'no-icon' | 'invalid'
}

export interface StorageInfo {
  dir: string
  iconsDir: string
  settingsFile: string
  settingsSize: number
  iconsCount: number
  iconsSize: number
}

const api = {
  scanApps: (force = false): Promise<AppInfo[]> => ipcRenderer.invoke('apps:scan', force),
  launchApp: (info: AppInfo): Promise<boolean> => ipcRenderer.invoke('apps:launch', info),
  uninstallApp: (info: AppInfo): Promise<UninstallResult> =>
    ipcRenderer.invoke('apps:uninstall', info),
  removeShortcut: (lnk: string): Promise<void> => ipcRenderer.invoke('apps:remove-shortcut', lnk),
  fetchLinkMeta: (url: string): Promise<LinkMeta> => ipcRenderer.invoke('links:fetch-meta', url),
  openLink: (url: string): Promise<boolean> => ipcRenderer.invoke('links:open', url),
  storeRead: (): Promise<Record<string, string> | null> => ipcRenderer.invoke('store:read'),
  storeWrite: (data: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke('store:write', data),
  storageInfo: (): Promise<StorageInfo> => ipcRenderer.invoke('storage:info'),
  openStorage: (target: 'root' | 'icons'): Promise<string> =>
    ipcRenderer.invoke('storage:open', target),
  hideWindow: (): void => ipcRenderer.send('window:hide'),
  quitApp: (): void => ipcRenderer.send('app:quit'),
  setShortcut: (accel: string | null): Promise<boolean> =>
    ipcRenderer.invoke('shortcut:set', accel),
  startMouseCapture: (): Promise<boolean> => ipcRenderer.invoke('shortcut:capture-start'),
  stopMouseCapture: (): Promise<void> => ipcRenderer.invoke('shortcut:capture-stop'),
  onMouseCaptured: (cb: (button: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, button: number): void => cb(button)
    ipcRenderer.on('shortcut:mouse-captured', listener)
    return () => ipcRenderer.removeListener('shortcut:mouse-captured', listener)
  },
  setAutoLaunch: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('autolaunch:set', enabled),
  onScanProgress: (cb: (progress: { done: number; total: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, progress: { done: number; total: number }): void =>
      cb(progress)
    ipcRenderer.on('apps:progress', listener)
    return () => ipcRenderer.removeListener('apps:progress', listener)
  },
  onWallpaper: (cb: (dataUrl: string) => void): void => {
    ipcRenderer.on('wallpaper', (_e, dataUrl: string) => cb(dataUrl))
  },
  onRescan: (cb: () => void): void => {
    ipcRenderer.on('apps:rescan', () => cb())
  },
  onWindowShown: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('window:shown', listener)
    return () => ipcRenderer.removeListener('window:shown', listener)
  },
  onWindowHidden: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('window:hidden', listener)
    return () => ipcRenderer.removeListener('window:hidden', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
