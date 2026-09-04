import { createHash } from 'node:crypto'
import type { ZapretStrategy } from '../../shared/ipc-contract'
import { fakesDir, userListsDir } from './paths'
import { WIN32_STRATEGIES } from './strategies.win32.generated'

/**
 * Пресеты обхода.
 *
 * Универсального набора параметров не существует: что сработает, зависит от DPI
 * конкретного провайдера.
 *
 * `winws` (Windows), `nfqws` (Linux) и `utunws` (macOS) — один и тот же движок zapret на
 * уровне пакетов с общим парсером аргументов (winws — сборка `nfq/nfqws.c` под WinDivert
 * вместо netfilter, utunws — та же сборка под utun+BPF, см. Flowseal/zapret-mac-discord-
 * youtube), поэтому все три платформы делят один набор пресетов — 22 варианта из
 * Flowseal/zapret-discord-youtube, перенесённые в `strategies.win32.generated.ts`
 * генератором `scripts/parser-strategies.mjs` (не батниками — кодом).
 *
 * `--wf-tcp`/`--wf-udp` из тех же аргументов сам движок понимает только на Windows
 * (фильтр WinDivert); на Linux и macOS фильтрацию делает внешний слой — nftables и pf
 * соответственно, — а сами порты вырезаются из аргументов и отдаются вызывающей стороне
 * отдельно, см. `packetEngineConfig()` ниже, `resources/linux-helper/` и
 * `resources/darwin-helper/`.
 *
 * Все три движка используют одни и те же списки сайтов (`src/main/zapret/lists.ts`):
 * `{LISTS}/<id>.txt` — путь резолвится в `resolvePlaceholders()` ниже.
 */

const LISTS_PLACEHOLDER = '{LISTS}'
const FAKES_PLACEHOLDER = '{FAKES}'

/** Все три платформы делят один набор id (все читают `WIN32_STRATEGIES`), поэтому и дефолт общий. */
export function defaultStrategyId(platform: NodeJS.Platform): string {
  void platform
  return 'general'
}

function resolvePlaceholders(arg: string): string {
  return arg.replaceAll(LISTS_PLACEHOLDER, userListsDir()).replaceAll(FAKES_PLACEHOLDER, fakesDir())
}

/** win32, linux и darwin показывают один и тот же список Flowseal-пресетов. */
function flowsealStrategies(platform: 'win32' | 'linux' | 'darwin'): ZapretStrategy[] {
  return WIN32_STRATEGIES.map(({ id, name }) => ({
    id,
    name,
    // У Flowseal нет описаний стратегий — только имена вариантов, подобранных под провайдера.
    description: 'Стратегия из подборки Flowseal/zapret-discord-youtube.',
    platforms: [platform]
  }))
}

/** Пресеты, применимые к текущей платформе. */
export function listStrategies(platform: NodeJS.Platform): ZapretStrategy[] {
  if (platform === 'darwin') return flowsealStrategies('darwin')
  if (platform === 'win32') return flowsealStrategies('win32')
  if (platform === 'linux') return flowsealStrategies('linux')
  return []
}

/** Аргументы winws — служба читает их из файла как `winws.exe @strategy.txt`. */
export function winwsArgs(strategyId: string): string[] {
  const strategy = WIN32_STRATEGIES.find((item) => item.id === strategyId)
  if (!strategy) throw new Error(`Неизвестная стратегия: ${strategyId}`)
  return strategy.args.map(resolvePlaceholders)
}

/** Читают winws и nfqws через `@strategy.cfg` — ограничение размера общее у обоих, 16 КБ. */
const MAX_CONFIG_FILE_BYTES = 16000

/**
 * winws и nfqws — один и тот же парсер аргументов (`nfq/nfqws.c` в поставке zapret,
 * winws — его сборка под WinDivert), файл конфигурации разбирают через POSIX `wordexp()` —
 * без кавычек он режет аргумент по пробелам и съедает обратные слэши в путях вида
 * `C:\Users\...`. Каждый аргумент поэтому кладём в одинарные кавычки, а `'` внутри значения
 * экранируем как `'\''` — тем же приёмом, что и `networksetup()` в `proxy.darwin.ts` для shell.
 */
function quoteConfigArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * Первая строка — маркер: по нему `Win32Engine.sync()`/`LinuxEngine.sync()` узнают, какая
 * стратегия уже установлена, не перечитывая все аргументы. Сам маркер — штатная опция
 * `--comment` (есть и у winws, и у nfqws), в работу процесса не вмешивается.
 */
function configMarker(strategyId: string, body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
  return `--comment=senboost:${strategyId}:${hash}`
}

const MARKER_PATTERN = /^--comment=senboost:([^:]+):/

/**
 * Обратная операция к `configMarker()` — достаёт id стратегии из первой строки уже
 * установленного конфига. Общий разбор для `Win32Engine.sync()` и `LinuxEngine.sync()`,
 * чтобы регэксп маркера не разъехался на два места.
 */
