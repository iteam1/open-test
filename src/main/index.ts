import { app } from 'electron'
import path from 'node:path'
import { createWindow } from './window'
import { registerIpc } from './ipc'

app.whenReady().then(() => {
  const appRoot = app.getAppPath()
  const sessionsRootDir = path.join(appRoot, 'sessions')
  const templateDir = path.join(appRoot, 'assets/session-template')

  const win = createWindow()
  registerIpc(sessionsRootDir, templateDir, win)
})

app.on('window-all-closed', () => {
  app.quit()
})
