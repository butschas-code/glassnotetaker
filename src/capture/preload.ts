import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('captureApi', {
  onStop: (cb: () => void) => {
    ipcRenderer.on('capture:stop', () => cb())
  },
  sendChunk: (buffer: ArrayBuffer) => {
    ipcRenderer.send('capture:chunk', Buffer.from(buffer))
  },
  sendReady: () => {
    ipcRenderer.send('capture:ready')
  },
  sendDone: (durationSec: number) => {
    ipcRenderer.send('capture:done', durationSec)
  },
  sendError: (message: string) => {
    ipcRenderer.send('capture:error', message)
  },
  sendLog: (message: string) => {
    ipcRenderer.send('capture:log', message)
  }
})
