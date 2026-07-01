import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  sendMessage: (prompt: string) => {
    ipcRenderer.send('send-message', prompt)
  },
  killSession: () => {
    ipcRenderer.send('kill-session')
  },
  onChunk: (callback: (sessionId: string, message: unknown) => void) => {
    ipcRenderer.on('chunk', (_event, sessionId, message) => {
      callback(sessionId, message)
    })
  },
  onStatus: (callback: (sessionId: string, status: string) => void) => {
    ipcRenderer.on('status', (_event, sessionId, status) => {
      callback(sessionId, status)
    })
  },
})
