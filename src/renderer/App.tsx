import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, PipelineProgress, ProcessingState, RecordingRow } from '../shared/types'
import { MainWidget } from './components/MainWidget'
import { SettingsModal } from './components/SettingsModal'

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [recordings, setRecordings] = useState<RecordingRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [uiState, setUiState] = useState<ProcessingState>('idle')
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null)
  const [lastNotionUrl, setLastNotionUrl] = useState<string | undefined>(undefined)
  const [timerMs, setTimerMs] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const api = window.glasscall
      if (!api) {
        setLoadError(
          'The app bridge is unavailable (preload did not load). Quit and run the packaged app, or use npm run dev from the project folder.'
        )
        return
      }
      const data = await api.load()
      setLoadError(null)
      setSettings(data.settings)
      setRecordings(data.recordings)
    } catch (e) {
      setLoadError((e as Error).message || String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const api = window.glasscall
    if (!api) return
    return api.onProgress((p: PipelineProgress) => {
      setUiState(p.state)
      setStatusMessage(p.message)
      setActiveRecordingId(p.recordingId)
      if (p.notionPageUrl) setLastNotionUrl(p.notionPageUrl)
      if (p.state === 'completed' || p.state === 'failed') {
        void refresh()
      }
    })
  }, [refresh])

  useEffect(() => {
    if (uiState !== 'recording') return
    const t0 = Date.now()
    setTimerMs(0)
    const id = window.setInterval(() => setTimerMs(Date.now() - t0), 250)
    return () => window.clearInterval(id)
  }, [uiState])

  const busy = useMemo(
    () =>
      [
        'finalizing_audio',
        'transcribing',
        'diarizing',
        'summarizing',
        'creating_notion_page'
      ].includes(uiState),
    [uiState]
  )

  const onStart = async () => {
    if (!window.glasscall) return
    setLastNotionUrl(undefined)
    setStatusMessage(undefined)
    try {
      const res = await window.glasscall.startRecording()
      setActiveRecordingId(res.recordingId)
      setUiState('recording')
    } catch (e) {
      setStatusMessage((e as Error).message)
      setUiState('idle')
      await refresh()
    }
  }

  const onStop = async () => {
    if (!window.glasscall) return
    try {
      const data = await window.glasscall.stopRecording()
      setSettings(data.settings)
      setRecordings(data.recordings)
    } catch (e) {
      setStatusMessage((e as Error).message)
      await refresh()
    }
  }

  const onCancel = async () => {
    if (!window.glasscall) return
    const data = await window.glasscall.cancelRecording()
    setSettings(data.settings)
    setRecordings(data.recordings)
    setUiState('idle')
  }

  const onSaveSettings = async (patch: Partial<AppSettings>) => {
    if (!window.glasscall) return
    const next = await window.glasscall.saveSettings(patch)
    setSettings(next)
  }

  const onRetry = async (id: string) => {
    if (!window.glasscall) return
    setStatusMessage(undefined)
    try {
      const data = await window.glasscall.retryRecording(id)
      setSettings(data.settings)
      setRecordings(data.recordings)
    } catch (e) {
      setStatusMessage((e as Error).message)
    }
  }

  if (loadError) {
    return (
      <div className="app-shell">
        <div className="nw-floating-panel">
          <div className="nw-placeholder">
            <p className="nw-placeholder-title">Could not start</p>
            <p className="nw-placeholder-body">{loadError}</p>
          </div>
        </div>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="app-shell">
        <div className="nw-floating-panel">
          <div className="nw-placeholder" style={{ paddingTop: 48 }}>
            <p className="nw-placeholder-body">Loading…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <MainWidget
        recordings={recordings}
        uiState={uiState}
        busy={busy}
        timerMs={timerMs}
        statusMessage={statusMessage}
        lastNotionUrl={lastNotionUrl}
        onStart={onStart}
        onStop={onStop}
        onCancel={onCancel}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenNotion={(url) => void window.glasscall.openExternal(url)}
        onRetry={onRetry}
      />
      {settingsOpen ? (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={onSaveSettings}
        />
      ) : null}
    </div>
  )
}
