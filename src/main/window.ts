import { app, BrowserWindow } from 'electron'
import path from 'node:path'

export function createWindow() {
  const appRoot = app.getAppPath()

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(appRoot, 'dist/main/preload.cjs'),
    },
  })

  win.loadFile(path.join(appRoot, 'src/renderer/index.html'))

  return win
}
