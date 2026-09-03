import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow } from './window'
import { showFirstRunSupportDialog } from './first-run'
import { registerIpcHandlers } from './ipc'
import { disposeZapret, recoverZapret } from './zapret'
import { elevatedTaskDir, runElevatedServiceTask } from './zapret/elevated-task.win32'

const APP_ID = 'com.rknboost.app'

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
    const [window] = BrowserWindow.getAllWindows()
    if (!window) {
      createWindow()
      return
    }
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(() => {
    // Нужно Windows для группировки в панели задач и уведомлений.
    electronApp.setAppUserModelId(APP_ID)

    // F12 открывает DevTools в dev-режиме, Ctrl/Cmd+R не перезагружает прод-сборку.
    app.on('browser-window-created', (_event, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpcHandlers()

    // На macOS чинит прокси, оставшийся от аварийно завершённого прошлого запуска,
    // до того как окно вообще откроется.
    void recoverZapret().then(() => {
      const window = createWindow()
      // Ждём первого кадра: диалог должен появиться поверх готового окна, а не пустого.
      window.once('ready-to-show', () => void showFirstRunSupportDialog(window))
    })

    // macOS: клик по иконке в доке при закрытых окнах открывает окно заново.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Windows / Linux: закрыли последнее окно — вышли. macOS: приложение живёт до Cmd+Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // Гасим tpws/winws и откатываем системный прокси до фактического выхода —
  // иначе процесс останется висеть, а на macOS ещё и интернет пропадёт.
  let zapretCleaned = false
  app.on('before-quit', (event) => {
    if (zapretCleaned) return
    event.preventDefault()
    void disposeZapret().finally(() => {
      zapretCleaned = true
      app.quit()
    })
  })
}
