import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  app,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'

const run = promisify(execFile)

/** dialog.showMessageBox без родительского окна — отдельная перегрузка, без окна её и зовём. */
function showDialog(
  window: BrowserWindow | null,
  options: MessageBoxOptions
): Promise<MessageBoxReturnValue> {
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

/**
 * Установщик (per-user, `perMachine: false` в electron-builder.yml) регистрирует
 * деинсталлятор в HKCU, не в HKLM — читать оттуда можно без прав администратора.
 * Ищем по DisplayName, а не по фиксированному GUID/пути: имя ключа реестра
 * electron-builder генерирует детерминированно из `appId`, но полагаться на точное
 * значение — лишний повод сломаться при следующей пересборке.
 */
interface UninstallCommand {
  command: string
  args: string[]
}

/**
 * `UninstallString` записывает сам electron-builder (templates/nsis/include/installer.nsh:122)
 * строкой `'"$2" $0'`, где `$2` — путь к деинсталлятору, а `$0` — `/currentuser` для
 * per-user установки (или `/allusers`). То есть путь в кавычках И аргумент после него:
 *
 *     "C:\Users\...\AppData\Local\Programs\RKNboost\Uninstall RKNboost.exe" /currentuser
 *
 * Аргумент обязателен: без него деинсталлятор не знает, из какой ветки реестра сниматься.
 * Разбираем строку на команду и аргументы, а не пытаемся скормить её `spawn` целиком —
 * иначе весь текст вместе с кавычками уходит в имя файла и получается ENOENT.
 */
function parseUninstallString(raw: string): UninstallCommand | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const quoted = /^"([^"]+)"\s*(.*)$/.exec(trimmed)
  if (quoted) {
    return { command: quoted[1], args: quoted[2].split(/\s+/).filter(Boolean) }
  }

  // Без кавычек путь бывает только если в нём нет пробелов — тогда первое слово и есть команда.
  const [command, ...args] = trimmed.split(/\s+/)
  return command ? { command, args } : null
}

/**
 * Установщик (per-user, `perMachine: false` в electron-builder.yml) регистрирует
 * деинсталлятор в HKCU, не в HKLM — читать оттуда можно без прав администратора.
 * Ищем по DisplayName, а не по фиксированному GUID/пути: имя ключа реестра
 * electron-builder генерирует детерминированно из `appId`, но полагаться на точное
 * значение — лишний повод сломаться при следующей пересборке.
 */
async function findUninstallCommand(): Promise<UninstallCommand | null> {
  const script =
    "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' " +
    '| Get-ItemProperty ' +
    "| Where-Object { $_.DisplayName -eq 'RKNboost' } " +
    '| Select-Object -First 1 -ExpandProperty UninstallString'

  let stdout: string
  try {
    ;({ stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script]))
  } catch {
    return null
  }

  return parseUninstallString(stdout)
}

/**
 * `spawn` сообщает о ненайденном файле не исключением, а событием `error` на уже
 * созданном объекте — без этого обработчика ENOENT всплывал бы необработанным
 * отказом промиса в main-процессе. Выходим только после события `spawn`, то есть
 * когда деинсталлятор точно стартовал: закрыться раньше значит не закрыться вовсе.
 */
function launchUninstaller({ command, args }: UninstallCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    // detached: деинсталлятор должен пережить закрытие текущего процесса.
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Подтверждение нативным диалогом ОС (не веб-страницей — так надёжнее для
 * действия, которое стирает и приложение, и списки сайтов пользователя),
 * затем запуск деинсталлятора и выход — деинсталлятор не может удалить
 * запущенное приложение.
 */
export async function uninstallApp(window: BrowserWindow | null): Promise<void> {
  const { response } = await showDialog(window, {
    type: 'warning',
    buttons: ['Отмена', 'Удалить'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Удалить RKNboost',
    message: 'Удалить RKNboost с этого компьютера?',
    detail:
      'Приложение закроется и запустится стандартный деинсталлятор Windows. ' +
      'Вместе с ним будут удалены списки сайтов и служба обхода блокировок. ' +
      'Windows может запросить права администратора.'
  })
  if (response !== 1) return

  const uninstall = await findUninstallCommand()
  if (!uninstall) {
    await showDialog(window, {
      type: 'error',
      title: 'Не удалось найти деинсталлятор',
      message: 'Удалите приложение вручную через «Параметры Windows → Приложения».'
    })
    return
  }

  try {
    await launchUninstaller(uninstall)
  } catch (error) {
    await showDialog(window, {
      type: 'error',
      title: 'Не удалось запустить деинсталлятор',
      message: 'Удалите приложение вручную через «Параметры Windows → Приложения».',
      detail: error instanceof Error ? error.message : String(error)
    })
    return
  }

  app.quit()
}
