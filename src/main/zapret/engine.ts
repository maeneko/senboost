import { BrowserWindow } from 'electron'
import type {
  ZapretBackend,
  ZapretLogLine,
  ZapretStatus,
  ZapretState
} from '../../shared/ipc-contract'
import { rememberPreferences, type AppSettings } from '../settings'

/** Сколько строк вывода бинарника держим для UI. */
const LOG_LIMIT = 200

/** Общая часть обоих движков: хранение статуса и рассылка событий в окна. */
export abstract class ZapretEngine {
  protected status: ZapretStatus
  private readonly log: ZapretLogLine[] = []

  constructor(backend: ZapretBackend, defaultStrategyId: string) {
    this.status = {
      state: 'stopped',
      backend,
      strategyId: defaultStrategyId,
      startedAt: null,
      error: null,
      socksAddress: null,
      systemProxyApplied: false,
      serviceInstalled: false,
      autoStart: false
    }
  }

  getStatus(): ZapretStatus {
    return { ...this.status }
  }

  /**
   * Возвращает выбор пользователя из прошлого запуска (`settings.json` в userData) —
   * вызывается из `recoverZapret()` до открытия окна. Ничего не запускает: восстанавливаем
   * только то, что было выбрано в интерфейсе, а включает обход по-прежнему сам пользователь
   * (или, на Windows, автозапуск службы).
   *
   * `null` в поле означает «не выбирали» — тогда остаётся то, что решил конструктор движка.
   */
  restorePreferences(settings: AppSettings): void {
    this.patch({
      strategyId: settings.strategyId ?? this.status.strategyId,
      autoStart: settings.autoStart ?? this.status.autoStart
    })
  }

  getLog(): ZapretLogLine[] {
    return [...this.log]
  }

  abstract start(strategyId: string): Promise<ZapretStatus>
  abstract stop(): Promise<ZapretStatus>
  /** Вызывается при выходе из приложения: вернуть систему в исходное состояние. */
  abstract dispose(): Promise<void>

  /** macOS-специфика; на других платформах переопределять не нужно. */
  async setSystemProxy(enabled: boolean): Promise<ZapretStatus> {
    void enabled
    throw new Error('Системный прокси на этой платформе не настраивается.')
  }

  /**
   * Выключен — просто запоминаем выбор (никаких системных действий и никакого UAC).
   * Работает — перезапускаем с новой стратегией через `start()`; на Windows тот сам
   * остановит службу перед перенастройкой (см. `Win32Engine.start()`), потому что менять
   * конфигурацию работающей службы нельзя.
   */
  async setStrategy(strategyId: string): Promise<ZapretStatus> {
    if (this.status.state !== 'running') {
      return this.patch({ strategyId })
    }
    return this.start(strategyId)
  }

  /** Windows-специфика (автозапуск службы); на других платформах переопределять не нужно. */
  async setAutoStart(enabled: boolean): Promise<ZapretStatus> {
    void enabled
    throw new Error('Автозапуск на этой платформе не настраивается.')
  }

  protected patch(changes: Partial<ZapretStatus>): ZapretStatus {
    this.status = { ...this.status, ...changes }
    // Единая точка сохранения: любой путь смены стратегии или автозапуска (выбор в списке,
    // start() с другой стратегией, подхваченное из системы состояние службы в sync())
    // проходит через patch, так что забыть сохранить выбор здесь просто негде.
    rememberPreferences({ strategyId: this.status.strategyId, autoStart: this.status.autoStart })
    this.broadcast('zapret:status-changed', this.status)
    return this.getStatus()
  }

  protected setState(state: ZapretState, error: string | null = null): ZapretStatus {
    return this.patch({ state, error })
  }

  /** Вывод бинарника: копим кольцевым буфером и сразу отдаём в UI. */
  protected appendLog(level: ZapretLogLine['level'], chunk: string): void {
    for (const raw of chunk.split('\n')) {
      const line = raw.trimEnd()
      if (!line) continue

      const entry: ZapretLogLine = { level, line }
      this.log.push(entry)
      if (this.log.length > LOG_LIMIT) this.log.shift()
      this.broadcast('zapret:log', entry)
    }
  }

  private broadcast<T>(channel: string, payload: T): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
}

/** Заглушка для платформ, под которые мы бинарники не собираем (Linux). */
export class UnsupportedEngine extends ZapretEngine {
  constructor() {
    super('unsupported', '')
    this.status.error = 'Обход блокировок доступен только на macOS и Windows.'
  }

  async start(): Promise<ZapretStatus> {
    throw new Error('Обход блокировок доступен только на macOS и Windows.')
  }

  async stop(): Promise<ZapretStatus> {
    return this.getStatus()
  }

  async dispose(): Promise<void> {}
}
