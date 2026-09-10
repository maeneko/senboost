import { app } from 'electron'
import type { ZapretStatus } from '../shared/ipc-contract'
import * as linux from './app-autostart.linux'
import * as win32 from './app-autostart.win32'
import { isTrayActive } from './tray'
import { onZapretStatusChanged, zapretStatus } from './zapret'

/**
 * Автозапуск САМОГО приложения вместе с системой — не путать с автозапуском обхода
 * (`zapret:set-autostart`): тот поднимает службу Windows или LaunchDaemon macOS вообще без
 * приложения, а этот открывает приложение свёрнутым в трей, чтобы обход можно было включить
 * и выключить одним кликом.
 *
 * На Windows отдельного переключателя у него нет — он следует за автозапуском службы
 * (см. `followZapretAutoStart`), в настройках одна кнопка «Запускать вместе с Windows».
 *
 * Источник истины — сама система (реестр/планировщик, SMAppService, каталог автозапуска),
 * в settings.json ничего не дублируем: после переустановки системы или приложения
 * сохранённое значение всё равно разошлось бы с реальностью.
 */
export function isAppAutoStartEnabled(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
      return Promise.resolve(app.getLoginItemSettings().openAtLogin)
    case 'win32':
      return win32.isAppAutoStartEnabled()
    case 'linux':
      return linux.isAppAutoStartEnabled()
    default:
      return Promise.resolve(false)
  }
}

export async function setAppAutoStart(enabled: boolean): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      // Electron 44 регистрирует приложение через SMAppService: пароль администратора не
      // нужен, но система может попросить подтвердить запись в «Объектах входа».
      app.setLoginItemSettings({ openAtLogin: enabled })
      return
    case 'win32':
      await win32.setAppAutoStart(enabled)
      return
    case 'linux':
      await linux.setAppAutoStart(enabled)
      return
    default:
      throw new Error('Автозапуск приложения на этой платформе не поддерживается.')
  }
}

/**
 * Windows: служба обхода стартует при загрузке — значит, и приложение должно подняться
 * при входе, свёрнутым в трей, чтобы обход было чем выключить. Две кнопки для этого путали:
 * обе назывались «запускать вместе с Windows», а по отдельности смысла почти не имели.
 *
 * Задача планировщика существует ровно тогда, когда служба установлена и стоит на `Auto`.
 * Приложение и так работает с правами администратора, так что лишнего UAC это не добавляет —
 * пользователь видит один запрос, на смену типа запуска службы. Подписка на статус, а не
 * вызов из IPC: обход включают и из меню трея, и первое включение ставит службу уже с `Auto`.
 *
 * Вызывать после `recoverZapret()` — до него статус ещё не знает о службе.
 */
export function followZapretAutoStart(): void {
  if (process.platform !== 'win32') return

  let applied: boolean | null = null
  let queue = Promise.resolve()

  const sync = (status: ZapretStatus): void => {
    const wanted = status.serviceInstalled && status.autoStart && isTrayActive()
    if (wanted === applied) return
    applied = wanted
    queue = queue
      .then(async () => {
        if ((await win32.isAppAutoStartEnabled()) !== wanted) await win32.setAppAutoStart(wanted)
      })
      .catch((error) => {
        // Главное — служба, она уже настроена. Без задачи обход всё равно поднимется при
        // загрузке, просто без значка в трее; в dev-режиме сюда попадаем всегда (нет прав).
        console.warn('[autostart] не удалось синхронизировать задачу планировщика:', error)
      })
  }

  onZapretStatusChanged(sync)
  sync(zapretStatus())
}

/**
 * Запуск пришёл из автозапуска — окно показывать не нужно, приложение садится в трей.
 *
 * На Windows и Linux мы сами передаём `--hidden` в команде автозапуска; на macOS аргументы
 * задать нельзя (поле `args` у `setLoginItemSettings` только для Windows), поэтому спрашиваем
 * систему, она ли нас открыла.
 */
export function shouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}
