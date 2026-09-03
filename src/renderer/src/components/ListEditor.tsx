import { useState } from 'react'
import type { ZapretList } from '@shared/ipc-contract'
import { LIST_HINTS, LIST_TITLES } from '../lib/zapretListMeta'

/** Экран одного списка: чипы с удалением, поле добавления, сброс к встроенному. */
export default function ListEditor({
  list,
  onBack,
  onSave,
  onReset
}: {
  list: ZapretList
  onBack: () => void
  onSave: (entries: string[]) => Promise<void>
  onReset: () => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = (entry: string): void => {
    void run(list.entries.filter((item) => item !== entry))
  }

  const add = (): void => {
    const value = draft.trim()
    if (!value) return
    void run([...list.entries, value])
  }

  const run = async (entries: string[]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onSave(entries)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="list-editor">
      <div className="settings__back-row">
        <button type="button" className="settings__back" onClick={onBack}>
          ‹ Назад
        </button>
        <h2 className="settings__title">{LIST_TITLES[list.id]}</h2>
      </div>

      <p className="list-editor__hint">{LIST_HINTS[list.id]}</p>

      <div className="list-editor__chips">
        {list.entries.length === 0 && <p className="list-editor__empty">Список пуст.</p>}
        {list.entries.map((entry) => (
          <span key={entry} className="chip chip--removable">
            {entry}
            <button
              type="button"
              className="chip__remove"
              aria-label={`Убрать ${entry}`}
              disabled={busy}
              onClick={() => remove(entry)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>

      <div className="list-editor__add-row">
        <input
          type="text"
          className="text-input"
          placeholder={
            list.id === 'ipset-exclude' || list.id === 'ipset-all'
              ? '192.168.0.0/16'
              : 'example.com'
          }
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
        />
        <button
          type="button"
          className="action--outline"
          disabled={busy || !draft.trim()}
          onClick={add}
        >
          Добавить
        </button>
      </div>

      {error && <p className="list-editor__error">{error}</p>}

      <button
        type="button"
        className="list-editor__reset"
        disabled={busy || list.isDefault}
        onClick={() => void onReset()}
      >
        Сбросить к встроенному
      </button>
    </section>
  )
}
