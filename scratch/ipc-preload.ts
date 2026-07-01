import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  onChunks: (param) => {
    ipcRenderer.on('chunk', (event, data) => {
      param(data)
    })
    ipcRenderer.send('start')
  },
})
