import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, PipelineProgress, RecordingRow } from '../shared/types'

export interface AppApi {
  load: () => Promise<{ settings: AppSettings; recordings: RecordingRow[] }>
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  startRecording: () => Promise<{ recordingId: string }>
  stopRecording: () => Promise<{ settings: AppSettings; recordings: RecordingRow[] }>
  cancelRecording: () => Promise<{ settings: AppSettings; recordings: RecordingRow[] }>
  retryRecording: (recordingId: string) => Promise<{ settings: AppSettings; recordings: RecordingRow[] }>
  openExternal: (url: string) => Promise<void>
  revealInFinder: (filePath: string) => Promise<void>
  onProgress: (cb: (p: PipelineProgress) => void) => () => void
}

const api: AppApi = {
  load: () => ipcRenderer.invoke('app:load'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  startRecording: () => ipcRenderer.invoke('recording:start'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  retryRecording: (recordingId) => ipcRenderer.invoke('recording:retry', recordingId),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  revealInFinder: (filePath) => ipcRenderer.invoke('path:reveal', filePath),
  onProgress: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, p: PipelineProgress) => cb(p)
    ipcRenderer.on('pipeline:progress', handler)
    return () => ipcRenderer.removeListener('pipeline:progress', handler)
  }
}

contextBridge.exposeInMainWorld('glasscall', api)

declare global {
  interface Window {
    glasscall: AppApi
  }
}
