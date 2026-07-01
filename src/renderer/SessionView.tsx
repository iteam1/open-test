import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatPane } from './ChatPane'
import { ArtifactView } from './ArtifactView'

type Props = {
  sessionId: string
  onBack: () => void
}

// Chat pane's share of the split, in percent. Default 58 ≈ the old fixed
// 1.4:1 flex ratio. Clamped so neither pane can be dragged away entirely.
const DEFAULT_CHAT_PCT = 58
const MIN_PCT = 20
const MAX_PCT = 80

/** Screen 2 (design.md): owns the shared header (back/title/status/kill), renders ChatPane (left) + ArtifactView (right) with a draggable gutter between them. */
export function SessionView({ sessionId, onBack }: Props) {
  const [status, setStatus] = useState<'idle' | 'running' | 'closed'>('idle')
  const [chatPct, setChatPct] = useState(DEFAULT_CHAT_PCT)
  const bodyRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    return window.api.onStatus((id, newStatus) => {
      if (id === sessionId) setStatus(newStatus)
    })
  }, [sessionId])

  const onGutterDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  // Window-level listeners so the drag keeps tracking even when the pointer
  // moves off the thin gutter (onto either pane) mid-drag.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!draggingRef.current || !bodyRef.current) return
      const rect = bodyRef.current.getBoundingClientRect()
      const pct = ((event.clientX - rect.left) / rect.width) * 100
      setChatPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)))
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

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

      <div className="session-view-body" ref={bodyRef}>
        <div className="pane-left" style={{ flexBasis: `${chatPct}%` }}>
          <ChatPane sessionId={sessionId} status={status} />
        </div>
        <div
          className="gutter"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onGutterDown}
        />
        <div className="pane-right">
          <ArtifactView sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
}
