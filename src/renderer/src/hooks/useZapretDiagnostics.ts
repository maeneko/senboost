import { useCallback, useState } from 'react'
import type { ZapretDiagnosticResult } from '@shared/ipc-contract'

/** Проверка соединения по клику — не авто-подписка, как в useZapret/useZapretLists. */
export function useZapretDiagnostics(): {
  results: ZapretDiagnosticResult[]
  running: boolean
  run: () => Promise<void>
} {
  const [results, setResults] = useState<ZapretDiagnosticResult[]>([])
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    setRunning(true)
    try {
      setResults(await window.api.runZapretDiagnostics())
    } finally {
      setRunning(false)
    }
  }, [])

  return { results, running, run }
}
