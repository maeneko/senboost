import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createConnection, createServer } from 'node:net'
import type { ZapretStatus } from '../../shared/ipc-contract'
import { ZapretEngine } from './engine'
import { assertExecutable, tpwsPath } from './paths'
import { applySystemProxy, hasStaleSnapshot, restoreSystemProxy } from './proxy.darwin'
import { defaultStrategyId, tpwsArgs } from './strategies'

const HOST = '127.0.0.1'
const PREFERRED_PORT = 1080
const READY_TIMEOUT_MS = 3000
const STOP_TIMEOUT_MS = 3000

/** Свободен ли порт на localhost. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, HOST, () => server.close(() => resolve(true)))
  })
}

async function pickPort(): Promise<number> {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 20; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error('Не нашлось свободного порта для socks-прокси.')
}

/** У tpws нет сигнала готовности — просто ждём, пока порт начнёт принимать соединения. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port })
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitUntilReady(port: number, isAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (!isAlive()) return // процесс уже умер, ошибку соберёт вызывающий код
    if (await canConnect(port)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`tpws не начал слушать ${HOST}:${port} за ${READY_TIMEOUT_MS} мс.`)
}

/**
 * macOS: tpws поднимается обычным пользовательским процессом в режиме socks5
 * (документация zapret: «Режим --socks не требует повышенных привилегий»),
 * а трафик заворачивается системной настройкой прокси.
 *
 * Важное ограничение платформы: tpws не умеет UDP, поэтому QUIC не обходится.
 * Практика это скрадывает — при системном socks-прокси браузеры сами уходят с QUIC на TCP.
 */
export class DarwinEngine extends ZapretEngine {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private port = PREFERRED_PORT
  /** Просили ли включить системный прокси. Переживает перезапуск tpws. */
  private wantSystemProxy = true

  constructor() {
    super('tpws-socks', defaultStrategyId('darwin'))
  }

  /**
   * Прошлый запуск мог не снять прокси (например, kill -9). Тогда система смотрит
   * в мёртвый socks и интернета нет вовсе — чиним до того, как показать окно.
   */
  async recoverFromCrash(): Promise<void> {
    if (!(await hasStaleSnapshot())) return

    this.appendLog(
      'info',
      'Найдены незакрытые настройки прокси от прошлого запуска — восстанавливаю.'
    )
    try {
      await restoreSystemProxy()
    } catch (error) {
      this.appendLog('error', error instanceof Error ? error.message : String(error))
    }
  }

  async start(strategyId: string): Promise<ZapretStatus> {
    if (this.child) await this.stop()

    const binary = tpwsPath()
    await assertExecutable(binary)

    this.patch({ state: 'starting', strategyId, error: null })

    try {
      this.port = await pickPort()
      const child = spawn(binary, tpwsArgs(strategyId, this.port), {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child

      // Вывод tpws идёт в stderr целиком, включая обычные сообщения о старте.
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.appendLog('info', chunk))

      let stderrTail = ''
      child.stderr.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2000)
        this.appendLog('info', chunk)
      })

      child.on('exit', (code, signal) => {
        this.child = null
        // Плановую остановку обрабатывает stop(), здесь ловим только падение.
        if (this.status.state === 'stopping' || this.status.state === 'stopped') return
        void this.handleCrash(code, signal, stderrTail)
      })

      await waitUntilReady(this.port, () => this.child !== null)

      if (!this.child) {
        throw new Error(stderrTail.trim() || 'tpws завершился сразу после запуска.')
      }

      if (this.wantSystemProxy) {
        await applySystemProxy(HOST, this.port)
      }

      return this.patch({
        state: 'running',
        startedAt: new Date().toISOString(),
        error: null,
        socksAddress: `${HOST}:${this.port}`,
        systemProxyApplied: this.wantSystemProxy
      })
    } catch (error) {
      await this.cleanup()
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog('error', message)
      return this.patch({
        state: 'error',
        error: message,
        startedAt: null,
        socksAddress: null,
        systemProxyApplied: false
      })
    }
  }

  async stop(): Promise<ZapretStatus> {
    if (!this.child && !this.status.systemProxyApplied) {
      return this.patch({ state: 'stopped', startedAt: null, socksAddress: null })
    }

    this.patch({ state: 'stopping' })
    await this.cleanup()

    return this.patch({
      state: 'stopped',
      startedAt: null,
      error: null,
      socksAddress: null,
      systemProxyApplied: false
    })
  }

  async setSystemProxy(enabled: boolean): Promise<ZapretStatus> {
    this.wantSystemProxy = enabled

    // Пока обход выключен, менять нечего — запомнили выбор и всё.
    if (this.status.state !== 'running') return this.patch({ systemProxyApplied: false })

    if (enabled) {
      await applySystemProxy(HOST, this.port)
    } else {
      await restoreSystemProxy()
    }
    return this.patch({ systemProxyApplied: enabled })
  }

  async dispose(): Promise<void> {
    await this.cleanup()
  }

  /**
   * Порядок важен: сначала снимаем прокси, потом гасим tpws. Наоборот нельзя —
   * между шагами система осталась бы с прокси, который уже никто не слушает.
   */
  private async cleanup(): Promise<void> {
    try {
      await restoreSystemProxy()
    } catch (error) {
      this.appendLog('error', error instanceof Error ? error.message : String(error))
    }

    const child = this.child
    if (!child) return
    this.child = null

    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, STOP_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async handleCrash(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string
  ): Promise<void> {
    const reason = signal ? `сигнал ${signal}` : `код ${code}`
    const details = stderrTail.trim().split('\n').slice(-3).join(' ')

    // Прокси обязательно снять: иначе система указывает на мёртвый socks и сети не будет.
    try {
      await restoreSystemProxy()
    } catch (error) {
      this.appendLog('error', error instanceof Error ? error.message : String(error))
    }

    this.patch({
      state: 'error',
      error: `tpws неожиданно завершился (${reason}). ${details}`.trim(),
      startedAt: null,
      socksAddress: null,
      systemProxyApplied: false
    })
  }
}
