import { useEffect, useState } from 'react'

/**
 * Версия запущенной сборки — та же, что в имени установщика и в «Установленных
 * приложениях»: main отдаёт её через `app.getVersion()`, то есть прямо из package.json.
 *
 * Раньше renderer держал версию своей константой с пометкой «держать в синхроне с
 * package.json». Синхронизировать вручную забыли: константа осталась на 0.4.0, и релизы
 * 0.5.0 и 0.5.1 показывали пользователю чужую версию. Спрашивать у main дороже на один
 * IPC-вызов, зато разъехаться уже нечему.
 *
 * `null` — версия ещё не пришла; показывать её в этот момент нечего.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    // Окно могло закрыться, пока шёл ответ — тогда setState уже некому применять.
    let cancelled = false
    void window.api.getAppVersion().then((value) => {
      if (!cancelled) setVersion(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return version
}
