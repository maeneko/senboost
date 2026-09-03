import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Аргумент, по которому приложение понимает, что его запустили не как приложение,
 * а как «повышенного помощника»: отработать задачу службы и выйти, без окна.
 */
export const ELEVATED_TASK_FLAG = '--elevated-service-task'

/**
 * Имена файлов внутри временного каталога задачи. Каталог готовит неповышенная сторона
 * (`runElevated` в service.win32.ts), читает — повышенная, поэтому имена держим в одном
 * месте, а не дублируем строками с обеих сторон.
 */
export const TASK_FILES = {
  worker: 'worker.ps1',
  payload: 'payload.json',
  result: 'result.json'
} as const

let elevationCheck: Promise<boolean> | null = null

/**
 * Запущены ли мы уже от администратора. В собранном приложении это всегда так
 * (`requestedExecutionLevel: requireAdministrator` в electron-builder.yml), но проверяем
 * фактически, а не по предположению: в dev-режиме манифеста нет, а от неверного ответа
 * зависит, ждать пользователю запрос UAC или нет. Ответ не меняется в течение работы
 * процесса, поэтому считаем его один раз.
 */
export function isElevated(): Promise<boolean> {
  elevationCheck ??= run('powershell.exe', [
    '-NoProfile',
    '-Command',
    '[Security.Principal.WindowsPrincipal]::new(' +
      '[Security.Principal.WindowsIdentity]::GetCurrent()' +
      ').IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
  ])
    .then(({ stdout }) => stdout.trim().toLowerCase() === 'true')
    // Не смогли выяснить — считаем, что прав нет: лишний запрос UAC не страшен,
    // а вот молча провалившаяся настройка службы — страшна.
    .catch(() => false)

  return elevationCheck
}

/** Каталог задачи из argv, если приложение запустили как помощника. Иначе null. */
export function elevatedTaskDir(argv: readonly string[]): string | null {
  const index = argv.indexOf(ELEVATED_TASK_FLAG)
  if (index === -1) return null
  return argv[index + 1] ?? null
}

/**
 * Выполняется уже с правами администратора: UAC запросили на нас самих, поэтому
 * дочернему powershell повышаться не нужно — он наследует права.
 *
 * Смысл всей этой конструкции в том, ЧТО пользователь видит в окне UAC. Раньше приложение
 * повышало powershell.exe, и Windows честно показывала «Windows PowerShell» с подписью
 * Microsoft — запрос выглядел так, будто права просит не то, что запросил пользователь.
 * Теперь повышается сам RKNboost.exe, и в запросе стоит имя приложения.
 *
 * Сам worker.ps1 при этом не изменился — вся логика sc/icacls осталась ровно та же,
 * поменялось только то, кого повышают.
 */
export async function runElevatedServiceTask(taskDir: string): Promise<number> {
  try {
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(taskDir, TASK_FILES.worker),
        '-PayloadPath',
        join(taskDir, TASK_FILES.payload),
        '-ResultPath',
        join(taskDir, TASK_FILES.result)
      ],
      { windowsHide: true }
    )
    return 0
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code
    return typeof code === 'number' ? code : 1
  }
}
