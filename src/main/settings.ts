import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Выбор пользователя, который должен пережить перезапуск приложения. Лежит в userData
 * (`%AppData%\RKNboost\settings.json` на Windows — каталог по `productName` из
 * electron-builder.yml) — то есть переживает и обновление, и переустановку приложения.
 *
 * Списки сайтов сюда намеренно не входят: они и так хранятся рядом, в
 * `userData/zapret-lists/*.txt` (см. `zapret/lists.ts`), каждый в своём файле — их читают
 * прямо оттуда сами tpws и winws, и дублировать те же домены ещё и здесь означало бы
 * держать два источника правды.
 *
 * `null` в любом поле — «пользователь ничего не выбирал»: тогда решает движок (стратегия
 * по умолчанию для платформы, автозапуск — как решил `Win32Engine`).
 */
export interface AppSettings {
  /** Последняя выбранная стратегия обхода. */
  strategyId: string | null
  /** Windows: запускать службу вместе с системой. На macOS не используется. */
  autoStart: boolean | null
}

const DEFAULTS: AppSettings = { strategyId: null, autoStart: null }

/**
 * Кэш в памяти нужен не для скорости, а чтобы писать только при реальном изменении:
 * `rememberPreferences` дёргается из `ZapretEngine.patch()`, то есть на каждое изменение
 * статуса, включая промежуточные `starting`/`stopping`.
 */
let cache: AppSettings = { ...DEFAULTS }

/**
 * До первой загрузки не пишем ничего: иначе движок, успевший обновить статус раньше
 * `loadSettings()`, затёр бы файл значениями по умолчанию.
 */
let loaded = false

/** Записи выстраиваем в очередь — параллельные rename в один файл друг друга обгоняют. */
let writeQueue: Promise<void> = Promise.resolve()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Файл мог быть испорчен (аварийное завершение на записи) или остаться от версии с другим
 * набором полей — читаем его как чужие данные, а не как свои: всё непонятное отбрасываем
 * и продолжаем с умолчаниями, а не падаем на старте.
 */
function sanitize(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const value = raw as Record<string, unknown>

  return {
    strategyId: typeof value.strategyId === 'string' && value.strategyId ? value.strategyId : null,
    autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : null
  }
}

/** Читает настройки с диска. Вызывать один раз при старте, до создания окна. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    cache = sanitize(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    // Файла ещё нет (первый запуск) или он нечитаем — начинаем с умолчаний.
    cache = { ...DEFAULTS }
  }
  loaded = true
  return { ...cache }
}

/** Атомарная запись: временный файл рядом + rename, как в `zapret/lists.ts`. */
async function writeSettings(settings: AppSettings): Promise<void> {
  const path = settingsPath()
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    // Не смогли сохранить выбор — это неприятно, но не повод ломать работающий обход.
    console.warn('[settings] не удалось сохранить настройки:', error)
    await unlink(tmp).catch(() => {})
  }
}

/**
 * Запоминает выбор пользователя. Вызывается из `ZapretEngine.patch()` на каждое изменение
 * статуса, поэтому пишет на диск только когда что-то из сохраняемого действительно
 * поменялось, и не ждёт записи: статус в интерфейсе не должен зависеть от файловой системы.
 */
export function rememberPreferences(preferences: Partial<AppSettings>): void {
  if (!loaded) return

  const next: AppSettings = {
    strategyId: preferences.strategyId ?? cache.strategyId,
    autoStart: preferences.autoStart ?? cache.autoStart
  }
  if (next.strategyId === cache.strategyId && next.autoStart === cache.autoStart) return

  cache = next
  writeQueue = writeQueue.then(() => writeSettings(next))
}
