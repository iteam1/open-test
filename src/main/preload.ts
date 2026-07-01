import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  createSession: () => ipcRenderer.invoke('create-session'),
  listSessions: () => ipcRenderer.invoke('list-sessions'),
  renameSession: (claudeSessionId: string, title: string) =>
    ipcRenderer.invoke('rename-session', claudeSessionId, title),
  getChatLog: (sessionId: string) =>
    ipcRenderer.invoke('get-chat-log', sessionId),
  sendMessage: (sessionId: string, prompt: string) => {
    ipcRenderer.send('send-message', sessionId, prompt)
  },
  killSession: (sessionId: string) => {
    ipcRenderer.send('kill-session', sessionId)
  },
  // Both return an unsubscribe function — React components call this from
  // their useEffect cleanup, so mounting/unmounting a screen repeatedly
  // (Dashboard <-> SessionView, per 3.3) doesn't stack duplicate listeners.
  onChunk: (callback: (sessionId: string, message: unknown) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      sessionId: string,
      message: unknown,
    ) => callback(sessionId, message)
    ipcRenderer.on('chunk', listener)
    return () => ipcRenderer.removeListener('chunk', listener)
  },
  onStatus: (
    callback: (
      sessionId: string,
      status: 'idle' | 'running' | 'closed',
    ) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      sessionId: string,
      status: 'idle' | 'running' | 'closed',
    ) => callback(sessionId, status)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
  // Separate from onStatus — a rejected push isn't a session status
  // (advisor-found bug: reusing 'status' for it broke Dashboard/SessionView
  // rendering, since 'rejected' isn't part of Session['status']).
  onPushRejected: (callback: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) =>
      callback(sessionId)
    ipcRenderer.on('push-rejected', listener)
    return () => ipcRenderer.removeListener('push-rejected', listener)
  },
})
