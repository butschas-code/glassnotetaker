import type { RecordingRow } from '../../shared/types'

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function RecordingList(props: {
  recordings: RecordingRow[]
  onRetry: (id: string) => void
  onOpenNotion: (url: string) => void
}) {
  const { recordings, onRetry, onOpenNotion } = props
  if (!recordings.length) {
    return (
      <section className="list-section">
        <div className="list-title-row">
          <span className="rec-col-time">Time</span>
          <span className="rec-col-state">State</span>
          <span className="rec-col-actions-h">Actions</span>
        </div>
        <div className="list-divider" />
        <div className="list-empty">No notes yet</div>
      </section>
    )
  }

  return (
    <section className="list-section">
      <div className="list-title-row">
        <span className="rec-col-time">Time</span>
        <span className="rec-col-state">State</span>
        <span className="rec-col-actions-h">Actions</span>
      </div>
      <div className="list-divider" />
      <ul className="rec-list">
        {recordings.map((r, i) => (
          <li key={r.id} className="rec-item-wrap">
            <div className="rec-item">
              <div className="rec-col-time">{formatTime(r.created_at)}</div>
              <div className="rec-col-state">{r.processing_state}</div>
              <div className="rec-col-actions">
                {r.notion_page_url ? (
                  <button type="button" className="mini" onClick={() => onOpenNotion(r.notion_page_url!)}>
                    Notion
                  </button>
                ) : null}
                {r.status === 'failed' ? (
                  <button type="button" className="mini" onClick={() => void onRetry(r.id)}>
                    Retry
                  </button>
                ) : null}
              </div>
            </div>
            {i < recordings.length - 1 ? <div className="rec-row-divider" /> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
