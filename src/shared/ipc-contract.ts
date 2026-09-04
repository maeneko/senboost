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

/**
 * Фоновая работа: трей + автозапуск самого приложения.
 *
 * Не путать с `ZapretStatus.autoStart` — тот про автозапуск обхода (служба Windows,
 * LaunchDaemon macOS) вообще без приложения.
 */
export interface BackgroundSettings {
  /** Закрытие окна прячет его в трей, а не завершает приложение. */
  closeToTray: boolean
  /** Приложение запускается вместе с системой, сразу свёрнутым в трей. */
  launchAtLogin: boolean
  /**
   * Иконка в трее реально создалась. На Linux без AppIndicator трея нет — тогда прятать
   * туда окно нельзя, и всю группу настроек показывать бессмысленно.
   */
  trayAvailable: boolean
}

/** Состояние обхода блокировок. */
export type ZapretState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * Чем именно обходим на этой платформе — на всех трёх один и тот же движок уровня пакетов
 * (форки zapret/nfqws), запросы прав отличаются:
 *   • `utunws-pf`      — macOS: LaunchDaemon (`utunws` через utun+BPF), пароль администратора
 *                        на каждое включение/выключение (`osascript`);
 *   • `winws-service`  — Windows: служба с драйвером WinDivert;
 *   • `nfqws-nftables` — Linux: демон nfqws + правила nftables (NFQUEUE), root через pkexec
 *                        на каждое включение;
 *   • `unsupported`    — платформа без поддержки (не macOS/Windows/Linux).
 */
export type ZapretBackend = 'utunws-pf' | 'winws-service' | 'nfqws-nftables' | 'unsupported'

export interface ZapretStatus {
  state: ZapretState
  backend: ZapretBackend
  /** Выбранный пресет из `zapret:strategies`. */
  strategyId: string
  /** Когда обход включён, ISO-8601. */
  startedAt: string | null
  /** Текст последней ошибки — показываем пользователю как есть. */
  error: string | null
  /** Windows: установлена ли служба (её ставит и настраивает само приложение при первом включении). */
  serviceInstalled: boolean
  /** macOS/Windows: автозапуск с системой без запущенного приложения. На Linux не используется. */
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

  /**
   * Версия приложения — `app.getVersion()`, то есть `"version"` из package.json той сборки,
   * которая сейчас запущена. Раньше renderer держал её отдельной константой «в синхроне
   * с package.json» вручную: константа осталась на 0.4.0 и релизы 0.5.0 и 0.5.1 показали
   * пользователю чужую версию. Спрашивать у main — единственный способ не разъехаться.
   */
  'app:version': () => string

  /** Windows: подтверждает диалогом ОС, запускает деинсталлятор и закрывает приложение. */
  'app:uninstall': () => void

  'app:background-get': () => BackgroundSettings
  /**
   * Меняет переданные поля и возвращает состояние целиком. `launchAtLogin` идёт в систему
   * (планировщик задач, SMAppService, каталог автозапуска) и может не примениться — тогда
   * канал отвечает ошибкой, а не молча возвращает старое значение.
   */
  'app:background-set': (patch: Partial<BackgroundSettings>) => BackgroundSettings

  'zapret:status': () => ZapretStatus
  'zapret:strategies': () => ZapretStrategy[]
  'zapret:start': (strategyId: string) => ZapretStatus
  'zapret:stop': () => ZapretStatus
  /**
   * Выбор пресета. Если обход выключен — просто запоминается. Если включён — на macOS
   * переустанавливает LaunchDaemon с utunws (потребуется пароль администратора), на Windows
   * перенастраивает службу (потребуется UAC), на Linux перезапускает nfqws и правила
   * nftables (потребуется пароль через pkexec).
   */
  'zapret:set-strategy': (strategyId: string) => ZapretStatus
  /** macOS/Windows: автозапуск с системой; требует пароль администратора/UAC. */
  'zapret:set-autostart': (enabled: boolean) => ZapretStatus

  'zapret:lists': () => ZapretList[]
  'zapret:list-save': (id: ZapretListId, entries: string[]) => ZapretList
  'zapret:list-reset': (id: ZapretListId) => ZapretList

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
