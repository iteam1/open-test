import { useCallback, useEffect, useRef, useState } from 'react'
import { toDisplayMessage, type ChatMessage } from './chatDisplay'

type Props = {
  sessionId: string
  onBack: () => void
}

export function SessionView({ sessionId, onBack }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<'idle' | 'running' | 'closed'>('idle')
  const [input, setInput] = useState('')
  const [rejectedNotice, setRejectedNotice] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // Tracks whether the initial getChatLog() hydration has resolved yet, and
  // buffers any live chunk that arrives before it does. Without this, a
  // chunk delivered between the snapshot being taken in the main process
  // and the invoke's response landing here gets wiped out by hydration's
  // setMessages(hydrated) replacing state wholesale (advisor-found bug) —
  // it's still safe in session.ts's chatLog, but invisible until the next
  // remount. Buffering it and appending it once hydration resolves fixes
  // that without needing message-identity dedup.
  const hydratedRef = useRef(false)
  const pendingDuringHydrationRef = useRef<ChatMessage[]>([])

  // 3.3: hydrate from the main process's chat log on every mount, so
  // navigating away mid-stream and back doesn't lose anything — the log
  // itself lives in session.ts, independent of this component's lifecycle.
  useEffect(() => {
    hydratedRef.current = false
    pendingDuringHydrationRef.current = []
    let cancelled = false

    window.api.getChatLog(sessionId).then((log) => {
      if (cancelled) return
      const hydrated = log
        .map((m, i) => toDisplayMessage(m, `h-${i}`))
        .filter((m): m is ChatMessage => m !== null)
      setMessages([...hydrated, ...pendingDuringHydrationRef.current])
      hydratedRef.current = true
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
      if (!display) return
      if (hydratedRef.current) {
        setMessages((prev) => [...prev, display])
      } else {
        pendingDuringHydrationRef.current.push(display)
      }
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

  // A double-send (e.g. pressing Enter twice before the UI catches up)
  // gets rejected server-side, not silently merged — surface it briefly
  // rather than leaving no feedback at all.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.api.onPushRejected((id) => {
      if (id !== sessionId) return
      setRejectedNotice(true)
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => setRejectedNotice(false), 2000)
    })
    return () => {
      clearTimeout(timeoutId)
      unsubscribe()
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

      {rejectedNotice && (
        <div className="chat-rejected-notice">
          Still processing the previous message — try again in a moment.
        </div>
      )}

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
