import { ipcMain, BrowserWindow } from 'electron'
import { runTurnInFolder } from '../io/claudeRunner'
import {
  startTurn,
  endTurn,
  getStatus,
  killSession,
  reopenSession,
  closeIfIdle,
} from '../core/session/session'

// 10 minutes. Short enough to actually observe in a manual test run without
// waiting all day, long enough not to close a session mid-thought in normal use.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 30 * 1000

export function registerIpc(
  sessionId: string,
  sessionDir: string,
  win: BrowserWindow,
) {
  ipcMain.on('send-message', async (event, prompt: string) => {
    if (getStatus(sessionId) === 'closed') {
      reopenSession(sessionId) // 2.7: closed -> idle; runTurn resumes via the stored claudeSessionId
    }

    const turnNumber = startTurn(sessionId)

    if (turnNumber === false) {
      event.sender.send('status', sessionId, 'rejected')
      return
    }

    event.sender.send('status', sessionId, 'running')

    try {
      await runTurnInFolder(
        sessionDir,
        turnNumber,
        prompt,
        (message) => {
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
  })

  ipcMain.on('kill-session', async (event) => {
    await killSession(sessionId)
    event.sender.send('status', sessionId, 'closed')
  })

  const idleCheck = setInterval(() => {
    if (closeIfIdle(sessionId, IDLE_TIMEOUT_MS, Date.now())) {
      win.webContents.send('status', sessionId, 'closed')
    }
  }, IDLE_CHECK_INTERVAL_MS)

  win.on('closed', () => clearInterval(idleCheck))
}
