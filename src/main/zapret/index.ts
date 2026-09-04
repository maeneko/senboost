import { readFile, rm } from 'node:fs/promises'
import type {
  ZapretDiagnosticResult,
  ZapretDiagnosticTarget,
  ZapretList,
  ZapretListId,
  ZapretLogLine,
  ZapretStatus,
  ZapretStrategy
} from '../../shared/ipc-contract'
import { loadSettings } from '../settings'
import { DIAGNOSTIC_TARGETS, runDiagnostics } from './diagnostics'
import { DarwinEngine } from './engine.darwin'
import { ZapretEngine, UnsupportedEngine } from './engine'
import { LinuxEngine } from './engine.linux'
import { Win32Engine } from './engine.win32'
import { readAllLists, resetList, seedLists, writeList } from './lists'
import { autoHostlistPath } from './paths'
import { listStrategies } from './strategies'

function createEngine(): ZapretEngine {
  switch (process.platform) {
    case 'darwin':
      return new DarwinEngine()
    case 'win32':
      return new Win32Engine()
    case 'linux':
      return new LinuxEngine()
    default:
      return new UnsupportedEngine()
  }
}

const engine = createEngine()

/**
 * Готовим списки сайтов, возвращаем выбор пользователя из прошлого запуска и синхронизируем
 * состояние с системой — на macOS чиним прокси от прошлого аварийного завершения, на Windows
 * подхватываем службу, которая могла работать ещё до открытия окна (автозапуск с системой),
 * на Linux — демон nfqws, переживший закрытие приложения (автозапуска у него нет, но сам
 * процесс и правила nftables продолжают работать). Все шаги нужно сделать до открытия окна.
 */
export async function recoverZapret(): Promise<void> {
  await seedLists()

  // Сохранённый выбор применяем ДО sync(): на Windows у уже установленной службы реальное
  // состояние (стратегия в strategy.cfg, StartMode) важнее записанного нами и перекроет его.
  const settings = await loadSettings()
  engine.restorePreferences({
    // Стратегия могла исчезнуть в обновлении (подборка Flowseal меняется) или остаться от
    // запуска на другой платформе — тогда безопаснее вернуться к умолчанию движка, чем
    // стартовать с id, которого больше нет.
    strategyId: knownStrategyId(settings.strategyId),
    autoStart: settings.autoStart
  })

  if (engine instanceof DarwinEngine) await engine.recoverFromCrash()
  if (engine instanceof Win32Engine) await engine.sync()
  if (engine instanceof LinuxEngine) await engine.sync()
}

function knownStrategyId(strategyId: string | null): string | null {
  if (!strategyId) return null
  const known = listStrategies(process.platform).some((strategy) => strategy.id === strategyId)
  return known ? strategyId : null
}

export function zapretStatus(): ZapretStatus {
  return engine.getStatus()
}

export function zapretStrategies(): ZapretStrategy[] {
  return listStrategies(process.platform)
}

export function zapretLog(): ZapretLogLine[] {
  return engine.getLog()
}

export function startZapret(strategyId: string): Promise<ZapretStatus> {
  return engine.start(strategyId)
}

export function stopZapret(): Promise<ZapretStatus> {
  return engine.stop()
}

export function setZapretSystemProxy(enabled: boolean): Promise<ZapretStatus> {
  return engine.setSystemProxy(enabled)
}

export function setZapretStrategy(strategyId: string): Promise<ZapretStatus> {
  return engine.setStrategy(strategyId)
}

export function setZapretAutoStart(enabled: boolean): Promise<ZapretStatus> {
  return engine.setAutoStart(enabled)
}

/** Вызывать при выходе из приложения — гасит процесс и откатывает системные настройки. */
export function disposeZapret(): Promise<void> {
  return engine.dispose()
}

export function zapretLists(): Promise<ZapretList[]> {
  return readAllLists()
}

export function saveZapretList(id: ZapretListId, entries: string[]): Promise<ZapretList> {
  return writeList(id, entries)
}

export function resetZapretList(id: ZapretListId): Promise<ZapretList> {
  return resetList(id)
}

/** Домены, которые zapret нашёл сам через `--hostlist-auto` (только macOS-профили). */
export async function zapretAutoHostlist(): Promise<string[]> {
  try {
    const content = await readFile(autoHostlistPath(), 'utf8')
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function clearZapretAutoHostlist(): Promise<void> {
  await rm(autoHostlistPath(), { force: true })
}

/**
 * Запускает проверку и сразу возвращает список сайтов — результаты приходят в `onResult`
 * по одному, по мере готовности (см. `runDiagnostics`). Промис проверки намеренно не ждём:
 * ответ на IPC — это список сайтов, чтобы UI успел показать строки «Проверяю…» до того,
 * как ответит первый сайт.
 */
export function zapretDiagnostics(
  onResult: (result: ZapretDiagnosticResult) => void
): ZapretDiagnosticTarget[] {
  // Каждая проверка ловит свою ошибку сама, наружу выбраться нечему — ловим здесь только
  // чтобы неожиданное падение не осталось необработанным промисом.
  runDiagnostics(engine.getStatus(), onResult).catch((error: unknown) => {
    console.error('[zapret] проверка соединения завершилась ошибкой:', error)
  })
  return DIAGNOSTIC_TARGETS
}
