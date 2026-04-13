/// <reference types="vite/client" />

import type { AppSettings, PipelineProgress, RecordingRow } from '../shared/types'

type GlasscallApi = {
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

declare global {
  interface Window {
    /** Missing if preload failed or the app was opened outside Electron */
    glasscall?: GlasscallApi
  }
}

export {}
