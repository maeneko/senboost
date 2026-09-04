import type { ZapretStatus } from '../../shared/ipc-contract'
import { assertLinuxDependencies } from './deps.linux'
import { ZapretEngine } from './engine'
import { dryRun, isProcessAlive, readNfqwsState, startNfqws, stopNfqws } from './nfqws.linux'
import { defaultStrategyId, nfqwsConfig } from './strategies'

/** Как часто опрашивать /proc — демон нам не дочерний процесс, экзит-событие поймать некому. */
const WATCH_INTERVAL_MS = 3000

/**
 * Linux: nfqws (движок zapret на уровне пакетов, как и Windows-версия) + правила nftables
 * NFQUEUE. Ни служба, ни автозапуск не заведены (см. README.md) — каждое включение просит
 * пароль через `pkexec` (см. `nfqws.linux.ts`), а сам демон и его правила переживают выход
 * из приложения: `bypass` на очереди означает, что их отсутствие не рвёт пользователю сеть
 * (см. `senboost-helper.sh`), поэтому `dispose()` намеренно пуст — как и на Windows.
 */
export class LinuxEngine extends ZapretEngine {
  private watchTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super('nfqws-nftables', defaultStrategyId('linux'))
  }

  /**
   * Вызывается из `recoverZapret()` до открытия окна — как и `Win32Engine.sync()`, подхватывает
   * состояние, оставшееся от предыдущего запуска приложения (демон root-процессом переживает
   * закрытие приложения, автозапуска с системой при этом нет — состояние может быть только
   * «работает с прошлой сессии» или «выключен»).
   */
  async sync(): Promise<ZapretStatus> {
    const { pid, strategyId } = await readNfqwsState()

    if (pid === null) {
      this.stopWatch()
      return this.patch({ state: 'stopped', startedAt: null, error: null })
    }

    this.startWatch(pid)
    return this.patch({
      state: 'running',
      strategyId: strategyId ?? this.status.strategyId,
      // Момент реального запуска нам не известен — демон мог подняться в прошлой сессии
      // приложения. Тот же компромисс, что и в Win32Engine.sync().
      startedAt: new Date().toISOString(),
      error: null
    })
  }

  async start(strategyId: string): Promise<ZapretStatus> {
    this.patch({ state: 'starting', strategyId, error: null })

    try {
      // Всё, что можно проверить без пароля, проверяем в этом порядке: сначала формат
      // самой стратегии, потом окружение, потом сами аргументы через --dry-run — тот же
      // принцип, что и у Win32Engine.start(), только тут это не опционально, а единственный
      // шанс не побеспокоить пользователя запросом root ради заведомо неверных данных.
      const config = nfqwsConfig(strategyId)
      await assertLinuxDependencies()
      await dryRun(config.body)

      await startNfqws({
        configBody: config.body,
        tcpPorts: config.tcpPorts,
        udpPorts: config.udpPorts
      })

      const { pid } = await readNfqwsState()
      if (pid !== null) this.startWatch(pid)

      return this.patch({ state: 'running', startedAt: new Date().toISOString(), error: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog('error', message)
      return this.patch({ state: 'error', error: message, startedAt: null })
    }
  }

  async stop(): Promise<ZapretStatus> {
    this.patch({ state: 'stopping' })
    this.stopWatch()
    try {
      await stopNfqws()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog('error', message)
      return this.patch({ state: 'error', error: message })
    }
    return this.patch({ state: 'stopped', startedAt: null, error: null })
  }

  async dispose(): Promise<void> {
    // Демон и правила nftables живут своей жизнью в системе — выход приложения их не
    // останавливает (см. комментарий класса). Опрос /proc всё равно больше не нужен.
    this.stopWatch()
  }

  /**
   * Демон нам не дочерний процесс (владеет им root, а не Electron) — событие завершения
   * поймать некому, поэтому опрашиваем `/proc/<pid>` по таймеру. `bypass` в правилах
   * nftables делает мёртвый демон безопасным для сети, но не для интерфейса: без этого
   * опроса карточка продолжала бы показывать «Активен» после падения nfqws.
   */
  private startWatch(pid: number): void {
    this.stopWatch()
    this.watchTimer = setInterval(() => {
      void isProcessAlive(pid).then((alive) => {
        if (alive || this.status.state !== 'running') return
        this.stopWatch()
        this.appendLog('error', `nfqws (pid ${pid}) больше не запущен`)
        this.patch({
          state: 'error',
          error: 'Процесс nfqws неожиданно завершился.',
          startedAt: null
        })
      })
    }, WATCH_INTERVAL_MS)
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }
}
