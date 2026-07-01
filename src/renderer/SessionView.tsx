import { useEffect, useState } from 'react'
import { ChatPane } from './ChatPane'
import { ArtifactView } from './ArtifactView'

type Props = {
  sessionId: string
  onBack: () => void
}

/** Screen 2 (design.md): owns the shared header (back/title/status/kill), renders ChatPane (left) + ArtifactView (right). */
export function SessionView({ sessionId, onBack }: Props) {
  const [status, setStatus] = useState<'idle' | 'running' | 'closed'>('idle')

  useEffect(() => {
    return window.api.onStatus((id, newStatus) => {
      if (id === sessionId) setStatus(newStatus)
    })
  }, [sessionId])

  return (
    <div className="session-view">
      <div className="session-view-header">
        <div className="session-view-header-left">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onBack}
          >
            ← Back
          </button>
          <span className="session-view-title">{sessionId}</span>
          <span className={`status-badge status-${status}`}>{status}</span>
        </div>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => window.api.killSession(sessionId)}
        >
          Kill
        </button>
      </div>

      <div className="session-view-body">
        <ChatPane sessionId={sessionId} status={status} />
        <ArtifactView sessionId={sessionId} />
      </div>
    </div>
  )
}
