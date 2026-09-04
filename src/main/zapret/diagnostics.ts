import { net } from 'electron'
import type { ZapretDiagnosticResult, ZapretDiagnosticTarget } from '../../shared/ipc-contract'

// 6 секунд не хватало: десинк с `--dpi-desync-repeats` заметно удлиняет установку соединения,
// и медленный, но живой сайт успевал попасть в «Недоступно».
const TIMEOUT_MS = 10000
const RETRY_DELAY_MS = 300

/** Сайты, которые нужно проверять в первую очередь — по просьбе пользователя. */
export const DIAGNOSTIC_TARGETS: ZapretDiagnosticTarget[] = [
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
 * Единственный путь проверки на всех трёх платформах: десинк везде общесистемный —
 * winws через WinDivert, nfqws через nftables/NFQUEUE, utunws через pf/utun (см.
 * `engine.*.ts`) — прямой запрос видит его так же, как и обычный браузерный трафик.
 * Раньше на macOS был отдельный путь через локальный SOCKS5 (`tpws --socks`), но новый
 * движок `utunws` — не прокси, трафик десинхронизируется до того, как уйдёт в сеть.
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
 * Каждый сайт отдаёт свой результат в `onResult` сам по себе, не дожидаясь остальных:
 * проверки идут параллельно и заканчиваются вразнобой (живой сайт отвечает за десятки
 * миллисекунд, заблокированный — только по таймауту в 10 с), и общий ответ одним куском
 * означал бы пустой экран всё это время. Промис резолвится, когда отработали все, —
 * по нему вызывающий код понимает, что проверка закончена.
 */
export async function runDiagnostics(
  onResult: (result: ZapretDiagnosticResult) => void
): Promise<void> {
  await Promise.all(
    DIAGNOSTIC_TARGETS.map(async (target) => {
      try {
        const ms = await withRetry(() => checkDirect(target.host))
        onResult({ ...target, ok: true, ms, error: null })
      } catch (error) {
        onResult({
          ...target,
          ok: false,
          ms: null,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
  )
}
