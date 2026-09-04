import { useState } from 'react'
import SettingsView from './components/SettingsView'
import ZapretCard from './components/ZapretCard'
import { useTheme } from './hooks/useTheme'
import { useZapret } from './hooks/useZapret'

export default function App(): React.JSX.Element {
  useTheme()
  const { status, setAutoStart } = useZapret()
  const [showSettings, setShowSettings] = useState(false)

  return (
    <main className="content">
      {showSettings ? (
        <SettingsView
          onBack={() => setShowSettings(false)}
          status={status}
          onSetAutoStart={setAutoStart}
        />
      ) : (
        <>
          <div className="app-header">
            <span className="app-header__name">SenBoost</span>
            <button
              type="button"
              className="app-header__settings"
              aria-label="Настройки"
              onClick={() => setShowSettings(true)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="2.5" fill="currentColor" />
                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
                  <rect
                    key={angle}
                    x="10.5"
                    y="0.5"
                    width="3"
                    height="3.5"
                    rx="0.8"
                    fill="currentColor"
                    transform={`rotate(${angle} 12 12)`}
                  />
                ))}
              </svg>
            </button>
          </div>

          <ZapretCard />
        </>
      )}
    </main>
  )
}
