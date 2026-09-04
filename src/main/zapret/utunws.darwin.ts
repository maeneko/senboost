import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runPrivileged } from './elevate.darwin'
import {
  bundledFakesDir,
  darwinAutostartScriptPath,
  darwinInstallScriptPath,
  darwinInstalledConfigPath,
  darwinPidfilePath,
  darwinPlistPath,
  darwinStopScriptPath,
  utunwsPath
} from './paths'
import { parseStrategyMarker } from './strategies'

const run = promisify(execFile)

/**
 * utunws собран под `-target …-macos14.0` (см. `scripts/fetch-zapret.mjs`) — на более
 * старой системе он либо откажется запускаться, либо упадёт с малопонятной ошибкой
 * загрузчика. Darwin major версии X соответствует macOS (X − 9): Darwin 23 = macOS 14
 * (см. `EVERY_RELEASE_DARWIN_VERSION` в документации Apple — Sonoma это первая macOS 14).
 */
const MIN_DARWIN_MAJOR = 23

export function assertMacosVersion(): void {
  const major = Number.parseInt(release().split('.')[0] ?? '', 10)
  if (Number.isFinite(major) && major < MIN_DARWIN_MAJOR) {
    throw new Error(
      'Обход блокировок на macOS требует macOS 14 (Sonoma) или новее — движок utunws собран ' +
        'под более новый API ядра и не запустится на этой версии системы.'
    )
  }
}

/**
 * `utunws --dry-run @<файл>` — проверяет аргументы фильтра без root: privilege drop и
 * открытие utun-интерфейса происходят позже в исполнении, чем разбор аргументов и выход
 * (см. `bDry` в `nfq/nfqws.c` форка Flowseal/zapret-mac-discord-youtube). В отличие от
 * Linux-`nfqws` здесь не нужен `--qnum` — этот путь специфичен для `#ifdef __linux__`.
 */
export async function dryRun(configBody: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rknboost-dryrun-'))
  const configPath = join(dir, 'dry-run.cfg')
  try {
    await writeFile(configPath, configBody, 'utf8')
    await run(utunwsPath(), ['--dry-run', `@${configPath}`])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Стратегия содержит недопустимые параметры utunws: ${message}`, {
      cause: error
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface StartUtunwsOptions {
  configBody: string
  tcpPorts: string
  udpPorts: string
  /** Должен ли LaunchDaemon переживать перезагрузку системы без запущенного приложения. */
  autoStart: boolean
}

/**
 * Единственные два места, где приложение просит пароль администратора — включение и
 * выключение обхода (см. `runPrivileged()`/`resources/darwin-helper/install.sh`).
 */
export async function startUtunws(options: StartUtunwsOptions): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rknboost-strategy-'))
  const configPath = join(dir, 'strategy.cfg')
  try {
    await writeFile(configPath, options.configBody, 'utf8')
    await runPrivileged(darwinInstallScriptPath(), [
      utunwsPath(),
      bundledFakesDir(),
      configPath,
      options.tcpPorts,
      options.udpPorts,
      options.autoStart ? '1' : '0'
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function stopUtunws(): Promise<void> {
  await runPrivileged(darwinStopScriptPath(), [])
}

/**
 * Переключает автозапуск LaunchDaemon с системой (RunAtLoad), не трогая уже работающий
 * демон и pf-правила — та же безопасность для активного обхода, что у `setServiceAutoStart()`
 * на Windows (`sc config start=`, тоже не останавливает работающую службу).
 */
export async function setUtunwsAutoStart(enabled: boolean): Promise<void> {
  await runPrivileged(darwinAutostartScriptPath(), [enabled ? '1' : '0'])
}

export interface UtunwsState {
  pid: number | null
  strategyId: string | null
  /** `RunAtLoad` установленного plist, `null` — если демон не установлен. */
  autoStart: boolean | null
}

/** На macOS нет `/proc` — `kill(pid, 0)` без реальной отправки сигнала: EPERM тоже «жив». */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Не требует пароля: pidfile и `strategy.cfg` в защищённом каталоге установки помощник
 * кладёт с правами, читаемыми без root (см. `install.sh`) — именно затем, чтобы это чтение
 * и восстановление состояния в `DarwinEngine.sync()` обходились без диалога авторизации.
 */
export async function readUtunwsState(): Promise<UtunwsState> {
  let pid: number | null = null
  try {
    const raw = (await readFile(darwinPidfilePath(), 'utf8')).trim()
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed > 0 && isProcessAlive(parsed)) {
      pid = parsed
    }
  } catch {
    // pidfile нет или процесс из него уже не живёт — считаем демон не запущенным.
  }

  let strategyId: string | null = null
  try {
    const content = await readFile(darwinInstalledConfigPath(), 'utf8')
    strategyId = parseStrategyMarker(content.split('\n')[0]?.trim() ?? null)
  } catch {
    // strategy.cfg нет — не страшно, id останется null.
  }

  const autoStart = await readInstalledAutoStart()

  return { pid, strategyId, autoStart }
}

/**
 * `RunAtLoad` уже установленного LaunchDaemon — читается без root (plist в
 * `/Library/LaunchDaemons` мировидим, 0644, как и любой другой системный plist). Источник
 * истины для `DarwinEngine.sync()`: реальное состояние демона важнее сохранённого
 * приложением выбора, тот же принцип, что `Win32Engine.sync()` берёт `info.startMode`
 * у самой службы, а не у `settings.json`.
 */
async function readInstalledAutoStart(): Promise<boolean | null> {
  try {
    const { stdout } = await run('/usr/bin/plutil', [
      '-extract',
      'RunAtLoad',
      'raw',
      '-o',
      '-',
      darwinPlistPath()
    ])
    return stdout.trim() === 'true'
  } catch {
    return null
  }
}
