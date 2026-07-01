import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'ipc-preload.cjs'),
    },
  })

  win.loadFile(path.join(__dirname, 'ipc-index.html'))
  win.webContents.openDevTools()
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message)
  })

  ipcMain.on('start', (event) => {
    let count = 0
    const interval = setInterval(() => {
      count++
      event.sender.send('chunk', `chunk ${count}`)
      if (count >= 3) {
        clearInterval(interval)
      }
    }, 1000)
  })
})
