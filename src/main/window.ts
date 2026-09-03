import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { ALLOWED_EXTERNAL_PROTOCOLS } from '../shared/ipc-contract'

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

/** Главное (и единственное) окно приложения. */
export function createWindow(): BrowserWindow {
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

  // Показываем окно только когда отрисован первый кадр — без «белой вспышки».
  window.on('ready-to-show', () => window.show())

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
