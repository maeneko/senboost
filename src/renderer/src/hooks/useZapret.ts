import { useCallback, useEffect, useState } from 'react'
import type { ZapretLogLine, ZapretStatus, ZapretStrategy } from '@shared/ipc-contract'

const LOG_LIMIT = 50

/**
 * Статус обхода блокировок + список пресетов, в синхроне с main-процессом.
 * Тот же паттерн, что и `useTheme`: получить текущее значение, подписаться
 * на изменения, вернуть функцию отписки из useEffect.
 */
export function useZapret(): {
  status: ZapretStatus | null
  strategies: ZapretStrategy[]
  log: ZapretLogLine[]
  start: (strategyId: string) => Promise<void>
  stop: () => Promise<void>
  setStrategy: (strategyId: string) => Promise<void>
  setAutoStart: (enabled: boolean) => Promise<void>
  busy: boolean
} {
  const [status, setStatus] = useState<ZapretStatus | null>(null)
  const [strategies, setStrategies] = useState<ZapretStrategy[]>([])
  const [log, setLog] = useState<ZapretLogLine[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getZapretStatus().then(setStatus)
    void window.api.getZapretStrategies().then(setStrategies)
    return window.api.onZapretStatusChanged(setStatus)
  }, [])

  useEffect(() => {
    return window.api.onZapretLog((entry) => {
      setLog((previous) => [...previous, entry].slice(-LOG_LIMIT))
    })
  }, [])

  const start = useCallback(async (strategyId: string) => {
    setBusy(true)
    try {
      setStatus(await window.api.startZapret(strategyId))
    } finally {
      setBusy(false)
    }
  }, [])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await window.api.stopZapret())
    } finally {
      setBusy(false)
    }
  }, [])

  const setStrategy = useCallback(async (strategyId: string) => {
    setBusy(true)
    try {
      setStatus(await window.api.setZapretStrategy(strategyId))
    } finally {
      setBusy(false)
    }
  }, [])

  const setAutoStart = useCallback(async (enabled: boolean) => {
    setBusy(true)
    try {
      setStatus(await window.api.setZapretAutoStart(enabled))
    } finally {
      setBusy(false)
    }
  }, [])

  return { status, strategies, log, start, stop, setStrategy, setAutoStart, busy }
}
