import { ipcMain } from 'electron'
import { runTurn } from '../io/claudeRunner'

export function registerIpc(sessionId: string, sessionDir: string) {
  ipcMain.on('send-message', (event, prompt: string) => {
    runTurn(sessionDir, prompt, (message) => {
      event.sender.send('chunk', sessionId, message)
    })
  })
}