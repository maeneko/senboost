import { useCallback, useEffect, useState } from 'react'
import type { ZapretList, ZapretListId } from '@shared/ipc-contract'

/**
 * Списки сайтов, в синхроне с main-процессом. Тот же паттерн, что и `useZapret`/`useTheme`.
 */
export function useZapretLists(): {
  lists: ZapretList[]
  save: (id: ZapretListId, entries: string[]) => Promise<ZapretList>
  reset: (id: ZapretListId) => Promise<ZapretList>
  loading: boolean
} {
  const [lists, setLists] = useState<ZapretList[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void window.api.getZapretLists().then((nextLists) => {
      setLists(nextLists)
      setLoading(false)
    })
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

  return { lists, save, reset, loading }
}
