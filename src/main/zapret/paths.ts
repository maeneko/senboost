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

/** macOS: universal-бинарник utunws (arm64 + x86_64), форк nfqws под utun+BPF. */
export function utunwsPath(): string {
  return join(zapretRoot(), 'darwin', 'utunws')
}

/** Windows: winws.exe рядом с cygwin1.dll и WinDivert. */
export function winwsPath(): string {
  return join(zapretRoot(), 'win32', 'x64', 'winws.exe')
}

/** Linux: nfqws в составе сборки — для `--dry-run` (без root, читает свой же uid). */
export function nfqwsPath(): string {
  return join(zapretRoot(), 'linux', 'x64', 'nfqws')
}

/**
 * Linux: привилегированный помощник в составе сборки (`resources/linux-helper/`, отдельный
 * `extraResources` в electron-builder.yml — не качается `fetch-zapret.mjs`, лежит в репозитории).
 */
export function bundledHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'linux-helper', 'senboost-helper.sh')
    : resolve(app.getAppPath(), 'resources', 'linux-helper', 'senboost-helper.sh')
}

/**
 * Linux: каталог, куда `nfqws`, помощник и fake-пакеты копируются перед КАЖДЫМ запуском
 * (см. `nfqws.linux.ts`). Не оптимизация — необходимость: в AppImage `resources/zapret`
 * примонтирован через FUSE без `allow_other`, и root (а `pkexec` поднимает именно root)
 * туда просто не достучится — ни исполнить бинарник, ни прочитать fake-пакет во время
 * работы. `userData` — обычная файловая система на диске; root видит любой файл на ней
 * независимо от прав (DAC_OVERRIDE), так что копия здесь читается без проблем что для
 * AppImage, что для .deb (там `resources/zapret` и так root-owned, копия просто лишняя,
 * но не вредная — один код-путь на обе цели дешевле двух).
 */
export function linuxStagingDir(): string {
  return join(app.getPath('userData'), 'linux-runtime')
}

export function stagedNfqwsPath(): string {
  return join(linuxStagingDir(), 'nfqws')
}

export function stagedHelperPath(): string {
  return join(linuxStagingDir(), 'senboost-helper.sh')
}

/** Стейджинговая копия `fakesDir()` — то, что реально читает nfqws (см. её комментарий). */
export function stagedFakesDir(): string {
  return join(linuxStagingDir(), 'fakes')
}

/** Встроенные fake-пакеты — источник для копирования в `stagedFakesDir()`. */
export function bundledFakesDir(): string {
  return join(zapretRoot(), 'fakes')
}

/**
 * Рабочий каталог демона — pidfile и `strategy.cfg` (последний — источник маркера стратегии
 * для `LinuxEngine.sync()`, читается без root: помощник кладёт его с правами 0644). Создаёт
 * и чистит сам `senboost-helper.sh`. `/run` — стандартный FHS-путь для данных, не переживающих
 * перезагрузку: nfqws её тоже не переживает, автозапуска на Linux нет (см. README.md).
 */
export function linuxRuntimeDir(): string {
  return '/run/senboost'
}

export function linuxPidfilePath(): string {
  return join(linuxRuntimeDir(), 'nfqws.pid')
}

export function linuxInstalledConfigPath(): string {
  return join(linuxRuntimeDir(), 'strategy.cfg')
}

/**
 * macOS: привилегированные скрипты в составе сборки (`resources/darwin-helper/`, отдельный
 * `extraResources` в electron-builder.yml — не качается `fetch-zapret.mjs`, лежит в
 * репозитории, тот же принцип, что и `bundledHelperPath()` для Linux).
 */
export function bundledDarwinHelperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'darwin-helper')
    : resolve(app.getAppPath(), 'resources', 'darwin-helper')
}

export function darwinInstallScriptPath(): string {
  return join(bundledDarwinHelperDir(), 'install.sh')
}

