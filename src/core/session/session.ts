type ActiveTurn = {
  interrupt: () => Promise<void>
}

type Session = {
  status: 'idle' | 'running' | 'closed'
  turnCount: number
  lastActiveAt: number
  claudeSessionId: string | null
  activeTurn: ActiveTurn | null
  chatLog: unknown[]
}

/** In-memory status per session, keyed by sessionId. Not persisted. */
const sessions = new Map<string, Session>()

function getOrCreate(sessionId: string): Session {
  let session = sessions.get(sessionId)
  if (!session) {
    session = {
      status: 'idle',
      turnCount: 0,
      lastActiveAt: 0,
      claudeSessionId: null,
      activeTurn: null,
      chatLog: [],
    }
    sessions.set(sessionId, session)
  }
  return session
}

/** Current status for a session, or undefined if it's never been pushed to. */
export function getStatus(sessionId: string): Session['status'] | undefined {
  return sessions.get(sessionId)?.status
}

/** The real claudeSessionId once known (set by the first message of the first turn), or null before that. */
export function getClaudeSessionId(sessionId: string): string | null {
  return sessions.get(sessionId)?.claudeSessionId ?? null
}

/** Call this as soon as a message carrying a session_id arrives, so it's available for resume/usage-tracking. */
export function setClaudeSessionId(
  sessionId: string,
  claudeSessionId: string,
): void {
  getOrCreate(sessionId).claudeSessionId = claudeSessionId
}

/** Call this once the live query object exists, so killSession has something to interrupt. */
export function setActiveTurn(
  sessionId: string,
  activeTurn: ActiveTurn | null,
): void {
  const session = sessions.get(sessionId)
  if (session) session.activeTurn = activeTurn
}

/**
 * Call this before sending a push into a session's stream. Returns false
 * (and does nothing else) if that session is already running or closed —
 * closed sessions must go through reopenSession first, not push directly.
 * Running is the fix for 1.5's finding: without this check, a second push
 * mid-turn silently merges into the first instead of landing as its own turn.
 *
 * Otherwise flips status to 'running' and returns this turn's number
 * (count of pushes so far, including this one, preserved across a
 * close/reopen) — the caller needs this to name output/turn-<n>/ before
 * the message goes in.
 */
export function startTurn(sessionId: string): number | false {
  const session = getOrCreate(sessionId)
  if (session.status === 'running' || session.status === 'closed') return false
  session.status = 'running'
  session.turnCount += 1
  return session.turnCount
}

/**
 * Call this once a turn's reply is fully received (or the turn failed), to
 * flip status back to idle. Returns false and does nothing if status is
 * already 'closed' — a kill can land while this turn's own cleanup is
 * still unwinding (the SDK throwing per 1.4's finding takes a moment to
 * propagate), and that explicit close must not get silently reverted back
 * to idle by this call arriving after it. The caller uses the return value
 * to decide whether to actually announce 'idle' (advisor-found: emitting
 * 'idle' unconditionally here raced an 'closed' emitted by the kill, and
 * whichever one landed last in the renderer won).
 */
export function endTurn(sessionId: string, now: number): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.status === 'closed') return false
  session.status = 'idle'
  session.lastActiveAt = now
  session.activeTurn = null
  return true
}

/**
 * Closes a session that's been idle for at least idleTimeoutMs. Does
 * nothing (returns false) if the session is running — a turn in progress
 * always blocks the close, regardless of how long it's taken.
 */
export function closeIfIdle(
  sessionId: string,
  idleTimeoutMs: number,
  now: number,
): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.status !== 'idle') return false
  if (now - session.lastActiveAt < idleTimeoutMs) return false
  session.status = 'closed'
  return true
}

/**
 * Explicit kill: if a turn is running, interrupts it first. Per 1.4's
 * finding, that interrupt() call throws instead of returning cleanly (it
 * takes the subprocess down with it) — caught here so the kill flow itself
 * never propagates that error. Always ends with status 'closed', whether or
 * not anything was running.
 */
export async function killSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (session?.status === 'running' && session.activeTurn) {
    try {
      await session.activeTurn.interrupt()
    } catch {
      // expected per 1.4 — the subprocess dying IS how interrupt() stops the reply
    }
  }
  if (session) {
    session.status = 'closed'
    session.activeTurn = null
  }
}

/**
 * Brings a closed session back to idle so it can accept a push again. Does
 * NOT touch turnCount or claudeSessionId — a resumed session continues its
 * existing turn numbering and reconnects via the same claudeSessionId (2.7).
 */
export function reopenSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session) session.status = 'idle'
}

/**
 * Full ordered log of every streamed message for a session (3.3) — lets a
 * screen that (re)mounts hydrate what already happened instead of only
 * seeing chunks forwarded live from here on. ChatPane.tsx calls this on
 * mount; ipc.ts calls appendToChatLog every time it forwards a chunk.
 */
export function getChatLog(sessionId: string): unknown[] {
  return sessions.get(sessionId)?.chatLog ?? []
}

export function appendToChatLog(sessionId: string, message: unknown): void {
  getOrCreate(sessionId).chatLog.push(message)
}

/**
 * Loads a session's persisted state into memory as 'closed' — this
 * process's in-memory Map starts empty on every launch, but metadata.json
 * (claudeSessionId) and output/turn-<n>/ (turnCount) persist across
 * restarts. Without this, a session touched in a previous run reads as
 * "never seen" after a restart: getStatus() returns undefined (not
 * 'closed'), so ipc.ts's reopenSession check never fires, startTurn treats
 * it as brand new, and the next push silently starts a fresh
 * claudeSessionId (losing all prior context) while colliding turn-1's
 * output with what's already on disk (advisor-found bug). No-ops if this
 * sessionId is already known in memory, so it never clobbers live state.
 */
export function hydrateSession(
  sessionId: string,
  claudeSessionId: string | null,
  turnCount: number,
): void {
  if (sessions.has(sessionId)) return
  sessions.set(sessionId, {
    status: 'closed',
    turnCount,
    lastActiveAt: 0,
    claudeSessionId,
    activeTurn: null,
    chatLog: [],
  })
}
