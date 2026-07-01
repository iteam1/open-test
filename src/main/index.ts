import { app } from 'electron'
import path from 'node:path'
import { createWindow } from './window'
import { registerIpc } from './ipc'

app.whenReady().then(() => {
  const appRoot = app.getAppPath()
  const sessionsRootDir = path.join(appRoot, 'sessions')
  const templateDir = path.join(appRoot, 'assets/session-template')

  // Phase 5 config flag: attach the in-process fragment tools unless
  // OPEN_TEST_FRAGMENTS is explicitly "off". The library lives in the
  // app-root fragments/ dir (design.md: gitignored, one shared library for
  // the whole app). Off → the app is the fully-working live-only baseline.
  const fragmentsRootDir =
    process.env.OPEN_TEST_FRAGMENTS === 'off'
      ? null
      : path.join(appRoot, 'fragments')

  const win = createWindow()
  registerIpc(sessionsRootDir, templateDir, win, fragmentsRootDir)
})

app.on('window-all-closed', () => {
  app.quit()
})
