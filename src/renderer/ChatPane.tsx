import { useCallback, useEffect, useRef, useState } from 'react'
import { toDisplayMessage, type ChatMessage } from './chatDisplay'

type Props = {
  sessionId: string
  status: 'idle' | 'running' | 'closed'
}

/** Left pane of SessionView (design.md) — chat only. Status/kill live in SessionView's header, since they're chrome shared with ArtifactView, not chat-specific. */
export function ChatPane({ sessionId, status }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
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
    return window.api.onChunk((id, message) => {
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
        // Optimistically show the user's own message right away. The SDK
        // stream only yields the assistant's reply, never echoes the input
        // back — and ipc.ts only appends the user message to the main-
        // process chat log (for re-hydration on remount). So without this,
        // your own message stays invisible live until you navigate away and
        // back. On a later remount, state resets and hydration re-reads it
        // from the log, so this optimistic copy doesn't double up.
        setMessages((prev) => [
          ...prev,
          {
            role: 'user',
            text: prompt,
            key: `u-${Date.now()}-${Math.random()}`,
          },
        ])
        window.api.sendMessage(sessionId, prompt)
        setInput('')
      },
      [input, sessionId],
    )

  return (
    <div className="chat-pane">
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
