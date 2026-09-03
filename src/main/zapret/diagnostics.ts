import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { net } from 'electron'
import type { ZapretDiagnosticResult, ZapretStatus } from '../../shared/ipc-contract'

// 6 секунд не хватало: десинк с `--dpi-desync-repeats` заметно удлиняет установку соединения,
// и медленный, но живой сайт успевал попасть в «Недоступно».
const TIMEOUT_MS = 10000
const TARGET_PORT = 443
const RETRY_DELAY_MS = 300

interface DiagnosticTarget {
  id: string
  label: string
  host: string
}

/** Сайты, которые нужно проверять в первую очередь — по просьбе пользователя. */
const TARGETS: DiagnosticTarget[] = [
  { id: 'instagram', label: 'Instagram', host: 'instagram.com' },
  { id: 'discord', label: 'Discord', host: 'discord.com' },
  { id: 'youtube', label: 'YouTube', host: 'youtube.com' }
]

/**
 * Расшифровка кодов Chromium: без неё в интерфейсе у всех трёх сайтов одинаковое
 * «Недоступно», и по нему невозможно отличить «DPI режет» от «домен не резолвится»
 * или «антивирус перехватывает HTTPS» — а лечатся они совершенно по-разному.
 */
const ERROR_HINTS: [pattern: RegExp, hint: string][] = [
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, 'домен не резолвится — блокировка по DNS'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, 'нет подключения к интернету'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/, 'соединение сброшено — похоже на DPI'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'таймаут — пакеты теряются молча'],
  [/ERR_CONNECTION_REFUSED/, 'соединение отклонено'],
  [/ERR_CERT_|ERR_SSL_/, 'сертификат не принят — вероятно, антивирус перехватывает HTTPS'],
  [/ERR_PROXY_/, 'мешает системный прокси']
]

function describeNetError(message: string): string {
  const code = /net::(ERR_[A-Z_]+)/.exec(message)?.[1] ?? message
  const hint = ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1]
  return hint ? `${hint} (${code})` : code
}

/**
 * SOCKS5 CONNECT без авторизации — ровно то, что понимает tpws в режиме `--socks`.
 * Три сообщения: приветствие (метод «без авторизации»), запрос на домен, ответ сервера.
 */
function socksConnect(socket: Socket, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const hostBuf = Buffer.from(host, 'utf8')

    socket.once('data', (greeting: Buffer) => {
      if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
        reject(new Error('SOCKS5: сервер отклонил метод авторизации'))
        return
      }

      socket.once('data', (reply: Buffer) => {
        if (reply[1] !== 0x00) {
          reject(new Error(`SOCKS5: код ошибки 0x${reply[1].toString(16)}`))
          return
        }
        resolve()
      })

      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([port >> 8, port & 0xff])
        ])
      )
    })

    socket.write(Buffer.from([0x05, 0x01, 0x00]))
  })
}

/**
 * Прямая проверка — путь для Windows (десинк общесистемный, через WinDivert) и для
 * выключенного обхода.
 *
 * Намеренно через `net` Electron, то есть через сетевой стек Chromium, а НЕ через
 * `node:tls`. Тест должен отвечать на вопрос «откроется ли этот сайт в браузере», а
 * Node-стек отвечает на другой: у него собственный список корневых сертификатов (мимо
 * хранилища Windows — и любой антивирус с проверкой HTTPS ломает проверку на ровном
 * месте), собственный резолвер (мимо DoH) и заметно более простой ClientHello, чем у
 * браузера, — а стратегии zapret настраивают именно под браузерный. Из-за этого проверка
 * показывала «Недоступно» на всех трёх сайтах, которые в браузере при включённом обходе
 * открывались нормально.
 */
function checkDirect(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    // HEAD, а не GET: нас интересует только сам факт, что до сайта дошли и он ответил,
    // тело страницы качать незачем. redirect: 'manual' — редирект (например,
    // instagram.com → www.instagram.com) это тоже ответ, гнаться за ним не нужно.
    const request = net.request({ method: 'HEAD', url: `https://${host}/`, redirect: 'manual' })
    let settled = false

    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.abort()
      if (error) reject(new Error(describeNetError(error.message)))
      else resolve(Date.now() - start)
    }

    const timer = setTimeout(
      () => finish(new Error(`net::ERR_TIMED_OUT ${TIMEOUT_MS} мс`)),
      TIMEOUT_MS
    )

    request.on('response', () => finish(null))
    request.on('redirect', () => finish(null))
    request.on('error', finish)
    request.end()
  })
}

/** Тот же успех, но через локальный SOCKS5 tpws — путь для macOS, пока обход включён. */
function checkViaSocks(host: string, socksHost: string, socksPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const socket = netConnect({ host: socksHost, port: socksPort })
    let settled = false

    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(Date.now() - start)
    }

    socket.setTimeout(TIMEOUT_MS, () => finish(new Error(`Таймаут ${TIMEOUT_MS} мс`)))
    socket.once('error', finish)
    socket.once('connect', () => {
      socksConnect(socket, host, TARGET_PORT)
        .then(() => {
          const tlsSocket = tlsConnect({ socket, servername: host })
          tlsSocket.once('secureConnect', () => finish(null))
          tlsSocket.once('error', finish)
        })
        .catch(finish)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Одна повторная попытка. Десинк срабатывает не всегда с первого соединения, и браузер это
 * скрывает: он переустанавливает соединение сам, а пользователь видит только итог — сайт
 * открылся. Проверка в одну попытку получалась строже браузера и писала «Недоступно» там,
 * где сайт на самом деле открывается. Ошибку второй попытки отдаём наружу как есть — если
 * не сработало дважды, показать причину важнее, чем спрятать её за повтором.
 */
async function withRetry(attempt: () => Promise<number>): Promise<number> {
  try {
    return await attempt()
  } catch {
    await delay(RETRY_DELAY_MS)
    return attempt()
  }
}

/**
 * Успех означает «до сайта дошли и он ответил» — этого достаточно, чтобы отличить
 * «DPI оборвал соединение» от «соединение установилось», разбирать ответ незачем.
 *
 * `status.socksAddress` заполнен только на macOS и только пока обход запущен — во всех
 * остальных случаях (Windows, обход выключен, платформа не поддерживается) бьём напрямую:
 * на Windows десинк уже общесистемный через WinDivert, а без обхода тест просто показывает
 * то, что есть сейчас.
 */
export async function runDiagnostics(status: ZapretStatus): Promise<ZapretDiagnosticResult[]> {
  const socksMatch = status.socksAddress ? /^(.+):(\d+)$/.exec(status.socksAddress) : null

  return Promise.all(
    TARGETS.map(async (target) => {
      const attempt = (): Promise<number> =>
        socksMatch
          ? checkViaSocks(target.host, socksMatch[1], Number(socksMatch[2]))
          : checkDirect(target.host)

      try {
        const ms = await withRetry(attempt)
        return { ...target, ok: true, ms, error: null }
      } catch (error) {
        return {
          ...target,
          ok: false,
          ms: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
}
