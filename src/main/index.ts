import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { createWindow } from './window'
import { registerIpc } from './ipc'
import { createSessionFolder } from '../io/claudeRunner'

app.whenReady().then(async () => {
  const sessionId = 'dev-session'
  const sessionDir = path.join(os.tmpdir(), 'open-test-dev-session')
  const templateDir = path.join(__dirname, '../../assets/session-template')

  await createSessionFolder(sessionId, templateDir, sessionDir)
  registerIpc(sessionId, sessionDir)

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
