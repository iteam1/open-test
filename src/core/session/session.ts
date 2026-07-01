type ActiveTurn = {
  interrupt: () => Promise<void>
}

type Session = {
  status: 'idle' | 'running' | 'closed'
  turnCount: number
  lastActiveAt: number
  claudeSessionId: string | null
  activeTurn: ActiveTurn | null
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
 * flip status back to idle. No-ops if status is already 'closed' — a
 * kill can land while this turn's own cleanup is still unwinding (the SDK
 * throwing per 1.4's finding takes a moment to propagate), and that
 * explicit close must not get silently reverted back to idle by this call
 * arriving after it.
 */
export function endTurn(sessionId: string, now: number): void {
  const session = sessions.get(sessionId)
  if (!session || session.status === 'closed') return
  session.status = 'idle'
  session.lastActiveAt = now
  session.activeTurn = null
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
