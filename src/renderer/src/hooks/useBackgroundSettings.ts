import { useCallback, useEffect, useState } from 'react'
import type { BackgroundSettings } from '@shared/ipc-contract'

/**
 * `ipcRenderer.invoke` заворачивает сообщение из main в «Error invoking remote method
 * 'app:background-set': Error: …» — пользователю нужен только текст, который написали мы.
 */
function readableError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

/**
 * Трей и автозапуск приложения, в синхроне с main-процессом. Тот же паттерн, что и
 * `useZapretLists`, с одним отличием: `launchAtLogin` меняет систему (планировщик задач,
 * объекты входа, каталог автозапуска) и может не примениться — текст ошибки возвращаем,
 * чтобы настройки показали его рядом с переключателем, а не проглотили.
 */
export function useBackgroundSettings(): {
  settings: BackgroundSettings | null
  save: (patch: Partial<BackgroundSettings>) => Promise<void>
  error: string | null
  busy: boolean
} {
  const [settings, setSettings] = useState<BackgroundSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getBackgroundSettings().then(setSettings)
  }, [])

  const save = useCallback(async (patch: Partial<BackgroundSettings>) => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await window.api.setBackgroundSettings(patch))
    } catch (cause) {
      setError(readableError(cause))
      // Переключатель мог уже показать новое значение — возвращаем к тому, что в системе.
      setSettings(await window.api.getBackgroundSettings())
    } finally {
      setBusy(false)
    }
  }, [])

  return { settings, save, error, busy }
}
