/**
 * Единый контракт общения main ↔ renderer.
 *
 * Файл импортируется всеми тремя процессами (main, preload, renderer), поэтому
 * здесь не должно быть импортов из `electron` или из DOM — только типы и константы.
 *
 * Чтобы добавить новый канал:
 *   1. описать его в `IpcHandlers` (аргументы + результат);
 *   2. зарегистрировать обработчик в `src/main/ipc.ts` (TS не даст ошибиться в типах);
 *   3. пробросить метод наружу в `src/preload/index.ts`.
 */

export type ThemeSource = 'system' | 'light' | 'dark'

export interface ThemeState {
  /** Что выбрал пользователь. */
  source: ThemeSource
  /** Что реально показывать сейчас (учитывает системную тему). */
  shouldUseDarkColors: boolean
}

/** Состояние обхода блокировок. */
export type ZapretState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * Чем именно обходим на этой платформе:
 *   • `tpws-socks`    — macOS: локальный socks5-прокси, права не нужны;
 *   • `winws-service` — Windows: служба с драйвером WinDivert;
 *   • `unsupported`   — платформа без поддержки (Linux у нас не собран).
 */
export type ZapretBackend = 'tpws-socks' | 'winws-service' | 'unsupported'

export interface ZapretStatus {
  state: ZapretState
  backend: ZapretBackend
  /** Выбранный пресет из `zapret:strategies`. */
  strategyId: string
  /** Когда обход включён, ISO-8601. */
  startedAt: string | null
  /** Текст последней ошибки — показываем пользователю как есть. */
  error: string | null
  /** macOS: адрес socks5-прокси, пока обход работает. */
  socksAddress: string | null
  /** macOS: прописан ли прокси в системных настройках сети. */
  systemProxyApplied: boolean
  /** Windows: установлена ли служба (её ставит и настраивает само приложение при первом включении). */
  serviceInstalled: boolean
  /** Windows: стоит ли служба на автозапуск с системой (`sc config start=`). */
  autoStart: boolean
}

/** Готовый набор параметров обхода. Подбирается под провайдера. */
export interface ZapretStrategy {
  id: string
  name: string
  description: string
  platforms: NodeJS.Platform[]
}

export interface ZapretLogLine {
  level: 'info' | 'error'
  line: string
}

/**
 * Списки сайтов, применяемые обоими движками (см. `src/main/zapret/lists.ts`).
 * Встроенное содержимое берётся из Flowseal/zapret-discord-youtube (MIT) — пользователь
 * может редактировать любой список полностью, включая встроенные.
 */
export type ZapretListId = 'general' | 'google' | 'exclude' | 'ipset-exclude' | 'ipset-all'

export interface ZapretList {
  id: ZapretListId
  /** Домены (general/google/exclude) или IP/CIDR (ipset-exclude/ipset-all), уже без пустых строк и комментариев. */
  entries: string[]
  /** Совпадает ли содержимое с текущей встроенной версией — пользователь ничего не менял. */
  isDefault: boolean
}

/** Сайт, который проверяет `src/main/zapret/diagnostics.ts`. */
export interface ZapretDiagnosticTarget {
  id: string
  label: string
  host: string
}

/**
 * Результат проверки одного сайта (`src/main/zapret/diagnostics.ts`): успех — это успешный
 * TLS-хендшейк до хоста через текущий бэкенд обхода, не полноценный HTTP-запрос.
 */
export interface ZapretDiagnosticResult extends ZapretDiagnosticTarget {
  ok: boolean
  ms: number | null
  error: string | null
}

/**
 * Каналы вида renderer → main → ответ (`ipcRenderer.invoke` / `ipcMain.handle`).
 * Ключ — имя канала, значение — сигнатура обработчика.
 */
export interface IpcHandlers {
  'theme:get': () => ThemeState

  /** Windows: подтверждает диалогом ОС, запускает деинсталлятор и закрывает приложение. */
  'app:uninstall': () => void

  'zapret:status': () => ZapretStatus
  'zapret:strategies': () => ZapretStrategy[]
  'zapret:start': (strategyId: string) => ZapretStatus
  'zapret:stop': () => ZapretStatus
  /** macOS: прописать/убрать socks-прокси в системных настройках сети. */
  'zapret:set-system-proxy': (enabled: boolean) => ZapretStatus
  /**
   * Выбор пресета. Если обход выключен — просто запоминается. Если включён — на macOS
   * перезапускает tpws, на Windows перенастраивает службу (потребуется UAC).
   */
  'zapret:set-strategy': (strategyId: string) => ZapretStatus
  /** Windows: автозапуск службы с системой (`sc config start=`); требует UAC. */
  'zapret:set-autostart': (enabled: boolean) => ZapretStatus

  'zapret:lists': () => ZapretList[]
  'zapret:list-save': (id: ZapretListId, entries: string[]) => ZapretList
  'zapret:list-reset': (id: ZapretListId) => ZapretList
  /** Список, который zapret пополняет сам через --hostlist-auto (только macOS-профили). */
  'zapret:auto-hostlist': () => string[]
  'zapret:auto-hostlist-clear': () => void

  /**
   * Запустить проверку соединения и сразу вернуть список проверяемых сайтов — сами
   * результаты приходят по одному событием `zapret:diagnostic-result`, как только будет
   * готов каждый. Сайты проверяются параллельно и отвечают вразнобой: ждать самый
   * медленный, чтобы показать все разом, значит держать пользователя перед пустым
   * экраном до последнего таймаута.
   */
  'zapret:diagnose': () => ZapretDiagnosticTarget[]
}

export type IpcChannel = keyof IpcHandlers

/** Каналы вида main → renderer (`webContents.send` / `ipcRenderer.on`). */
export interface IpcEvents {
  'theme:changed': ThemeState
  'zapret:status-changed': ZapretStatus
  'zapret:log': ZapretLogLine
  /** Один готовый результат запущенной через `zapret:diagnose` проверки. */
  'zapret:diagnostic-result': ZapretDiagnosticResult
}

export type IpcEventChannel = keyof IpcEvents

/** Разрешённые протоколы для `shell.openExternal` — всё остальное main отклоняет. */
export const ALLOWED_EXTERNAL_PROTOCOLS = ['https:', 'mailto:'] as const
