import { readFileSync } from 'node:fs'
import { app, dialog, Menu, nativeImage, Notification, Tray, type NativeImage } from 'electron'
import type { ZapretStatus } from '../shared/ipc-contract'
import appIcon from '../../resources/icon.png?asset'
import trayOn1x from '../../resources/tray/on-16.png?asset'
import trayOn2x from '../../resources/tray/on-32.png?asset'
import trayOff1x from '../../resources/tray/off-16.png?asset'
import trayOff2x from '../../resources/tray/off-32.png?asset'
import { onZapretStatusChanged, startZapret, stopZapret, zapretStatus } from './zapret'

/**
 * Ссылку держим на уровне модуля: `Tray` живёт ровно столько, сколько живёт объект, и
 * локальная переменная означала бы исчезающую при сборке мусора иконку.
 */
let tray: Tray | null = null

/** Действия, которые трею делает не сам — их владелец `src/main/index.ts`. */
interface TrayHandlers {
  showWindow: () => void
  quit: () => void
}

let handlers: TrayHandlers | null = null

/** Идёт включение или выключение — пункт меню на это время недоступен. */
function isBusy(status: ZapretStatus): boolean {
  return status.state === 'starting' || status.state === 'stopping'
}

function statusLabel(status: ZapretStatus): string {
  switch (status.state) {
    case 'running':
      return 'Обход включён'
    case 'starting':
      return 'Обход включается…'
    case 'stopping':
      return 'Обход выключается…'
    case 'error':
      return 'Ошибка обхода'
    default:
      return 'Обход выключен'
  }
}

/**
 * Картинка в трее.
 *
 * macOS: монохромный щит с прозрачным фоном (`resources/tray`, генерируется скриптом
 * `scripts/make-tray-icons.mjs`), помеченный как template — систему интересует только альфа,
 * цвет она подставляет сама под светлый и тёмный меню-бар. Вариант 2x добавляем через
 * `addRepresentation`, а не соседним файлом `@2x`: electron-vite при импорте `?asset`
 * переносит файлы поштучно, и соглашение об именах через сборку не переживает.
 *
 * Windows и Linux: уменьшенная иконка приложения — она непрозрачный квадрат, поэтому
 * состояние обхода показываем не картинкой, а подсказкой и текстом меню.
 */
function trayImage(status: ZapretStatus): NativeImage {
  if (process.platform !== 'darwin') {
    return nativeImage
      .createFromPath(appIcon)
      .resize(process.platform === 'linux' ? { width: 22, height: 22 } : { width: 16, height: 16 })
  }

  const running = status.state === 'running'
  const image = nativeImage.createFromPath(running ? trayOn1x : trayOff1x)
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(running ? trayOn2x : trayOff2x) })
  image.setTemplateImage(true)
  return image
}

/** Ошибку показываем системным окном: главного окна на экране может и не быть. */
function reportError(error: unknown): void {
  dialog.showErrorBox('SenBoost', error instanceof Error ? error.message : String(error))
}

function toggle(status: ZapretStatus): void {
  const action = status.state === 'running' ? stopZapret() : startZapret(status.strategyId)
  action.catch(reportError)
}

function render(status: ZapretStatus): void {
  if (!tray || !handlers) return

  const supported = status.backend !== 'unsupported'
  const running = status.state === 'running'

  tray.setImage(trayImage(status))
  tray.setToolTip(`SenBoost — ${statusLabel(status).toLowerCase()}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel(status), enabled: false },
      { type: 'separator' },
      {
        label: running ? 'Выключить обход' : 'Включить обход',
        enabled: supported && !isBusy(status),
        click: () => toggle(status)
      },
      { label: 'Показать окно', click: () => handlers?.showWindow() },
      { type: 'separator' },
      { label: 'Выход', click: () => handlers?.quit() }
    ])
  )
}

/**
 * Создаёт иконку в трее. Может не получиться: на Linux иконка держится на AppIndicator
 * (в GNOME — расширение), и без него `Tray` бросает исключение. Тогда трея просто нет,
 * `isTrayActive()` вернёт false, и окно ведёт себя по-старому — закрытие закрывает
 * приложение, а не прячет его туда, откуда пользователь не сможет достать.
 */
export function createTray(trayHandlers: TrayHandlers): void {
  handlers = trayHandlers

  try {
    tray = new Tray(trayImage(zapretStatus()))
  } catch (error) {
    console.warn('[tray] не удалось создать иконку в трее:', error)
    tray = null
    return
  }

  // Левый клик открывает окно на Windows и Linux. На macOS клик по иконке в меню-баре
  // открывает контекстное меню — это поведение системы, и трогать его не нужно.
  if (process.platform !== 'darwin') tray.on('click', () => handlers?.showWindow())

  render(zapretStatus())
  onZapretStatusChanged(render)

  // Иконка должна исчезнуть в момент выхода, а не когда до объекта дойдёт сборщик мусора.
  app.on('will-quit', destroyTray)
}

export function isTrayActive(): boolean {
  return tray !== null && !tray.isDestroyed()
}

/** Первое сворачивание в трей: объясняем, куда делось окно и что приложение ещё работает. */
export function notifyRunsInBackground(): void {
  const title = 'SenBoost работает в фоне'
  const body =
    process.platform === 'darwin'
      ? 'Окно свёрнуто в меню-бар. Обход продолжает работать — выйти можно через меню значка.'
      : 'Окно свёрнуто в трей. Обход продолжает работать — выйти можно через меню значка.'

  if (process.platform === 'win32' && tray && !tray.isDestroyed()) {
    tray.displayBalloon({ title, content: body, icon: nativeImage.createFromPath(appIcon) })
    return
  }

  if (Notification.isSupported()) new Notification({ title, body }).show()
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}