export function darwinStopScriptPath(): string {
  return join(bundledDarwinHelperDir(), 'stop.sh')
}

export function darwinAutostartScriptPath(): string {
  return join(bundledDarwinHelperDir(), 'autostart.sh')
}

/**
 * macOS: каталог, куда `install.sh` копирует utunws, daemon.sh/watchdog.sh, fake-пакеты и
 * strategy.cfg — свой пользовательский `resources/zapret` для этого не годится: root
 * (`daemon.sh` под launchd) не должен исполнять файлы из каталога, доступного на запись
 * обычному пользователю (то же рассуждение, что у `protectedWinwsPath()` на Windows).
 */
export function darwinInstallDir(): string {
  return '/Library/Application Support/SenBoost/zapret'
}

/** Стейджинговая копия `fakesDir()` — то же назначение, что `stagedFakesDir()` на Linux. */
export function darwinInstalledFakesDir(): string {
  return join(darwinInstallDir(), 'fakes')
}

/** Источник маркера стратегии для `DarwinEngine.sync()` — читается без root (0644). */
export function darwinInstalledConfigPath(): string {
  return join(darwinInstallDir(), 'strategy.cfg')
}

/** Порты TCP/UDP (по строке на каждый) — их же читает `daemon.sh` при заряде pf-правил. */
export function darwinPortsPath(): string {
  return join(darwinInstallDir(), 'ports.conf')
}

/**
 * `utunws --pidfile=...` пишет сюда свой pid до начала работы (см. `daemon.sh`) — читается
 * без root, тот же принцип, что у `linuxPidfilePath()`. `/var/run` — не `/run/senboost`
 * (Linux-путь): на macOS это симлинк на `/private/var/run`, а не отдельная точка монтирования.
 */
export function darwinPidfilePath(): string {
  return '/var/run/senboost-zapret.pid'
}

export function darwinPlistPath(): string {
  return '/Library/LaunchDaemons/com.senboost.zapret.plist'
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

/**
 * Fake-пакеты (TLS ClientHello, QUIC initial, ...) — путь, который резолвится в
 * `{FAKES}` (`strategies.ts`) и должен суметь прочитать сам движок при работе, не только
 * при запуске. На Linux это стейджинговая копия (`stagedFakesDir()`, см. её комментарий про
 * FUSE), на macOS — установленная копия под root (`darwinInstalledFakesDir()`, см. её
 * комментарий); на Windows движок работает под тем же uid, что видит сборку приложения.
 */
export function fakesDir(): string {
  if (process.platform === 'linux') return stagedFakesDir()
  if (process.platform === 'darwin') return darwinInstalledFakesDir()
  return join(zapretRoot(), 'fakes')
}

/**
 * Windows: служба `senboost-zapret` работает от LocalSystem, поэтому её конфиг не может
 * жить в userData обычного пользователя — нужен каталог машинного уровня. `%ProgramData%`
 * почти всегда задан; `C:\ProgramData` — тот же путь, на который он указывает по умолчанию.
 */
export function serviceDataDir(): string {
  return join(process.env.ProgramData ?? 'C:\\ProgramData', 'senboost', 'zapret')
}

/** Файл аргументов `winws.exe @strategy.cfg` — пишется только повышенным скриптом службы. */
export function serviceConfigPath(): string {
  return join(serviceDataDir(), 'strategy.cfg')
}

/**
 * Файлы, которые служба запускает из своего защищённого каталога: сам winws и всё, от чего
 * он зависит при старте. Список нужен и `engine.win32.ts` (решить, надо ли копировать),
 * и повышенному скрипту в `service.win32.ts` (собственно копирование) — держим его здесь,
 * чтобы он не разъехался на две копии.
 */
export const SERVICE_BINARY_NAMES = [
  'winws.exe',
  'cygwin1.dll',
  'WinDivert.dll',
  'WinDivert64.sys'
] as const

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
