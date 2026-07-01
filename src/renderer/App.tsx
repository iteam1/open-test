import { useState } from 'react'
import { Dashboard } from './Dashboard'
import { SessionView } from './SessionView'
import { useTheme } from './useTheme'
import { SunIcon, MoonIcon } from './Icons'

type View = { type: 'dashboard' } | { type: 'session'; sessionId: string }

export function App() {
  const [view, setView] = useState<View>({ type: 'dashboard' })
  const [theme, setTheme] = useTheme()

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-title">open-test</span>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          aria-label="Toggle light/dark theme"
          title="Toggle light/dark theme"
        >
          {theme === 'light' ? <MoonIcon /> : <SunIcon />}
        </button>
      </header>
      <main className="main-content">
        {view.type === 'dashboard' ? (
          <Dashboard
            onOpenSession={(sessionId) =>
              setView({ type: 'session', sessionId })
            }
          />
        ) : (
          <SessionView
            sessionId={view.sessionId}
            onBack={() => setView({ type: 'dashboard' })}
          />
        )}
      </main>
    </div>
  )
}
