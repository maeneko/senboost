import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { isElevated } from './zapret/elevated-task.win32'

const run = promisify(execFile)

/** Имя задачи в планировщике. Оно же снимается деинсталлятором (`build/installer.nsh`). */
const TASK_NAME = 'SenBoost Autostart'

/**
 * Автозапуск приложения на Windows делаем задачей планировщика, а НЕ ключом реестра
 * (`app.setLoginItemSettings`): exe собран с `requestedExecutionLevel: requireAdministrator`
 * (см. electron-builder.yml), а UAC при входе в систему не спрашивают — приложение из ключа
 * реестра просто не запустилось бы. Задача с `/RL HIGHEST` поднимает его с правами сразу.
 */
function taskCommand(): string {
  // В dev первым аргументом electron.exe нужен каталог приложения, в сборке — нет.
  const args = app.isPackaged ? [] : [app.getAppPath()]
  return [`"${process.execPath}"`, ...args.map((arg) => `"${arg}"`), '--hidden'].join(' ')
}

export async function isAppAutoStartEnabled(): Promise<boolean> {
  try {
    await run('schtasks.exe', ['/Query', '/TN', TASK_NAME], { windowsHide: true })
    return true
  } catch {
    // Единственный ожидаемый случай — задачи нет; отличать его от сломанного schtasks нечем
    // (текст сообщения локализован), да и результат для пользователя один и тот же.
    return false
  }
}

export async function setAppAutoStart(enabled: boolean): Promise<void> {
  // Создание и удаление задачи требуют прав администратора. В собранном приложении они уже
  // есть всегда, лишнего UAC не будет; в dev-режиме — нет, и молчать об этом нельзя.
  if (!(await isElevated())) {
    throw new Error(
      'Автозапуск настраивается только в установленном приложении: задача планировщика ' +
        'создаётся с правами администратора, а в режиме разработки их нет.'
    )
  }

  const args = enabled
    ? ['/Create', '/TN', TASK_NAME, '/TR', taskCommand(), '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']
    : ['/Delete', '/TN', TASK_NAME, '/F']

  try {
    await run('schtasks.exe', args, { windowsHide: true })
  } catch (error) {
    // Снятие несуществующей задачи — цель уже достигнута, не ошибка.
    if (!enabled && !(await isAppAutoStartEnabled())) return
    throw new Error(
      `Не удалось ${enabled ? 'включить' : 'выключить'} автозапуск приложения: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}
