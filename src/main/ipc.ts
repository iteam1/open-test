import { ipcMain, BrowserWindow } from 'electron'
import path from 'node:path'
import {
  runTurnInFolder,
  createSession,
  listSessions,
  renameSessionTitle,
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
      await renameSessionTitle(claudeSessionId, title)
    },
  )

  ipcMain.handle('get-chat-log', (_event, sessionId: string) => {
    return getChatLog(sessionId)
  })

  ipcMain.on(
    'send-message',
    async (event, sessionId: string, prompt: string) => {
      if (getStatus(sessionId) === 'closed') {
        reopenSession(sessionId) // 2.7: closed -> idle; runTurn resumes via the stored claudeSessionId
      }

      const turnNumber = startTurn(sessionId)

      if (turnNumber === false) {
        event.sender.send('status', sessionId, 'rejected')
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
        endTurn(sessionId, Date.now())
        event.sender.send('status', sessionId, 'idle')
      }
    },
  )

  ipcMain.on('kill-session', async (event, sessionId: string) => {
    await killSession(sessionId)
    event.sender.send('status', sessionId, 'closed')
  })

  const idleCheck = setInterval(async () => {
    const sessions = await listSessions(sessionsRootDir)
    for (const session of sessions) {
      if (closeIfIdle(session.sessionId, IDLE_TIMEOUT_MS, Date.now())) {
        win.webContents.send('status', session.sessionId, 'closed')
      }
    }
  }, IDLE_CHECK_INTERVAL_MS)

  win.on('closed', () => clearInterval(idleCheck))
}
