import { useCallback, useEffect, useState } from 'react'
import type { ZapretList, ZapretListId } from '@shared/ipc-contract'

/**
 * Списки сайтов + журнал автообнаружения, в синхроне с main-процессом.
 * Тот же паттерн, что и `useZapret`/`useTheme`.
 */
export function useZapretLists(): {
  lists: ZapretList[]
  autoHostlist: string[]
  save: (id: ZapretListId, entries: string[]) => Promise<ZapretList>
  reset: (id: ZapretListId) => Promise<ZapretList>
  clearAuto: () => Promise<void>
  loading: boolean
} {
  const [lists, setLists] = useState<ZapretList[]>([])
  const [autoHostlist, setAutoHostlist] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void Promise.all([window.api.getZapretLists(), window.api.getZapretAutoHostlist()]).then(
      ([nextLists, nextAuto]) => {
        setLists(nextLists)
        setAutoHostlist(nextAuto)
        setLoading(false)
      }
    )
  }, [])

  const save = useCallback(async (id: ZapretListId, entries: string[]) => {
    const updated = await window.api.saveZapretList(id, entries)
    setLists((previous) => previous.map((list) => (list.id === id ? updated : list)))
    return updated
  }, [])

  const reset = useCallback(async (id: ZapretListId) => {
    const updated = await window.api.resetZapretList(id)
    setLists((previous) => previous.map((list) => (list.id === id ? updated : list)))
    return updated
  }, [])

  const clearAuto = useCallback(async () => {
    await window.api.clearZapretAutoHostlist()
    setAutoHostlist([])
  }, [])

  return { lists, autoHostlist, save, reset, clearAuto, loading }
}
