import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Выбор пользователя между запусками: `settings.json` в userData (на Windows —
 * `%AppData%\SenBoost`), поэтому переживает обновление и переустановку.
 *
 * Списки сайтов сюда не входят: они лежат рядом, в `userData/zapret-lists/*.txt`, и
 * читаются прямо оттуда самими tpws и winws (см. `zapret/lists.ts`).
 *
 * `null` — «пользователь не выбирал», решает движок.
 */
export interface AppSettings {
  strategyId: string | null
  /** Windows: запускать службу вместе с системой. На macOS не используется. */
  autoStart: boolean | null
  /** Закрытие окна прячет его в трей вместо выхода. `null` — не выбирали, считаем включённым. */
  closeToTray: boolean | null
  /** Подсказку «свернулся в трей и продолжаю работать» уже показывали. */
  trayHintShown: boolean | null
}

const DEFAULTS: AppSettings = {
  strategyId: null,
  autoStart: null,
  closeToTray: null,
  trayHintShown: null
}

let cache: AppSettings = { ...DEFAULTS }

/** До первой загрузки не пишем: иначе движок затёр бы файл умолчаниями. */
let loaded = false

/** Очередь, чтобы два быстрых переключения не переставили rename местами. */
let writeQueue: Promise<void> = Promise.resolve()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Файл могли испортить или он остался от версии с другими полями — непонятное отбрасываем. */
function sanitize(raw: unknown): AppSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    strategyId: typeof value.strategyId === 'string' && value.strategyId ? value.strategyId : null,
    autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : null,
    closeToTray: typeof value.closeToTray === 'boolean' ? value.closeToTray : null,
    trayHintShown: typeof value.trayHintShown === 'boolean' ? value.trayHintShown : null
  }
}

/** Читает настройки с диска. Вызывать один раз при старте, до создания окна. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    cache = sanitize(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    cache = { ...DEFAULTS } // первый запуск или нечитаемый файл
  }
  loaded = true
  return { ...cache }
}

/** Атомарная запись: временный файл рядом + rename, как в `zapret/lists.ts`. */
async function writeSettings(settings: AppSettings): Promise<void> {
  const path = settingsPath()
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Настройки, прочитанные при старте. До `loadSettings()` — умолчания. */
export function getSettings(): AppSettings {
  return { ...cache }
}

/**
 * Сохранить изменившиеся поля. Вызывается в том числе из `ZapretEngine.patch()`, то есть на
 * каждое изменение статуса — отсюда сравнение с прошлым значением. Записи не ждём: интерфейс
 * не должен зависеть от диска, а не сохранившийся выбор не повод ломать работающий обход.
 */
export function rememberPreferences(patch: Partial<AppSettings>): void {
  if (!loaded) return

  const settings: AppSettings = { ...cache, ...patch }
  const keys = Object.keys(settings) as (keyof AppSettings)[]
  if (keys.every((key) => settings[key] === cache[key])) return

  cache = settings
  writeQueue = writeQueue
    .then(() => writeSettings(settings))
    .catch((error: unknown) => console.warn('[settings] не удалось сохранить:', error))
}