export function parseStrategyMarker(line: string | null): string | null {
  if (!line) return null
  return MARKER_PATTERN.exec(line)?.[1] ?? null
}

export interface EngineConfig {
  /** Содержимое `strategy.cfg` — UTF-8 без BOM, как требует winws/nfqws (docs/windows.md zapret). */
  body: string
  /** Маркер первой строки — сравнить с уже установленным, чтобы понять, нужна ли перенастройка. */
  marker: string
}

/** Общий рендер: кавычки, маркер первой строкой, проверка лимита в 16 КБ. */
function renderConfigFile(strategyId: string, args: string[]): EngineConfig {
  const quoted = args.map(quoteConfigArg).join('\n')
  const marker = configMarker(strategyId, quoted)
  const body = `${marker}\n${quoted}\n`

  if (Buffer.byteLength(body, 'utf8') > MAX_CONFIG_FILE_BYTES) {
    throw new Error(
      `Стратегия «${strategyId}» не помещается в лимит winws/nfqws на файл конфигурации (16 КБ).`
    )
  }

  return { body, marker }
}

/** Рендерит стратегию в файл аргументов для `winws.exe @<file>` — см. `EngineConfig`. */
export function winwsConfigFile(strategyId: string): EngineConfig {
  return renderConfigFile(strategyId, winwsArgs(strategyId))
}

const WF_TCP_PREFIX = '--wf-tcp='
const WF_UDP_PREFIX = '--wf-udp='

export interface PacketEngineConfig extends EngineConfig {
  /** Порты TCP из `--wf-tcp`, формат `80,443,8443` — см. вызывающую сторону за смыслом. */
  tcpPorts: string
  /** Порты UDP из `--wf-udp`, тот же формат. */
  udpPorts: string
}

/**
 * На Windows `--wf-tcp`/`--wf-udp` — это фильтр самого WinDivert, зашитый в те же аргументы
 * winws. На Linux и macOS фильтрацию делает внешний слой — nftables (`senboost-helper.sh`)
 * и pf (`resources/darwin-helper/daemon.sh`) соответственно, — а сам движок (nfqws/utunws)
 * эти два аргумента не понимает: вырезаем их и отдаём отдельно вызывающей стороне.
 */
export function packetEngineConfig(strategyId: string): PacketEngineConfig {
  const args = winwsArgs(strategyId)
  let tcpPorts: string | null = null
  let udpPorts: string | null = null
  const engineArgs: string[] = []

  for (const arg of args) {
    if (arg.startsWith(WF_TCP_PREFIX)) {
      tcpPorts = arg.slice(WF_TCP_PREFIX.length)
    } else if (arg.startsWith(WF_UDP_PREFIX)) {
      udpPorts = arg.slice(WF_UDP_PREFIX.length)
    } else {
      engineArgs.push(arg)
    }
  }

  // На всех 22 стратегиях сейчас ровно по одному --wf-tcp/--wf-udp (проверено вручную при
  // добавлении Linux), но если очередной апдейт Flowseal формат изменит — лучше явная ошибка
  // здесь, чем правило фильтрации без портов.
  if (tcpPorts === null || udpPorts === null) {
    throw new Error(`Стратегия «${strategyId}»: не найден --wf-tcp/--wf-udp в аргументах.`)
  }

  // Значение уходит прямо в правило nftables (senboost-helper.sh) или pf (daemon.sh) без
  // дополнительного экранирования — только цифры, запятые и дефисы диапазонов. Если Flowseal
  // когда-нибудь передаст что-то ещё (например, `~` — отрицание порта), лучше явная ошибка
  // тут, чем нераспознанный текст в командной строке nft/pfctl, которую выполняет root.
  for (const [flag, ports] of [
    ['--wf-tcp', tcpPorts],
    ['--wf-udp', udpPorts]
  ] as const) {
    if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(ports)) {
      throw new Error(`Стратегия «${strategyId}»: неожиданный формат ${flag}=${ports}`)
    }
  }

  return { ...renderConfigFile(strategyId, engineArgs), tcpPorts, udpPorts }
}

/** Тонкая обёртка для читаемости на стороне вызова — семантически то же самое. */
export function nfqwsConfig(strategyId: string): PacketEngineConfig {
  return packetEngineConfig(strategyId)
}

export interface UtunwsConfig extends EngineConfig {
  /** Порты TCP в синтаксисе диапазонов pf: `80,443,19294:19344` (везде `:` вместо `-`). */
  tcpPorts: string
  /** Порты UDP, тот же синтаксис. */
  udpPorts: string
}

/** `19294-19344` (формат nftables/WinDivert) → `19294:19344` (формат диапазона в pf). */
function toPfPortRanges(ports: string): string {
  return ports
    .split(',')
    .map((part) => part.replace('-', ':'))
    .join(',')
}

export function utunwsConfig(strategyId: string): UtunwsConfig {
  const { tcpPorts, udpPorts, ...rest } = packetEngineConfig(strategyId)
  return { ...rest, tcpPorts: toPfPortRanges(tcpPorts), udpPorts: toPfPortRanges(udpPorts) }
}
