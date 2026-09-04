import { useZapret } from '../hooks/useZapret'
import { useZapretDiagnostics } from '../hooks/useZapretDiagnostics'

/** Карточка обхода блокировок: статус и включение сверху, выбор стратегии и проверка соединения ниже. */
export default function ZapretCard(): React.JSX.Element {
  const { status, strategies, start, stop, setStrategy, busy } = useZapret()
  const { targets, results, running: testing, run: runTest } = useZapretDiagnostics()

  const running = status?.state === 'running' || status?.state === 'starting'
  const strategyId = status?.strategyId ?? strategies[0]?.id

  const toggle = (): void => {
    if (!strategyId) return
    void (running ? stop() : start(strategyId))
  }

  const chip = ((): { className: string; label: string } => {
    switch (status?.state) {
      case 'running':
        return { className: 'chip--success', label: 'Активен' }
      case 'starting':
      case 'stopping':
        return { className: 'chip--neutral', label: 'Переключение…' }
      case 'error':
        return { className: 'chip--error', label: 'Ошибка' }
      default:
        return { className: 'chip--neutral', label: 'Выключен' }
    }
  })()

  const toggleLabel =
    status?.state === 'stopping' ? 'Выключение…' : running ? 'Выключить' : 'Включить'

  return (
    <section className="card zapret-card">
      <div className="zapret-card__head">
        <h2 className="zapret-card__title">Обход блокировок</h2>
        <span className={`chip ${chip.className}`}>{chip.label}</span>
      </div>

      <button
        type="button"
        className={`toggle-button${running ? ' toggle-button--on' : ''}`}
        disabled={busy || !strategyId}
        onClick={toggle}
      >
        {toggleLabel}
      </button>

      {/* Не только при state === 'error': UnsupportedEngine (платформа без сборки движка)
          пишет причину в error, оставляя state 'stopped' — иначе текст был бы недостижим,
          а пользователь на неподдерживаемой платформе видел бы пустой список стратегий
          без единого объяснения. */}
      {status?.error && <p className="list-editor__error">{status.error}</p>}

      <div className="settings__field">
        <span className="settings__label">Способ</span>
        {/* На время переключения список заблокирован: смена стратегии на работающем
            обходе останавливает и перенастраивает службу, и второй выбор посреди этого
            наложился бы на первый. */}
        <select
          className="select"
          disabled={busy}
          value={status?.strategyId ?? ''}
          onChange={(event) => void setStrategy(event.target.value)}
        >
          {strategies.map((strategy) => (
            <option key={strategy.id} value={strategy.id}>
              {strategy.name}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        className="action--outline zapret-card__test-button"
        disabled={testing}
        onClick={() => void runTest()}
      >
        {testing ? 'Проверяю…' : 'Протестить'}
      </button>

      {/* Строки появляются сразу все, ещё до первого ответа, и заполняются по мере
          готовности — иначе список прыгал бы, дорисовываясь по одной строке. */}
      {targets.length > 0 && (
        <div className="settings__group">
          {targets.map((target) => {
            const result = results[target.id]
            return (
              <div key={target.id} className="settings-row settings-row--static">
                {/* Причину показываем текстом, а не только подсказкой при наведении:
                    «Недоступно» само по себе не говорит, что чинить. */}
                <span className="diagnostic__label">
                  {target.label}
                  {result && !result.ok && result.error && (
                    <small className="diagnostic__error">{result.error}</small>
                  )}
                </span>
                {result ? (
                  <span className={`chip ${result.ok ? 'chip--success' : 'chip--error'}`}>
                    {result.ok ? `${result.ms} мс` : 'Недоступно'}
                  </span>
                ) : (
                  <span className="chip chip--neutral">Проверяю…</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
