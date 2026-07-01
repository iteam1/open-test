import { useCallback, useEffect, useState } from 'react'
import type { SessionSummary } from '../io/claudeRunner'
import { NewSessionModal } from './NewSessionModal'

type Props = {
  onOpenSession: (sessionId: string) => void
}

const COLUMNS: { key: SessionSummary['status']; label: string }[] = [
  { key: 'idle', label: 'Idle' },
  { key: 'running', label: 'Running' },
  { key: 'closed', label: 'Closed' },
]

export function Dashboard({ onOpenSession }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showNewSession, setShowNewSession] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.listSessions()
      setSessions(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Live status updates (e.g. a kill, or the idle-timeout interval firing
  // in the background) update the relevant card without a full re-fetch —
  // 3.2's "kill moves a card to Closed" depends on this.
  useEffect(() => {
    return window.api.onStatus((sessionId, status) => {
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, status } : s)),
      )
    })
  }, [])

  // Passed to the modal — it awaits this and, if it throws (duplicate or
  // invalid id, checked in the main process), shows the message and stays
  // open. On success we close, refresh, and jump straight into the session.
  async function handleCreate(opts: {
    sessionId?: string
    description?: string
  }) {
    const { sessionId } = await window.api.createSession(opts)
    setShowNewSession(false)
    await refresh()
    onOpenSession(sessionId)
  }

  function startRename(session: SessionSummary) {
    setRenamingId(session.sessionId)
    setRenameValue(session.displayName)
  }

  async function commitRename(session: SessionSummary) {
    setRenamingId(null)
    const title = renameValue.trim()
    if (!session.claudeSessionId || !title || title === session.displayName) {
      return
    }
    try {
      await window.api.renameSession(session.claudeSessionId, title)
      await refresh()
    } catch {
      // Rename failed server-side (e.g. a stale/invalid claudeSessionId) —
      // nothing to recover client-side, but don't leave an unhandled
      // rejection (advisor-found gap).
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Sessions</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowNewSession(true)}
        >
          + New session
        </button>
      </div>

      {showNewSession && (
        <NewSessionModal
          onCreate={handleCreate}
          onCancel={() => setShowNewSession(false)}
        />
      )}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      ) : (
        <div className="columns">
          {COLUMNS.map((column) => {
            const columnSessions = sessions.filter(
              (s) => s.status === column.key,
            )
            return (
              <div key={column.key}>
                <div className="column-header">
                  {column.label}
                  <span className="column-count">{columnSessions.length}</span>
                </div>
                <div className="column-body">
                  {columnSessions.length === 0 && (
                    <div className="column-empty">No sessions</div>
                  )}
                  {columnSessions.map((session) => (
                    <div className="session-card" key={session.sessionId}>
                      <div className="session-card-title-row">
                        {renamingId === session.sessionId ? (
                          <input
                            className="session-card-title-input"
                            value={renameValue}
                            autoFocus
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => commitRename(session)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(session)
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                          />
                        ) : (
                          <span className="session-card-title">
                            {session.displayName}
                          </span>
                        )}
                        <span
                          className={`status-badge status-${session.status}`}
                        >
                          {session.status}
                        </span>
                      </div>
                      <div className="session-card-meta">
                        {new Date(session.createdAt).toLocaleString()}
                      </div>
                      <div className="session-card-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => onOpenSession(session.sessionId)}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => startRename(session)}
                          disabled={!session.claudeSessionId}
                          title={
                            session.claudeSessionId
                              ? undefined
                              : 'Rename becomes available after the first turn'
                          }
                        >
                          Rename
                        </button>
                        {session.status !== 'closed' && (
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() =>
                              window.api.killSession(session.sessionId)
                            }
                          >
                            Kill
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
