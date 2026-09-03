import { useEffect } from 'react'

/**
 * Синхронизирует окно с системной темой: следит за `nativeTheme` main-процесса
 * и вешает класс `.dark` на <html>. Ручного переключателя нет — приложение
 * всегда следует настройке ОС.
 */
export function useTheme(): void {
  useEffect(() => {
    void window.api.getTheme().then((theme) => {
      document.documentElement.classList.toggle('dark', theme.shouldUseDarkColors)
    })

    return window.api.onThemeChanged((theme) => {
      document.documentElement.classList.toggle('dark', theme.shouldUseDarkColors)
    })
  }, [])
}
