import { app } from 'electron'
import { access, constants } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Бинарники zapret кладёт `scripts/fetch-zapret.mjs` в `resources/zapret`.
 * В упакованном приложении electron-builder переносит их в `extraResources`,
 * то есть в `process.resourcesPath/zapret` (вне asar — запускать код из архива нельзя).
 */
function zapretRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'zapret')
    : resolve(app.getAppPath(), 'resources', 'zapret')
}

/** macOS: universal-бинарник tpws (arm64 + x86_64). */
export function tpwsPath(): string {
  return join(zapretRoot(), 'darwin', 'tpws')
}

/** Windows: winws.exe рядом с cygwin1.dll и WinDivert. */
export function winwsPath(): string {
  return join(zapretRoot(), 'win32', 'x64', 'winws.exe')
}

/** Встроенные списки (из Flowseal/zapret-discord-youtube, см. scripts/fetch-zapret.mjs) — только для чтения. */
export function bundledListsDir(): string {
  return join(zapretRoot(), 'lists')
}

/**
 * Рабочая копия списков — здесь их правит пользователь. Живёт вне сборки
 * (userData), чтобы пережить обновление приложения: встроенные списки в
 * `bundledListsDir()` при апдейте перезатираются, а эта копия — нет.
 */
export function userListsDir(): string {
  return join(app.getPath('userData'), 'zapret-lists')
}

/** Fake-пакеты (TLS ClientHello, QUIC initial, ...) для стратегий winws. */
export function fakesDir(): string {
  return join(zapretRoot(), 'fakes')
}

/**
 * Windows: служба `rknboost-zapret` работает от LocalSystem, поэтому её конфиг не может
 * жить в userData обычного пользователя — нужен каталог машинного уровня. `%ProgramData%`
 * почти всегда задан; `C:\ProgramData` — тот же путь, на который он указывает по умолчанию.
 */
export function serviceDataDir(): string {
  return join(process.env.ProgramData ?? 'C:\\ProgramData', 'rknboost', 'zapret')
}

/** Файл аргументов `winws.exe @strategy.cfg` — пишется только повышенным скриптом службы. */
export function serviceConfigPath(): string {
  return join(serviceDataDir(), 'strategy.cfg')
}

/**
 * Защищённая копия `winws.exe` (+ cygwin1.dll, WinDivert.dll, WinDivert64.sys) — на неё,
 * а не на оригинал из папки установки приложения, указывает служба. Установка теперь
 * per-user (`%LocalAppData%`), эта папка доступна на запись обычному пользователю —
 * если бы SYSTEM-служба запускала winws.exe прямо оттуда, кто угодно, работающий под
 * тем же пользователем, мог бы подменить бинарник и получить код с правами SYSTEM.
 * Копию (как и `strategy.cfg`) кладёт и защищает ACL только повышенный скрипт
 * (`applyServiceConfig` в service.win32.ts), рядом, в том же serviceDataDir().
 */
export function protectedWinwsPath(): string {
  return join(serviceDataDir(), 'winws.exe')
}

/**
 * Список, который zapret пополняет сам (`--hostlist-auto`): при похожей на блокировку
 * ошибке домен дописывается сюда и на лету попадает под десинк, без участия пользователя.
 * Не входит в `ZapretListId` — это нередактируемый журнал находок, а не список на правку.
 */
export function autoHostlistPath(): string {
  return join(userListsDir(), 'auto.txt')
}

/**
 * Понятная ошибка вместо ENOENT из глубины spawn: без этой проверки пользователь
 * увидит «spawn ... ENOENT» и не поймёт, что надо запустить `npm run zapret:fetch`.
 */
export async function assertExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK)
  } catch {
    throw new Error(
      `Не найден исполняемый файл zapret: ${path}\n` +
        'Скачайте бинарники командой «npm run zapret:fetch».'
    )
  }
}
