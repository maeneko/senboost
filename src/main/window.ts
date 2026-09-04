import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { ALLOWED_EXTERNAL_PROTOCOLS } from '../shared/ipc-contract'
import { getSettings, rememberPreferences } from './settings'
import { isTrayActive, notifyRunsInBackground } from './tray'

/** Единственное окно приложения — чтобы трей и второй запуск показывали именно его. */
let mainWindow: BrowserWindow | null = null

/**
 * Пользователь действительно выходит («Выход» в трее, Cmd+Q, деинсталляция), а не просто
 * закрывает окно. Пока флага нет, закрытие окна прячет его в трей — см. `createWindow()`.
 */
let quitting = false

export function beginQuit(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

/** Прятать окно в трей вместо выхода: настройка пользователя (по умолчанию — да) + живой трей. */
function shouldHideToTray(): boolean {
  return isTrayActive() && getSettings().closeToTray !== false
}

/**
 * Показать окно: создать заново, если его нет (macOS оставляет приложение жить без окон),
 * развернуть свёрнутое, вывести на передний план. Точка входа для трея, второго запуска
 * приложения и клика по иконке в доке.
 */
export function showMainWindow(): BrowserWindow {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return window
}

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/** Открыть ссылку во внешнем браузере, но только если протокол в белом списке. */
export function openExternal(url: string): void {
  const protocol = protocolOf(url)

  if (protocol && (ALLOWED_EXTERNAL_PROTOCOLS as readonly string[]).includes(protocol)) {
    void shell.openExternal(url)
  } else {
    console.warn(`[security] заблокирована внешняя ссылка: ${url}`)
  }
}

/**
 * Главное (и единственное) окно приложения.
 *
 * `show: false` нужен запуску из автозапуска системы: приложение поднимается сразу свёрнутым
 * в трей, окно готово, но на экран не выходит.
 */
export function createWindow(options: { show?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 660,
    minWidth: 360,
    // С запасом на самое высокое обычное состояние главного экрана (ошибка + результаты
    // проверки), чтобы полоса прокрутки в карточке не появлялась на ровном месте.
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1611',
    // Иконка нужна только Linux — на macOS и Windows её берут из собранного бандла.
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Значения по умолчанию у Electron уже безопасные, но фиксируем их явно,
      // чтобы случайная правка была заметна в ревью.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  // Показываем окно только когда отрисован первый кадр — без «белой вспышки».
  window.on('ready-to-show', () => {
    if (options.show !== false) window.show()
  })

  // Крестик прячет окно в трей: обход продолжает работать, приложение остаётся в фоне.
  // Реальный выход идёт через «Выход» в трее или Cmd+Q — там выставлен флаг `quitting`,
  // и это условие уже не срабатывает.
  window.on('close', (event) => {
    if (quitting || !shouldHideToTray()) return

    event.preventDefault()
    window.hide()

    // Иконка в трее маленькая, и первое исчезновение окна пугает — объясняем один раз.
    if (!getSettings().trayHintShown) {
      rememberPreferences({ trayHintShown: true })
      notifyRunsInBackground()
    }
  })

  // window.open(...) и target="_blank" уходят в системный браузер, а не в новое окно Electron.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  // Запрещаем renderer'у уходить с локальной страницы (защита от навигации на чужой origin).
  window.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    const isDevServer = Boolean(devServerUrl && url.startsWith(devServerUrl))
    if (!isDevServer && !url.startsWith('file://')) {
      event.preventDefault()
      openExternal(url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
