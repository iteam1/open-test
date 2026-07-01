import { useCallback, useEffect, useRef, useState } from 'react'
import { toDisplayMessage, type ChatMessage } from './chatDisplay'

type Props = {
  sessionId: string
  onBack: () => void
}

export function SessionView({ sessionId, onBack }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState('idle')
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  // 3.3: hydrate from the main process's chat log on every mount, so
  // navigating away mid-stream and back doesn't lose anything — the log
  // itself lives in session.ts, independent of this component's lifecycle.
  useEffect(() => {
    let cancelled = false
    window.api.getChatLog(sessionId).then((log) => {
      if (cancelled) return
      const hydrated = log
        .map((m, i) => toDisplayMessage(m, `h-${i}`))
        .filter((m): m is ChatMessage => m !== null)
      setMessages(hydrated)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    const unsubscribeChunk = window.api.onChunk((id, message) => {
      if (id !== sessionId) return
      const display = toDisplayMessage(
        message,
        `c-${Date.now()}-${Math.random()}`,
      )
      if (display) setMessages((prev) => [...prev, display])
    })
    const unsubscribeStatus = window.api.onStatus((id, newStatus) => {
      if (id !== sessionId) return
      setStatus(newStatus)
    })
    return () => {
      unsubscribeChunk()
      unsubscribeStatus()
    }
  }, [sessionId])

  useEffect(() => {
    logRef.current?.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  const handleSubmit: React.DOMAttributes<HTMLFormElement>['onSubmit'] =
    useCallback(
      (event) => {
        event.preventDefault()
        const prompt = input.trim()
        if (!prompt) return
        window.api.sendMessage(sessionId, prompt)
        setInput('')
      },
      [input, sessionId],
    )

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

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            No messages yet — say something below.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.key} className={`chat-message chat-message-${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>

      <form className="chat-input-bar" onSubmit={handleSubmit}>
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          autoFocus
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={status === 'running' || !input.trim()}
        >
          Send
        </button>
      </form>
    </div>
  )
}
