import { BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcHandlers, ThemeState } from '../shared/ipc-contract'
import { uninstallApp } from './uninstall.win32'
import {
  clearZapretAutoHostlist,
  resetZapretList,
  saveZapretList,
  setZapretAutoStart,
  setZapretStrategy,
  setZapretSystemProxy,
  startZapret,
  stopZapret,
  zapretAutoHostlist,
  zapretDiagnostics,
  zapretLists,
  zapretStatus,
  zapretStrategies
} from './zapret'

/**
 * Обёртка над `ipcMain.handle`, которая сверяет имя канала, аргументы и результат
 * с контрактом из `src/shared/ipc-contract.ts`.
 */
function handle<K extends IpcChannel>(
  channel: K,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: Parameters<IpcHandlers[K]>
  ) => ReturnType<IpcHandlers[K]> | Promise<ReturnType<IpcHandlers[K]>>
): void {
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
}

/** Окно, из которого пришёл запрос (а не «первое попавшееся») — для диалога подтверждения. */
function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function themeState(): ThemeState {
  return {
    source: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  }
}

export function registerIpcHandlers(): void {
  handle('theme:get', () => themeState())

  // Кнопка «Удалить приложение» есть в интерфейсе только на Windows (SettingsView.tsx),
  // но канал регистрируем всегда — так и должно быть по контракту, просто на других
  // платформах он никогда не вызывается.
  handle('app:uninstall', (event) => {
    if (process.platform === 'win32') void uninstallApp(windowOf(event))
  })

  handle('zapret:status', () => zapretStatus())
  handle('zapret:strategies', () => zapretStrategies())
  handle('zapret:start', (_event, strategyId) => startZapret(strategyId))
  handle('zapret:stop', () => stopZapret())
  handle('zapret:set-system-proxy', (_event, enabled) => setZapretSystemProxy(enabled))
  handle('zapret:set-strategy', (_event, strategyId) => setZapretStrategy(strategyId))
  handle('zapret:set-autostart', (_event, enabled) => setZapretAutoStart(enabled))

  handle('zapret:lists', () => zapretLists())
  handle('zapret:list-save', (_event, id, entries) => saveZapretList(id, entries))
  handle('zapret:list-reset', (_event, id) => resetZapretList(id))
  handle('zapret:auto-hostlist', () => zapretAutoHostlist())
  handle('zapret:auto-hostlist-clear', () => clearZapretAutoHostlist())
  handle('zapret:diagnose', () => zapretDiagnostics())

  // Системная тема поменялась (например, пользователь включил тёмный режим в ОС) —
  // сообщаем всем открытым окнам.
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('theme:changed', themeState())
    }
  })
}
