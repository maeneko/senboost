import { readFile, rm } from 'node:fs/promises'
import type {
  ZapretDiagnosticResult,
  ZapretList,
  ZapretListId,
  ZapretLogLine,
  ZapretStatus,
  ZapretStrategy
} from '../../shared/ipc-contract'
import { runDiagnostics } from './diagnostics'
import { DarwinEngine } from './engine.darwin'
import { ZapretEngine, UnsupportedEngine } from './engine'
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
    default:
      return new UnsupportedEngine()
  }
}

const engine = createEngine()

/**
 * Готовим списки сайтов и синхронизируем состояние с системой — на macOS чиним прокси
 * от прошлого аварийного завершения, на Windows подхватываем службу, которая могла работать
 * ещё до открытия окна (автозапуск с системой). Оба шага нужно сделать до открытия окна.
 */
export async function recoverZapret(): Promise<void> {
  await seedLists()
  if (engine instanceof DarwinEngine) await engine.recoverFromCrash()
  if (engine instanceof Win32Engine) await engine.sync()
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

export function zapretDiagnostics(): Promise<ZapretDiagnosticResult[]> {
  return runDiagnostics(engine.getStatus())
}
