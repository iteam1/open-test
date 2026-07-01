import { app } from 'electron'
import { createWindow } from './window'

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
