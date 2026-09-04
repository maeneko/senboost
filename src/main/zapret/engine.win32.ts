import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ZapretStatus } from '../../shared/ipc-contract'
import { ZapretEngine } from './engine'
import {
  SERVICE_BINARY_NAMES,
  assertExecutable,
  serviceDataDir,
  serviceConfigPath,
  winwsPath
} from './paths'
import {
  applyServiceConfig,
  queryService,
  setServiceAutoStart,
  startService,
  stopService,
  type ServiceInfo
} from './service.win32'
import {
  defaultStrategyId,
  type EngineConfig,
  parseStrategyMarker,
  winwsConfigFile
} from './strategies'

const run = promisify(execFile)

/** Первая строка `strategy.cfg` — из `winwsConfigFile()`, формат: `--comment=senboost:<id>:<hash>`. */
async function readInstalledMarkerLine(): Promise<string | null> {
  try {
    const content = await readFile(serviceConfigPath(), 'utf8')
    return content.split('\n')[0]?.trim() ?? null
  } catch {
    return null
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/**
 * Служба запускает защищённую копию бинарников, а не оригинал из папки приложения — значит
 * обновление по самому пути службы не отследить. Сравниваем содержимое: время изменения тут
 * не годится совсем, `scripts/fetch-zapret.mjs` кладёт файлы через `copyFile`, а тот ставит
 * текущее время — после каждой сборки CI mtime новее, хотя версия zapret запинована и байты
 * те же. По mtime мы на ровном месте требовали UAC при каждом обновлении приложения и лезли
 * копировать поверх WinDivert64.sys, ещё загруженного в ядро.
 */
async function binariesNeedCopy(): Promise<boolean> {
  const sourceDir = dirname(winwsPath())
  const targetDir = serviceDataDir()
  try {
    for (const name of SERVICE_BINARY_NAMES) {
      const [source, copy] = await Promise.all([
        sha256(join(sourceDir, name)),
        sha256(join(targetDir, name))
      ])
      if (source !== copy) return true
    }
    return false
  } catch {
    // Какого-то файла ещё нет (первая установка) или он нечитаем — надёжнее скопировать.
    return true
  }
}

/**
 * Перенастройка (а значит и UAC) нужна, если службы ещё нет, если защищённая копия
 * winws.exe отстала от оригинала в папке приложения, или если аргументы стратегии
 * изменились (маркер в `strategy.cfg` не совпадает с тем, что сгенерировали сейчас).
 */
async function needsReconfigure(config: EngineConfig, info: ServiceInfo | null): Promise<boolean> {
  if (!info) return true
  if (await binariesNeedCopy()) return true
  return (await readInstalledMarkerLine()) !== config.marker
}

/**
 * Windows: winws требует драйвер WinDivert и права администратора, поэтому работает как служба
 * Windows (`senboost-zapret`), а не как обычный дочерний процесс приложения.
 *
 * UAC запрашивается только при первой установке службы и при смене аргументов (новая стратегия,
 * переключение автозапуска) — этим занимается `service.win32.ts`. Обычные включение/выключение
 * идут через `sc start`/`sc stop`, на которые интерактивным пользователям выдаётся право при
 * установке (`sc sdset`), поэтому UAC для них не нужен.
 */
export class Win32Engine extends ZapretEngine {
  constructor() {
    super('winws-service', defaultStrategyId('win32'))
    // Решение по умолчанию для первой установки: обход должен работать и после перезагрузки,
    // не дожидаясь запуска приложения. Дальше пользователь может выключить переключателем.
    this.status.autoStart = true
  }

  /**
   * Вызывается из `recoverZapret()` до открытия окна: подхватывает состояние службы,
   * которая могла работать ещё при загрузке системы (автозапуск), — иначе UI показал бы
   * «Выключен» при уже работающем обходе.
   */
  async sync(): Promise<ZapretStatus> {
    const info = await queryService().catch(() => null)
    if (!info) {
      return this.patch({ serviceInstalled: false, state: 'stopped', startedAt: null })
    }

    const installedLine = await readInstalledMarkerLine()
    const strategyId = parseStrategyMarker(installedLine) ?? this.status.strategyId

    return this.patch({
      serviceInstalled: true,
      autoStart: info.startMode === 'Auto',
      strategyId,
      state: info.state === 'Running' ? 'running' : 'stopped',
      // Точный момент запуска нам недоступен — служба могла подняться ещё при загрузке
      // системы, до старта приложения. Берём момент обнаружения, лишь бы поле не пустовало.
      startedAt: info.state === 'Running' ? new Date().toISOString() : null,
      error: null
    })
  }

  async start(strategyId: string): Promise<ZapretStatus> {
    this.patch({ state: 'starting', strategyId, error: null })

    let config: EngineConfig
    try {
      config = winwsConfigFile(strategyId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.patch({ state: 'error', error: message, startedAt: null })
    }

    try {
      await assertExecutable(winwsPath())

      const info = await queryService().catch(() => null)
      if (await needsReconfigure(config, info)) {
        // Перенастраивать работающую службу нельзя — её сначала надо остановить, иначе
        // ломается всё сразу: работающий winws держит открытым свой же winws.exe, и
        // Copy-Item в защищённый каталог падает на занятом файле; --dry-run упирается в
        // тот же именованный mutex WinDivert («A copy of winws is already running with
        // the same filter»); а sc config применяется только к СЛЕДУЮЩЕМУ запуску, так что
        // служба молча продолжила бы работать со старой стратегией.
        if (info?.state === 'Running') await stopService()

        // --dry-run трогает mutex WinDivert, а не только парсит аргументы, поэтому зовём его
        // здесь — после остановки и только когда действительно собираемся писать новый конфиг,
        // а не когда просто подтверждаем уже работающую стратегию.
        await this.dryRun(config.body)
        await applyServiceConfig({ configBody: config.body, autoStart: this.status.autoStart })
      }

      const running = await startService()

      return this.patch({
        state: 'running',
        startedAt: new Date().toISOString(),
        error: null,
        serviceInstalled: true,
        autoStart: running?.startMode === 'Auto'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog('error', message)
      return this.patch({ state: 'error', error: message, startedAt: null })
    }
  }

  async stop(): Promise<ZapretStatus> {
    this.patch({ state: 'stopping' })
    try {
      await stopService()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog('error', message)
      return this.patch({ state: 'error', error: message })
    }
    return this.patch({ state: 'stopped', startedAt: null, error: null })
  }

  /**
   * Только тип автозапуска службы — если она ещё не установлена, лишь запоминаем выбор
   * до первого включения (никакого UAC на пустом месте).
   */
  async setAutoStart(enabled: boolean): Promise<ZapretStatus> {
    if (!this.status.serviceInstalled) {
      return this.patch({ autoStart: enabled })
    }
    await setServiceAutoStart(enabled)
    return this.patch({ autoStart: enabled })
  }

  async dispose(): Promise<void> {
    // Служба живёт своей жизнью в системе — выход приложения её не останавливает.
  }

  /**
   * `winws.exe --dry-run @<файл>` только проверяет аргументы и завершается без открытия
   * WinDivert — не требует прав администратора. Ошибку в стратегии видно до запроса UAC,
   * а не после него.
   */
  private async dryRun(configBody: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'senboost-dryrun-'))
    const configPath = join(dir, 'dry-run.cfg')
    try {
      await writeFile(configPath, configBody, 'utf8')
      await run(winwsPath(), ['--dry-run', `@${configPath}`])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Стратегия содержит недопустимые параметры winws: ${message}`, {
        cause: error
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
