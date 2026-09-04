import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcHandlers, ThemeState } from '../shared/ipc-contract'
import { uninstallApp } from './uninstall.win32'
import {
  resetZapretList,
  saveZapretList,
  setZapretAutoStart,
  setZapretStrategy,
  startZapret,
  stopZapret,
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

  // Ровно то же значение, что electron-builder кладёт в имя установщика и в
  // «Установленные приложения» — оба берут его из "version" в package.json.
  handle('app:version', () => app.getVersion())

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
  handle('zapret:set-strategy', (_event, strategyId) => setZapretStrategy(strategyId))
  handle('zapret:set-autostart', (_event, enabled) => setZapretAutoStart(enabled))

  handle('zapret:lists', () => zapretLists())
  handle('zapret:list-save', (_event, id, entries) => saveZapretList(id, entries))
  handle('zapret:list-reset', (_event, id) => resetZapretList(id))
  // Результаты уходят не ответом на invoke, а событиями по мере готовности — и именно
  // в то окно, которое просило проверку, а не всем подряд. Окно могло закрыться, пока
  // сайт отвечал (или молчал все 10 с таймаута), — тогда показывать результат уже некому.
  handle('zapret:diagnose', (event) =>
    zapretDiagnostics((result) => {
      if (!event.sender.isDestroyed()) event.sender.send('zapret:diagnostic-result', result)
    })
  )

  // Системная тема поменялась (например, пользователь включил тёмный режим в ОС) —
  // сообщаем всем открытым окнам.
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('theme:changed', themeState())
    }
  })
}
