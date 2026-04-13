import { useState } from 'react'
import type { AppSettings, RecordingMode, TranscriptionBackend } from '../../shared/types'

export function SettingsModal(props: {
  settings: AppSettings
  onClose: () => void
  onSave: (patch: Partial<AppSettings>) => Promise<void>
}) {
  const { settings, onClose, onSave } = props
  const [form, setForm] = useState<AppSettings>(settings)
  const [saving, setSaving] = useState(false)

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  return (
    <div className="modal-overlay no-drag" onMouseDown={onClose}>
      <div className="modal nw-settings-window settings-scroll" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nw-settings-titlebar">
          <h1 className="nw-settings-heading">GlassCall Notes — Settings</h1>
          <div className="nw-settings-titlebar-actions">
            <button type="button" className="nw-settings-btn cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="nw-settings-btn save"
              disabled={saving}
              onClick={() => {
                setSaving(true)
                void onSave(form).finally(() => {
                  setSaving(false)
                  onClose()
                })
              }}
            >
              Save
            </button>
          </div>
        </div>

        <div className="modal-body nw-settings-body">
          <div className="nw-settings-section-title">Notion</div>
          <div className="nw-settings-group">
            <label className="field">
              <span>Integration token</span>
              <input
                type="password"
                autoComplete="off"
                value={form.notionToken}
                onChange={(e) => update('notionToken', e.target.value)}
                placeholder="secret_… or ntn_…"
              />
            </label>
            <label className="field">
              <span>Parent page ID</span>
              <input
                value={form.notionDatabaseId}
                onChange={(e) => update('notionDatabaseId', e.target.value)}
                placeholder="Page ID where notes are created"
              />
            </label>
            <p className="nw-settings-hint">
              Each recording creates a new sub-page under this Notion page. Share the page with your integration first.
            </p>
          </div>

          <div className="nw-settings-section-title">Recording</div>
          <div className="nw-settings-group">
            <p className="nw-settings-hint">
              Audio is captured from both system output (call audio) and microphone simultaneously.
              Requires Screen Recording and Microphone permissions.
            </p>
          </div>

          <div className="nw-settings-section-title">Transcription</div>
          <div className="nw-settings-group">
            <label className="field">
              <span>Backend</span>
              <select
                value={form.transcriptionBackend}
                onChange={(e) => update('transcriptionBackend', e.target.value as TranscriptionBackend)}
              >
                <option value="whisperx">WhisperX (ASR + align + optional diarization)</option>
                <option value="faster_whisper">faster-whisper only (no WhisperX)</option>
                <option value="vibevocal_asr">vibevocal-asr (not implemented)</option>
              </select>
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={form.diarizationEnabled}
                onChange={(e) => update('diarizationEnabled', e.target.checked)}
              />
              <span>Enable speaker diarization (pyannote via Hugging Face token)</span>
            </label>
            <label className="field">
              <span>Hugging Face token</span>
              <input
                type="password"
                autoComplete="off"
                value={form.huggingFaceToken}
                onChange={(e) => update('huggingFaceToken', e.target.value)}
                placeholder="hf_… (accept model licenses on huggingface.co)"
              />
            </label>
            <label className="field">
              <span>WhisperX ASR model</span>
              <input
                value={form.whisperxModel}
                onChange={(e) => update('whisperxModel', e.target.value)}
                placeholder="large-v2, large-v3, …"
              />
            </label>
            <label className="field">
              <span>WhisperX batch size</span>
              <input
                type="number"
                min={2}
                max={16}
                value={form.whisperxBatchSize}
                onChange={(e) => update('whisperxBatchSize', Number(e.target.value) || 8)}
              />
            </label>
            <label className="field">
              <span>faster-whisper model</span>
              <select value={form.whisperModelSize} onChange={(e) => update('whisperModelSize', e.target.value)}>
                {['tiny', 'base', 'small', 'medium', 'large-v3'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Transcript language</span>
              <input
                value={form.transcriptLanguage}
                onChange={(e) => update('transcriptLanguage', e.target.value)}
                placeholder="en or auto"
              />
            </label>
          </div>

          <div className="nw-settings-section-title">Summarization</div>
          <div className="nw-settings-group">
            <label className="field">
              <span>LM Studio base URL</span>
              <input
                value={form.lmStudioBaseUrl}
                onChange={(e) => update('lmStudioBaseUrl', e.target.value)}
                placeholder="http://localhost:1234/v1"
              />
            </label>
            <label className="field">
              <span>LM Studio model name</span>
              <input
                value={form.lmStudioModel}
                onChange={(e) => update('lmStudioModel', e.target.value)}
                placeholder="As shown in LM Studio"
              />
            </label>
            <label className="field">
              <span>Output folder (optional)</span>
              <input
                value={form.outputFolder}
                onChange={(e) => update('outputFolder', e.target.value)}
                placeholder="Defaults to app data / recordings"
              />
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={form.autoOpenNotion}
                onChange={(e) => update('autoOpenNotion', e.target.checked)}
              />
              <span>Auto-open Notion after success</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
