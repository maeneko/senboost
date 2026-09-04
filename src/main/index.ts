import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { shouldStartHidden } from './app-autostart'
import { beginQuit, createWindow, showMainWindow } from './window'
import { showFirstRunSupportDialog } from './first-run'
import { registerIpcHandlers } from './ipc'
import { loadSettings } from './settings'
import { createTray } from './tray'
import { disposeZapret, recoverZapret } from './zapret'
import { elevatedTaskDir, runElevatedServiceTask } from './zapret/elevated-task.win32'

const APP_ID = 'com.senboost.app'

// Приложение может быть запущено само собой через UAC как «повышенный помощник» — тогда
// оно не открывает окно и не занимает единственный экземпляр (иначе отдало бы фокус уже
// запущенной обычной копии и вышло, не сделав работу), а выполняет задачу службы и выходит.
const elevatedTask = process.platform === 'win32' ? elevatedTaskDir(process.argv) : null

if (elevatedTask) {
  void app.whenReady().then(async () => {
    app.exit(await runElevatedServiceTask(elevatedTask))
  })
} else if (!app.requestSingleInstanceLock()) {
  // Одна копия приложения на систему: второй запуск отдаёт фокус уже открытому окну.
  app.quit()
} else {
  app.on('second-instance', () => {
    // Окна может не быть вовсе: приложение живёт в трее, в том числе стартовав свёрнутым.
    showMainWindow()
  })

  app.whenReady().then(async () => {
    // Нужно Windows для группировки в панели задач и уведомлений.
    electronApp.setAppUserModelId(APP_ID)

    // F12 открывает DevTools в dev-режиме, Ctrl/Cmd+R не перезагружает прод-сборку.
    app.on('browser-window-created', (_event, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Настройки читаем один раз здесь: их ждут и recoverZapret (выбранная стратегия),
    // и окно (прятать ли его в трей по закрытию).
    await loadSettings()

    registerIpcHandlers()

    // Трей создаём до окна: окно спрашивает у него, есть ли куда прятаться по закрытию.
    createTray({
      showWindow: () => {
        showMainWindow()
      },
      quit: () => {
        beginQuit()
        app.quit()
      }
    })

    // Запуск из автозапуска системы — приложение садится в трей, окно не показываем.
    const startHidden = shouldStartHidden()

    // На macOS чинит прокси, оставшийся от аварийно завершённого прошлого запуска,
    // до того как окно вообще откроется.
    void recoverZapret().then(() => {
      const window = createWindow({ show: !startHidden })
      // Ждём первого кадра: диалог должен появиться поверх готового окна, а не пустого.
      // Свёрнутому в трей приложению показывать модальное окно некуда — пользователь его
      // не увидит и не закроет, а метку «уже показывали» диалог поставит.
      if (!startHidden) {
        window.once('ready-to-show', () => void showFirstRunSupportDialog(window))
      }
    })

    // macOS: клик по иконке в доке (в том числе при закрытых окнах) открывает окно.
    // Система шлёт это событие и при самом запуске приложения — на первое из них при
    // свёрнутом старте не реагируем, иначе автозапуск сразу же показал бы окно.
    let ignoreActivate = startHidden
    app.on('activate', () => {
      if (ignoreActivate) {
        ignoreActivate = false
        return
      }
      showMainWindow()
    })
  })

  // Windows / Linux: закрыли последнее окно — вышли. macOS: приложение живёт до Cmd+Q.
  // При включённом «сворачивать в трей» окно не закрывается, а прячется, и сюда мы не попадаем
  // (см. обработчик `close` в window.ts).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // Гасим tpws/winws и откатываем системный прокси до фактического выхода —
  // иначе процесс останется висеть, а на macOS ещё и интернет пропадёт.
  let zapretCleaned = false
  app.on('before-quit', (event) => {
    // С этого момента закрытие окна означает выход, а не сворачивание в трей.
    beginQuit()
    if (zapretCleaned) return
    event.preventDefault()
    void disposeZapret().finally(() => {
      zapretCleaned = true
      app.quit()
    })
  })
}
