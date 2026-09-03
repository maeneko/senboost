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
 * `winws` (Windows) работает на уровне пакетов через WinDivert. Его пресеты — 22 варианта
 * из Flowseal/zapret-discord-youtube, перенесённые в `strategies.win32.generated.ts`
 * генератором `scripts/import-flowseal-strategies.mjs` (не батниками — кодом).
 *
 * Оба движка используют одни и те же списки сайтов (`src/main/zapret/lists.ts`):
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

/** Стратегия по умолчанию — своя на каждой платформе, наборы id не пересекаются. */
export function defaultStrategyId(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'general' : 'split'
}

function resolvePlaceholders(arg: string): string {
  return arg
    .replaceAll(LISTS_PLACEHOLDER, userListsDir())
    .replaceAll(FAKES_PLACEHOLDER, fakesDir())
    .replaceAll(AUTO_PLACEHOLDER, autoHostlistPath())
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
  if (platform === 'win32') {
    return WIN32_STRATEGIES.map(({ id, name }) => ({
      id,
      name,
      // У Flowseal нет описаний стратегий — только имена вариантов, подобранных под провайдера.
      description: 'Стратегия из подборки Flowseal/zapret-discord-youtube.',
      platforms: ['win32']
    }))
  }
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

/** Читает служба: `winws.exe @strategy.cfg`, ограничение размера у самого winws — 16 КБ. */
const MAX_CONFIG_FILE_BYTES = 16000

/**
 * winws разбирает файл конфигурации через POSIX `wordexp()` (см. `nfq/nfqws.c` в поставке
 * zapret) — без кавычек он режет аргумент по пробелам и съедает обратные слэши в путях вида
 * `C:\Users\...`. Каждый аргумент поэтому кладём в одинарные кавычки, а `'` внутри значения
 * экранируем как `'\''` — тем же приёмом, что и `networksetup()` в `proxy.darwin.ts` для shell.
 */
function quoteConfigArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * Первая строка — маркер: по нему `Win32Engine.sync()` узнаёт, какая стратегия уже установлена
 * в службу, не перечитывая все аргументы. Сам маркер — штатная опция `--comment` winws,
 * в работу процесса не вмешивается.
 */
function configMarker(strategyId: string, body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
  return `--comment=rknboost:${strategyId}:${hash}`
}

export interface WinwsConfig {
  /** Содержимое `strategy.cfg` — UTF-8 без BOM, как требует winws (docs/windows.md zapret). */
  body: string
  /** Маркер первой строки — сравнить с уже установленным, чтобы понять, нужна ли перенастройка. */
  marker: string
}

/** Рендерит стратегию в файл аргументов для `winws.exe @<file>` — см. `WinwsConfig`. */
export function winwsConfigFile(strategyId: string): WinwsConfig {
  const args = winwsArgs(strategyId).map(quoteConfigArg).join('\n')
  const marker = configMarker(strategyId, args)
  const body = `${marker}\n${args}\n`

  if (Buffer.byteLength(body, 'utf8') > MAX_CONFIG_FILE_BYTES) {
    throw new Error(
      `Стратегия «${strategyId}» не помещается в лимит winws на файл конфигурации (16 КБ).`
    )
  }

  return { body, marker }
}
