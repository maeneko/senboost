import { useCallback, useEffect, useState } from 'react'
import type { ZapretDiagnosticResult, ZapretDiagnosticTarget } from '@shared/ipc-contract'

/**
 * Проверка соединения по клику — не авто-подписка, как в useZapret/useZapretLists.
 *
 * `run()` только запускает проверку и получает список сайтов; результаты приходят по
 * одному событием и складываются в `results` по мере готовности — живой сайт отвечает за
 * десятки миллисекунд, заблокированный молчит до таймаута в 10 с, и ждать общего ответа
 * значило бы держать пользователя перед пустым экраном ровно столько же.
 */
export function useZapretDiagnostics(): {
  targets: ZapretDiagnosticTarget[]
  results: Record<string, ZapretDiagnosticResult>
  running: boolean
  run: () => Promise<void>
} {
  const [targets, setTargets] = useState<ZapretDiagnosticTarget[]>([])
  const [results, setResults] = useState<Record<string, ZapretDiagnosticResult>>({})
  const [started, setStarted] = useState(false)

  // Подписка живёт всё время жизни компонента, а не только на время проверки: результат
  // приходит асинхронно, и подписываться в момент клика — значит гоняться с первым же
  // быстрым ответом.
  useEffect(
    () =>
      window.api.onZapretDiagnosticResult((result) => {
        setResults((previous) => ({ ...previous, [result.id]: result }))
      }),
    []
  )

  const run = useCallback(async () => {
    setStarted(true)
    // Чистим до запроса: иначе прошлые результаты остались бы на экране рядом со свежими,
    // и было бы не понять, какие из них к какой проверке.
    setResults({})
    setTargets(await window.api.runZapretDiagnostics())
  }, [])

  // Проверка идёт, пока пришли не все результаты. Каждый сайт отдаёт ровно один результат
  // (см. runDiagnostics — там перехвачена и ошибка), так что счёт всегда сходится.
  const finished = targets.length > 0 && targets.every((target) => results[target.id])

  return { targets, results, running: started && !finished, run }
}
