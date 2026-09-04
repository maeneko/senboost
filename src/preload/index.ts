import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEvents,
  IpcHandlers,
  ThemeState,
  ZapretDiagnosticResult,
  ZapretDiagnosticTarget,
  ZapretList,
  ZapretListId,
  ZapretLogLine,
  ZapretStatus,
  ZapretStrategy
} from '../shared/ipc-contract'

/** Типизированный `invoke`: канал, аргументы и результат берутся из контракта. */
function invoke<K extends IpcChannel>(
  channel: K,
  ...args: Parameters<IpcHandlers[K]>
): Promise<ReturnType<IpcHandlers[K]>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<IpcHandlers[K]>>
}

/** Подписка на событие main → renderer. Возвращает функцию отписки (для useEffect). */
function subscribe<K extends IpcEventChannel>(
  channel: K,
  listener: (payload: IpcEvents[K]) => void
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: IpcEvents[K]): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.off(channel, wrapped)
  }
}

/**
 * Единственное, что видит renderer. Никакого прямого доступа к `ipcRenderer`,
 * к Node API или к файловой системе — только эти методы.
 */
const api = {
  /** 'darwin' | 'win32' | 'linux' — renderer'у нужно, например, чтобы показывать автозапуск
   *  службы только на Windows (см. SettingsView.tsx). */
  platform: process.platform,

  /** Версия запущенной сборки — из package.json через `app.getVersion()` в main. */
  getAppVersion: (): Promise<string> => invoke('app:version'),

  getTheme: (): Promise<ThemeState> => invoke('theme:get'),
  onThemeChanged: (listener: (state: ThemeState) => void): (() => void) =>
    subscribe('theme:changed', listener),

  /** Windows: подтверждает диалогом ОС, запускает деинсталлятор и закрывает приложение. */
  uninstallApp: (): Promise<void> => invoke('app:uninstall'),

  getZapretStatus: (): Promise<ZapretStatus> => invoke('zapret:status'),
  getZapretStrategies: (): Promise<ZapretStrategy[]> => invoke('zapret:strategies'),
  startZapret: (strategyId: string): Promise<ZapretStatus> => invoke('zapret:start', strategyId),
  stopZapret: (): Promise<ZapretStatus> => invoke('zapret:stop'),
  setZapretStrategy: (strategyId: string): Promise<ZapretStatus> =>
    invoke('zapret:set-strategy', strategyId),
  setZapretAutoStart: (enabled: boolean): Promise<ZapretStatus> =>
    invoke('zapret:set-autostart', enabled),
  onZapretStatusChanged: (listener: (status: ZapretStatus) => void): (() => void) =>
    subscribe('zapret:status-changed', listener),
  onZapretLog: (listener: (entry: ZapretLogLine) => void): (() => void) =>
    subscribe('zapret:log', listener),

  getZapretLists: (): Promise<ZapretList[]> => invoke('zapret:lists'),
  saveZapretList: (id: ZapretListId, entries: string[]): Promise<ZapretList> =>
    invoke('zapret:list-save', id, entries),
  resetZapretList: (id: ZapretListId): Promise<ZapretList> => invoke('zapret:list-reset', id),

  /** Запускает проверку и отдаёт список сайтов; результаты — через `onZapretDiagnosticResult`. */
  runZapretDiagnostics: (): Promise<ZapretDiagnosticTarget[]> => invoke('zapret:diagnose'),
  onZapretDiagnosticResult: (listener: (result: ZapretDiagnosticResult) => void): (() => void) =>
    subscribe('zapret:diagnostic-result', listener)
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
