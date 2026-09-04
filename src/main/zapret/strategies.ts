import { createHash } from 'node:crypto'
import type { ZapretStrategy } from '../../shared/ipc-contract'
import { autoHostlistPath, fakesDir, userListsDir } from './paths'
import { WIN32_STRATEGIES } from './strategies.win32.generated'

/**
 * Пресеты обхода.
 *
 * Универсального набора параметров не существует: что сработает, зависит от DPI
 * конкретного провайдера.
 *
 * `tpws` (macOS) — прокси уровня TCP-соединений, а не пакетов: умеет только резать/
 * переупорядочивать сегменты (`--split-pos`, `--disorder`, `--oob`, `--tlsrec`), но не
 * умеет ни fake-пакетов, ни UDP/QUIC вообще. Профили ниже — свои, под это ограничение.
 *
 * `winws` (Windows) и `nfqws` (Linux) — один и тот же движок zapret на уровне пакетов
 * (winws — сборка nfq/nfqws.c под WinDivert вместо netfilter), поэтому делят один набор
 * пресетов — 22 варианта из Flowseal/zapret-discord-youtube, перенесённые в
 * `strategies.win32.generated.ts` генератором `scripts/import-flowseal-strategies.mjs`
 * (не батниками — кодом). На Linux `--wf-tcp`/`--wf-udp` из тех же аргументов уходят не в
 * nfqws, а в правила nftables — см. `nfqwsConfig()` ниже и `resources/linux-helper/`.
 *
 * Все три движка используют одни и те же списки сайтов (`src/main/zapret/lists.ts`):
 * `{LISTS}/<id>.txt` — путь резолвится в `resolvePlaceholders()` ниже.
 */
interface DarwinStrategyDefinition extends ZapretStrategy {
  /** Аргументы tpws после общих `--socks --port=...`; плейсхолдеры ещё не резолвлены. */
  tpws: string[]
}

const LISTS_PLACEHOLDER = '{LISTS}'
const FAKES_PLACEHOLDER = '{FAKES}'
const AUTO_PLACEHOLDER = '{AUTO}'

/** `--hostlist-auto` заставляет zapret самому копить сюда домены, похожие на заблокированные. */
const AUTO_HOSTLIST_ARGS = [`--hostlist-auto=${AUTO_PLACEHOLDER}`]

const DARWIN_DEFINITIONS: DarwinStrategyDefinition[] = [
  {
    id: 'split',
    name: 'Разрез + переупорядочивание',
    description: 'Базовый вариант из поставки zapret: разрез TLS ClientHello по середине SNI.',
    platforms: ['darwin'],
    tpws: [
      '--filter-tcp=80',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      '--methodeol',
      '--new',
      '--filter-tcp=443',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      ...AUTO_HOSTLIST_ARGS,
      '--split-pos=1,midsld',
      '--disorder'
    ]
  },
  {
    id: 'multisplit',
    name: 'Многократный разрез',
    description: 'Больше точек разреза. Помогает, когда DPI склеивает сегменты обратно.',
    platforms: ['darwin'],
    tpws: [
      '--filter-tcp=80',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      '--methodeol',
      '--new',
      '--filter-tcp=443',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      ...AUTO_HOSTLIST_ARGS,
      // --oob здесь не добавляем: tpws отказывается совмещать его с --disorder вне Linux.
      '--split-pos=1,midsld,host+1',
      '--disorder'
    ]
  },
  {
    id: 'tlsrec',
    name: 'Разрез TLS-записи',
    description: 'Другой способ разреза (--tlsrec) — стоит попробовать, если «Разрез» не помогает.',
    platforms: ['darwin'],
    tpws: [
      '--filter-tcp=80',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      '--methodeol',
      '--new',
      '--filter-tcp=443',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      ...AUTO_HOSTLIST_ARGS,
      '--split-pos=1',
      '--tlsrec=midsld'
    ]
  },
  {
    id: 'oob',
    name: 'Разрез с OOB-байтом',
    description: 'Внеполосный байт вместо переупорядочивания — третий вариант на выбор.',
    platforms: ['darwin'],
    tpws: [
      '--filter-tcp=80',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      '--methodeol',
      '--new',
      '--filter-tcp=443',
      `--hostlist=${LISTS_PLACEHOLDER}/general.txt`,
      `--hostlist=${LISTS_PLACEHOLDER}/google.txt`,
      `--hostlist-exclude=${LISTS_PLACEHOLDER}/exclude.txt`,
      ...AUTO_HOSTLIST_ARGS,
      '--split-pos=1,midsld',
      '--oob'
    ]
  },
  {
    id: 'all-traffic',
    name: 'Весь трафик, без списков',
    description:
      'Разрез применяется ко всем сайтам, а не только из списка «Обходить». Диагностика.',
    platforms: ['darwin'],
    tpws: [
      '--filter-tcp=80',
      '--methodeol',
      '--new',
      '--filter-tcp=443',
      '--split-pos=1,midsld',
      '--disorder'
    ]
  },
  {
    id: 'passthrough',
    name: 'Без изменения трафика',
    description:
      'Прокси работает, но пакеты не трогает. Нужен, чтобы отделить проблемы сети от стратегии.',
    platforms: ['darwin'],
    tpws: []
  }
]

