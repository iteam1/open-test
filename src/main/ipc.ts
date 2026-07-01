import { ipcMain, BrowserWindow } from 'electron'
import path from 'node:path'
import {
  runTurnInFolder,
  createSession,
  listSessions,
  renameSessionTitle,
  hydrateSessionFromDisk,
} from '../io/claudeRunner'
import {
  startTurn,
  endTurn,
  getStatus,
  killSession,
  reopenSession,
  closeIfIdle,
  getChatLog,
  appendToChatLog,
} from '../core/session/session'

// 10 minutes. Short enough to actually observe in a manual test run without
// waiting all day, long enough not to close a session mid-thought in normal use.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 30 * 1000

export function registerIpc(
  sessionsRootDir: string,
  templateDir: string,
  win: BrowserWindow,
) {
  const sessionDirFor = (sessionId: string) =>
    path.join(sessionsRootDir, sessionId)

  ipcMain.handle('create-session', async () => {
    return createSession(templateDir, sessionsRootDir)
  })

  ipcMain.handle('list-sessions', async () => {
    return listSessions(sessionsRootDir)
  })

  ipcMain.handle(
    'rename-session',
    async (_event, claudeSessionId: string, title: string) => {
      if (!claudeSessionId) {
        throw new Error('Cannot rename a session before its first turn')
      }
      await renameSessionTitle(claudeSessionId, title)
    },
  )

  ipcMain.handle('get-chat-log', (_event, sessionId: string) => {
    return getChatLog(sessionId)
  })

  ipcMain.on(
    'send-message',
    async (event, sessionId: string, prompt: string) => {
      // First time this process has ever seen this sessionId (e.g. right
      // after an app restart) — load its real claudeSessionId/turnCount
      // from disk before deciding anything, or the push below would think
      // it's brand new and silently start a fresh conversation, losing all
      // prior context (advisor-found bug).
      if (getStatus(sessionId) === undefined) {
        await hydrateSessionFromDisk(sessionId, sessionDirFor(sessionId))
      }

      if (getStatus(sessionId) === 'closed') {
        reopenSession(sessionId) // 2.7: closed -> idle; runTurn resumes via the stored claudeSessionId
      }

      const turnNumber = startTurn(sessionId)

      if (turnNumber === false) {
        // Deliberately not the 'status' channel — 'rejected' isn't a real
        // session status (advisor-found bug: it isn't part of
        // Session['status'], and reusing 'status' for it made the session's
        // card vanish from every Dashboard column and showed a broken badge
        // in SessionView until the next real status event).
        event.sender.send('push-rejected', sessionId)
        return
      }

      event.sender.send('status', sessionId, 'running')

      // Persist the user's own message in the same chat log as the reply
      // (3.3) — otherwise it'd only exist in the renderer's local state and
      // vanish on remount, even though the reply itself survives.
      appendToChatLog(sessionId, {
        type: 'user',
        message: { role: 'user', content: prompt },
      })

      try {
        await runTurnInFolder(
          sessionDirFor(sessionId),
          turnNumber,
          prompt,
          (message) => {
            appendToChatLog(sessionId, message) // 3.3: so ChatPane can re-hydrate after unmount/remount
            event.sender.send('chunk', sessionId, message)
          },
          sessionId,
        )
      } finally {
        // Runs whether the turn finished normally or the SDK threw (e.g. an
        // interrupt, per 1.4's finding) — status must return to idle either
        // way, or this session would reject every push forever after a crash.
        // Only announce 'idle' if endTurn actually made that transition —
        // if a kill already closed this session while this was unwinding,
        // endTurn no-ops (returns false), and announcing 'idle' anyway would
        // race the kill's own 'closed' event and could show a stale idle
        // badge for a session that's actually closed (advisor-found bug).
        const didEndTurn = endTurn(sessionId, Date.now())
        if (didEndTurn) {
          event.sender.send('status', sessionId, 'idle')
        }
      }
    },
  )

  ipcMain.on('kill-session', async (event, sessionId: string) => {
    await killSession(sessionId)
    event.sender.send('status', sessionId, 'closed')
  })

  const idleCheck = setInterval(async () => {
    try {
      const sessions = await listSessions(sessionsRootDir)
      for (const session of sessions) {
        if (closeIfIdle(session.sessionId, IDLE_TIMEOUT_MS, Date.now())) {
          win.webContents.send('status', session.sessionId, 'closed')
        }
      }
    } catch {
      // Don't let one bad tick (e.g. a transient fs error) kill every
      // future idle-timeout check for every session (advisor-found bug).
    }
  }, IDLE_CHECK_INTERVAL_MS)

  win.on('closed', () => clearInterval(idleCheck))
}
