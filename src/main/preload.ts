import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  sendMessage: (prompt: string) => {
    ipcRenderer.send('send-message', prompt)
  },
  onChunk: (callback: (sessionId: string, message: unknown) => void) => {
    ipcRenderer.on('chunk', (_event, sessionId, message) => {
      callback(sessionId, message)
    })
  },
})
