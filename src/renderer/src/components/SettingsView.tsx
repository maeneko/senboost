import { useState } from 'react'
import type { ZapretListId, ZapretStatus } from '@shared/ipc-contract'
import { GITHUB_URL } from '@shared/links'
import { useAppVersion } from '../hooks/useAppVersion'
import { useZapretLists } from '../hooks/useZapretLists'
import { LIST_TITLES } from '../lib/zapretListMeta'
import ListEditor from './ListEditor'

/**
 * Настройки: списки сайтов + автозапуск (Windows). Выбор стратегии и проверка
 * соединения переехали на главный экран (ZapretCard.tsx) — рядом с кнопкой
 * включения, где ими и пользуются. Отдельный экран за шестерёнкой в шапке.
 */
const isWindows = window.api.platform === 'win32'
const isDarwin = window.api.platform === 'darwin'
const APP_CHANNEL = 'beta'

export default function SettingsView({
  onBack,
  status,
  onSetAutoStart
}: {
  onBack: () => void
  status: ZapretStatus | null
  onSetAutoStart: (enabled: boolean) => Promise<void>
}): React.JSX.Element {
  const { lists, autoHostlist, save, reset, clearAuto } = useZapretLists()
  const [openListId, setOpenListId] = useState<ZapretListId | null>(null)
  const appVersion = useAppVersion()

  const openList = lists.find((list) => list.id === openListId)
  if (openList) {
    return (
      <ListEditor
        list={openList}
        onBack={() => setOpenListId(null)}
        onSave={async (entries) => {
          await save(openList.id, entries)
        }}
        onReset={async () => {
          await reset(openList.id)
        }}
      />
    )
  }

  return (
    <section className="settings">
      <div className="settings__back-row">
        <button type="button" className="settings__back" onClick={onBack}>
          ‹ Назад
        </button>
        <h2 className="settings__title">Настройки</h2>
      </div>

      {isWindows && (
        <div className="settings__group">
          <span className="settings__label">Автозапуск</span>
          <button
            type="button"
            className="settings-row"
            onClick={() => void onSetAutoStart(!status?.autoStart)}
          >
            <span>Запускать вместе с Windows</span>
            <span className={`chip ${status?.autoStart ? 'chip--success' : 'chip--neutral'}`}>
              {status?.autoStart ? 'Включён' : 'Выключен'}
            </span>
          </button>
          <p className="list-editor__hint">
            Меняется через запрос прав администратора. Если выключить обход кнопкой на главном
            экране, при включённом автозапуске он вернётся не раньше следующей перезагрузки.
          </p>
        </div>
      )}

      <div className="settings__group">
        <span className="settings__label">Сайты</span>

        {lists.map((list) => (
          <button
            key={list.id}
            type="button"
            className="settings-row"
            onClick={() => setOpenListId(list.id)}
          >
            <span>{LIST_TITLES[list.id]}</span>
            <span className="settings-row__count">{list.entries.length} ›</span>
          </button>
        ))}

        {/* --hostlist-auto есть только в darwin-профилях (см. strategies.ts) — ни одна из 22
            стратегий Flowseal (Windows и Linux) его не использует, счётчик там всегда пуст. */}
        {isDarwin && (
          <div className="settings-row settings-row--static">
            <span>Найдено автоматически</span>
            <span className="settings-row__count">
              {autoHostlist.length}
              {autoHostlist.length > 0 && (
                <button
                  type="button"
                  className="settings-row__clear"
                  onClick={() => void clearAuto()}
                >
                  Очистить
                </button>
              )}
            </span>
          </div>
        )}
      </div>

      <section className="card settings__support">
        <h2>Поддержка</h2>
        {/* Ссылка уходит в системный браузер: will-navigate в window.ts перехватывает
            переход и отдаёт его openExternal с проверкой протокола. */}
        <a href={GITHUB_URL} className="action--outline settings__support-link">
          GitHub
        </a>
        <p className="settings__support-hint">Поддержите звёздочкой</p>
      </section>

      {/* Пока версия не пришла из main, строки нет вовсе: иначе на первом кадре
          мелькнуло бы «beta--win32» с пустотой на месте номера. */}
      {appVersion && (
        <p className="settings__version">
          {APP_CHANNEL}-{appVersion}-{window.api.platform}
        </p>
      )}

      {isWindows && (
        <button
          type="button"
          className="action--danger"
          onClick={() => void window.api.uninstallApp()}
        >
          Удалить приложение
        </button>
      )}
    </section>
  )
}
