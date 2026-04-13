import type { ProcessingState, RecordingRow } from '../../shared/types'
import { RecordingList } from './RecordingList'
import { StatusBadge } from './StatusBadge'

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

const stateLabels: Record<ProcessingState, string> = {
  idle: 'Ready',
  recording: 'Recording',
  finalizing_audio: 'Saving audio',
  transcribing: 'Transcribing',
  diarizing: 'Speaker diarization',
  summarizing: 'Summarizing',
  creating_notion_page: 'Creating Notion page',
  completed: 'Done',
  failed: 'Failed'
}

function IconCalendarClock(props: { className?: string }) {
  /* Heroicons mini calendar-days — matches Notion Widget header SF Symbol feel */
  return (
    <svg
      className={props.className}
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M5.25 12a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H6a.75.75 0 0 1-.75-.75V12ZM5.25 9a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H6a.75.75 0 0 1-.75-.75V9ZM5.25 6a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H6a.75.75 0 0 1-.75-.75V6ZM8.25 12a.75.75 0 0 1 .75-.75h2.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75V12ZM8.25 9a.75.75 0 0 1 .75-.75h2.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75V9ZM8.25 6a.75.75 0 0 1 .75-.75h2.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75V6ZM12.25 12a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H13a.75.75 0 0 1-.75-.75V12ZM12.25 9a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H13a.75.75 0 0 1-.75-.75V9ZM12.25 6a.75.75 0 0 1 .75-.75h.01a.75.75 0 0 1 .75.75v.01a.75.75 0 0 1-.75.75H13a.75.75 0 0 1-.75-.75V6Z" />
      <path
        fillRule="evenodd"
        d="M6.75 2.75A.75.75 0 0 1 7.5 2h5a.75.75 0 0 1 .75.75v.75h.75A2.25 2.25 0 0 1 16 5.25v9.5A2.25 2.25 0 0 1 13.75 17H6.25A2.25 2.25 0 0 1 4 14.75v-9.5A2.25 2.25 0 0 1 6.25 3h.75v-.75ZM7.5 3.75v-.75h5v.75H7.5Zm5.75 1.5H6.25a.75.75 0 0 0-.75.75v9.5c0 .414.336.75.75.75h7.5a.75.75 0 0 0 .75-.75v-9.5a.75.75 0 0 0-.75-.75Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function IconGear(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.403c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.403.294a1 1 0 0 1 .804.98v1.361a1 1 0 0 1-.804.98l-1.403.295a6.494 6.494 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.086 6.086 0 0 1-1.416.587l-.294 1.403a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.403a6.494 6.494 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.086 6.086 0 0 1-.587-1.416l-1.403-.294A1 1 0 0 1 1 10.68V9.32a1 1 0 0 1 .804-.98l1.403-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962a1 1 0 0 1 1.262-.125l1.25.834c.445-.245.919-.443 1.416-.587l.294-1.403ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

export function MainWidget(props: {
  recordings: RecordingRow[]
  uiState: ProcessingState
  busy: boolean
  timerMs: number
  statusMessage?: string
  lastNotionUrl?: string
  onStart: () => void
  onStop: () => void
  onCancel: () => void
  onOpenSettings: () => void
  onOpenNotion: (url: string) => void
  onRetry: (id: string) => void
}) {
  const {
    recordings,
    uiState,
    busy,
    timerMs,
    statusMessage,
    lastNotionUrl,
    onStart,
    onStop,
    onCancel,
    onOpenSettings,
    onOpenNotion,
    onRetry
  } = props

  const recording = uiState === 'recording'
  const canStart = !busy && uiState !== 'recording'
  const canStop = recording

  return (
    <div className="nw-floating-panel">
      <header className="nw-header drag">
        <div className="nw-header-icon-title">
          <IconCalendarClock className="nw-header-icon" />
          <div className="nw-header-titles">
            <div className="nw-header-title">GlassCall Notes</div>
            <div className="nw-header-sub">
              <StatusBadge label={stateLabels[uiState]} state={uiState} />
            </div>
          </div>
        </div>
        <div className="nw-header-actions no-drag">
          <button type="button" className="nw-icon-btn" title="Settings" onClick={onOpenSettings}>
            <IconGear />
          </button>
        </div>
      </header>

      <div className="nw-divider" role="separator" />

      <div className="nw-body no-drag">
        <section className="nw-section">
          <div className="timer-row">
            <div className="timer-label">{recording ? 'Live' : 'Timer'}</div>
            <div className="timer-value">{recording ? formatDuration(timerMs) : '—'}</div>
          </div>

          <div className="controls">
            <button
              type="button"
              className="primary"
              disabled={!canStart}
              onClick={() => {
                void onStart()
              }}
            >
              Start Recording
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!canStop}
              onClick={() => {
                void onStop()
              }}
            >
              Stop & Process
            </button>
          </div>

          {recording ? (
            <button type="button" className="ghost danger" onClick={() => void onCancel()}>
              Cancel
            </button>
          ) : null}

          {busy ? <div className="progress-hint">{stateLabels[uiState]}…</div> : null}

          {statusMessage ? <div className="error-banner">{statusMessage}</div> : null}

          {uiState === 'completed' && lastNotionUrl ? (
            <div className="success-row">
              <button type="button" className="primary subtle" onClick={() => onOpenNotion(lastNotionUrl)}>
                Open in Notion
              </button>
            </div>
          ) : null}

          {uiState === 'failed' ? (
            <div className="hint">
              Check Screen Recording permission (System Settings → Privacy & Security → Screen Recording) and ensure LM Studio /
              Notion settings are valid.
            </div>
          ) : null}
        </section>

        <RecordingList recordings={recordings} onRetry={onRetry} onOpenNotion={onOpenNotion} />
      </div>
    </div>
  )
}
