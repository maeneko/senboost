import { app } from 'electron'
import * as linux from './app-autostart.linux'
import * as win32 from './app-autostart.win32'

/**
 * Автозапуск САМОГО приложения вместе с системой — не путать с автозапуском обхода
 * (`zapret:set-autostart`): тот поднимает службу Windows или LaunchDaemon macOS вообще без
 * приложения, а этот открывает приложение свёрнутым в трей, чтобы обход можно было включить
 * и выключить одним кликом.
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