/**
 * Стратегия по умолчанию. win32 и linux делят один набор id (оба читают
 * `WIN32_STRATEGIES`), поэтому и дефолт у них общий — 'general'; у darwin свой набор.
 */
export function defaultStrategyId(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
    case 'linux':
      return 'general'
    default:
      return 'split'
  }
}

function resolvePlaceholders(arg: string): string {
  return arg
    .replaceAll(LISTS_PLACEHOLDER, userListsDir())
    .replaceAll(FAKES_PLACEHOLDER, fakesDir())
    .replaceAll(AUTO_PLACEHOLDER, autoHostlistPath())
}

/** win32 и linux показывают один и тот же список Flowseal-пресетов — читают его из общего массива. */
function flowsealStrategies(platform: 'win32' | 'linux'): ZapretStrategy[] {
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
  if (platform === 'darwin') {
    return DARWIN_DEFINITIONS.map(({ id, name, description, platforms }) => ({
      id,
      name,
      description,
      platforms
    }))
  }
  if (platform === 'win32') return flowsealStrategies('win32')
  if (platform === 'linux') return flowsealStrategies('linux')
  return []
}

function findDarwin(strategyId: string): DarwinStrategyDefinition {
  const strategy = DARWIN_DEFINITIONS.find((item) => item.id === strategyId)
  if (!strategy) throw new Error(`Неизвестная стратегия: ${strategyId}`)
  return strategy
}

/** Полная командная строка tpws в режиме socks5 на localhost. */
export function tpwsArgs(strategyId: string, port: number): string[] {
  return [
    '--socks',
    `--port=${port}`,
    '--bind-addr=127.0.0.1',
    '--maxconn=512',
    ...findDarwin(strategyId).tpws.map(resolvePlaceholders)
  ]
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
  return `--comment=rknboost:${strategyId}:${hash}`
}

const MARKER_PATTERN = /^--comment=rknboost:([^:]+):/

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

export interface NfqwsConfig extends EngineConfig {
  /** Порты для правила nftables `post` (исходящий трафик) — см. `rknboost-helper.sh`. */
  tcpPorts: string
  /** Порты для правил nftables `post`/`pre` (исходящий и ответный UDP). */
  udpPorts: string
}

/**
 * На Windows `--wf-tcp`/`--wf-udp` — это фильтр самого WinDivert, зашитый в те же аргументы
 * winws. На Linux фильтрацию делает nftables снаружи nfqws (см. `rknboost-helper.sh`), а
 * сам nfqws эти два аргумента не понимает — вырезаем их и отдаём отдельно вызывающей стороне.
 */
export function nfqwsConfig(strategyId: string): NfqwsConfig {
  const args = winwsArgs(strategyId)
  let tcpPorts: string | null = null
  let udpPorts: string | null = null
  const nfqwsArgs: string[] = []

  for (const arg of args) {
    if (arg.startsWith(WF_TCP_PREFIX)) {
      tcpPorts = arg.slice(WF_TCP_PREFIX.length)
    } else if (arg.startsWith(WF_UDP_PREFIX)) {
      udpPorts = arg.slice(WF_UDP_PREFIX.length)
    } else {
      nfqwsArgs.push(arg)
    }
  }

  // На всех 22 стратегиях сейчас ровно по одному --wf-tcp/--wf-udp (проверено вручную при
  // добавлении Linux), но если очередной апдейт Flowseal формат изменит — лучше явная ошибка
  // здесь, чем nftables-правило без портов.
  if (tcpPorts === null || udpPorts === null) {
    throw new Error(`Стратегия «${strategyId}»: не найден --wf-tcp/--wf-udp в аргументах.`)
  }

  // Значение уходит прямо в множество nft-правила (rknboost-helper.sh) без дополнительного
  // экранирования — только цифры, запятые и дефисы диапазонов. Если Flowseal когда-нибудь
  // передаст что-то ещё (например, `~` — отрицание порта), лучше явная ошибка тут, чем
  // нераспознанный текст в командной строке nft, которую выполняет root.
  for (const [flag, ports] of [
    ['--wf-tcp', tcpPorts],
    ['--wf-udp', udpPorts]
  ] as const) {
    if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(ports)) {
      throw new Error(`Стратегия «${strategyId}»: неожиданный формат ${flag}=${ports}`)
    }
  }

  return { ...renderConfigFile(strategyId, nfqwsArgs), tcpPorts, udpPorts }
}
