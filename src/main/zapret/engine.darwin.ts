import type { ZapretStatus } from '../../shared/ipc-contract'
import { ZapretEngine } from './engine'
import { assertExecutable, utunwsPath } from './paths'
import { defaultStrategyId, utunwsConfig } from './strategies'
import {
  assertMacosVersion,
  dryRun,
  readUtunwsState,
  setUtunwsAutoStart,
  startUtunws,
  stopUtunws
} from './utunws.darwin'

/** Как часто опрашивать pidfile — демон нам не дочерний процесс, экзит-событие поймать некому. */
const WATCH_INTERVAL_MS = 3000

/**
 * macOS: `utunws` (форк `nfqws` из Flowseal/zapret-mac-discord-youtube — тот же движок
 * уровня пакетов, что winws и nfqws, но через utun+BPF вместо WinDivert/netfilter) под
 * LaunchDaemon. Пароль администратора спрашивается ровно при двух действиях — включении и
 * выключении обхода (`resources/darwin-helper/install.sh`/`stop.sh` через `osascript`),
 * тот же принцип, что `pkexec` на Linux. Выключение полностью сносит установку (плист,
 * strategy.cfg, pf-правила) — «выключено» и «не установлено» здесь одно состояние, поэтому
 * `dispose()` не требуется останавливать демон: он живёт своей жизнью в системе, как и на
 * Windows/Linux (если пользователь не тронул переключатель, обход продолжает работать
 * после закрытия приложения).
 */
export class DarwinEngine extends ZapretEngine {
  private watchTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super('utunws-pf', defaultStrategyId('darwin'))
    // Решение по умолчанию для первой установки — то же, что у Win32Engine: обход должен
    // работать и после перезагрузки, не дожидаясь запуска приложения.
    this.status.autoStart = true
  }

  /**
   * Вызывается из `recoverZapret()` до открытия окна — подхватывает LaunchDaemon,
   * переживший закрытие приложения (RunAtLoad+KeepAlive держит его живым и через
   * перезагрузку системы), тот же принцип, что `Win32Engine.sync()`/`LinuxEngine.sync()`.
   */
  async sync(): Promise<ZapretStatus> {
    const { pid, strategyId, autoStart } = await readUtunwsState()

    if (pid === null) {
      this.stopWatch()
      return this.patch({ state: 'stopped', startedAt: null, error: null })
    }

    this.startWatch()
    return this.patch({
      state: 'running',
      strategyId: strategyId ?? this.status.strategyId,
      // Реальное состояние демона важнее сохранённого приложением выбора — тот же принцип,
      // что у Win32Engine.sync() с info.startMode.
      autoStart: autoStart ?? this.status.autoStart,
      // Момент реального запуска нам не известен — демон мог подняться ещё при загрузке
      // системы, до старта приложения. Тот же компромисс, что и в остальных движках.
      startedAt: new Date().toISOString(),
      error: null
    })
  }

  async start(strategyId: string): Promise<ZapretStatus> {
    this.patch({ state: 'starting', strategyId, error: null })

    try {
      // Всё, что можно проверить без пароля, проверяем в этом порядке: сначала формат
      // самой стратегии, потом версию системы, потом сами аргументы через --dry-run — тот
      // же принцип, что и у LinuxEngine.start(), единственный шанс не побеспокоить
      // пользователя диалогом авторизации ради заведомо неверных данных.
      const config = utunwsConfig(strategyId)
      assertMacosVersion()
      await assertExecutable(utunwsPath())
      await dryRun(config.body)

      await startUtunws({
        configBody: config.body,
        tcpPorts: config.tcpPorts,
        udpPorts: config.udpPorts,
        autoStart: this.status.autoStart
      })

      const { pid } = await readUtunwsState()
      if (pid !== null) this.startWatch()

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
      await stopUtunws()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog('error', message)
      return this.patch({ state: 'error', error: message })
    }
    return this.patch({ state: 'stopped', startedAt: null, error: null })
  }

  /**
   * Только RunAtLoad уже установленного LaunchDaemon — если демона ещё нет, лишь запоминаем
   * выбор до первого включения (никакого диалога авторизации на пустом месте), тот же
   * принцип, что у `Win32Engine.setAutoStart()`.
   */
  async setAutoStart(enabled: boolean): Promise<ZapretStatus> {
    if (this.status.state !== 'running') {
      return this.patch({ autoStart: enabled })
    }
    await setUtunwsAutoStart(enabled)
    return this.patch({ autoStart: enabled })
  }

  async dispose(): Promise<void> {
    // LaunchDaemon живёт своей жизнью в системе — выход приложения его не останавливает
    // (см. комментарий класса). Опрос pidfile всё равно больше не нужен.
    this.stopWatch()
  }

  /**
   * Демон нам не дочерний процесс (владеет им launchd, а не Electron) — событие завершения
   * поймать некому, поэтому опрашиваем pidfile по таймеру, как и `LinuxEngine`. В отличие
   * от Linux pid здесь может смениться без нашего участия: `daemon.sh` перезапускает
   * utunws заново при смене сети (новый шлюз), поэтому pidfile перечитываем на каждом тике,
   * а не держим захваченный при старте pid.
   */
  private startWatch(): void {
    this.stopWatch()
    this.watchTimer = setInterval(() => {
      void readUtunwsState().then(({ pid: currentPid }) => {
        if (currentPid !== null || this.status.state !== 'running') return
        this.stopWatch()
        this.appendLog('error', 'utunws больше не запущен')
        this.patch({
          state: 'error',
          error: 'Процесс utunws неожиданно завершился.',
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
