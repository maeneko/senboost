import type {
  ZapretDiagnosticResult,
  ZapretDiagnosticTarget,
  ZapretList,
  ZapretListId,
  ZapretLogLine,
  ZapretStatus,
  ZapretStrategy
} from '../../shared/ipc-contract'
import { getSettings } from '../settings'
import { DIAGNOSTIC_TARGETS, runDiagnostics } from './diagnostics'
import { DarwinEngine } from './engine.darwin'
import { ZapretEngine, UnsupportedEngine, onZapretStatusChanged } from './engine'
import { LinuxEngine } from './engine.linux'
import { Win32Engine } from './engine.win32'
import { readAllLists, resetList, seedLists, writeList } from './lists'
import { restoreSystemProxy } from './proxy.darwin'
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
 * состояние с системой — на macOS подхватываем LaunchDaemon, который мог работать ещё до
 * открытия окна (автозапуск с системой) и один раз чиним системный прокси, оставшийся от
 * версий на tpws (≤0.5.4, см. `proxy.darwin.ts`), на Windows подхватываем службу с тем же
 * автозапуском, на Linux — демон nfqws, переживший закрытие приложения (автозапуска у него
 * нет, но сам процесс и правила nftables продолжают работать). Все шаги нужно сделать до
 * открытия окна.
 */
export async function recoverZapret(): Promise<void> {
  await seedLists()

  // Сохранённый выбор применяем ДО sync(): у уже установленной службы/демона реальное
  // состояние (стратегия в strategy.cfg, автозапуск) важнее записанного нами и перекроет его.
  // Файл к этому моменту уже прочитан в `app.whenReady()` (см. `src/main/index.ts`).
  const settings = getSettings()
  engine.restorePreferences({
    // Стратегия могла исчезнуть в обновлении (подборка Flowseal меняется) или остаться от
    // запуска на другой платформе — тогда безопаснее вернуться к умолчанию движка, чем
    // стартовать с id, которого больше нет.
    strategyId: knownStrategyId(settings.strategyId),
    autoStart: settings.autoStart
  })

  if (engine instanceof DarwinEngine) {
    await restoreSystemProxy().catch(() => {
      // Раз откатить не удалось — оставляем как есть, не мешаем окну открыться.
    })
    await engine.sync()
  }
  if (engine instanceof Win32Engine) await engine.sync()
  if (engine instanceof LinuxEngine) await engine.sync()
}

function knownStrategyId(strategyId: string | null): string | null {
  if (!strategyId) return null
  const known = listStrategies(process.platform).some((strategy) => strategy.id === strategyId)
  return known ? strategyId : null
}

export { onZapretStatusChanged }

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
  runDiagnostics(onResult).catch((error: unknown) => {
    console.error('[zapret] проверка соединения завершилась ошибкой:', error)
  })
  return DIAGNOSTIC_TARGETS
}
