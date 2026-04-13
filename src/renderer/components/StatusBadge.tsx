import type { ProcessingState } from '../../shared/types'

export function StatusBadge(props: { label: string; state: ProcessingState }) {
  const tone =
    props.state === 'failed'
      ? 'bad'
      : props.state === 'completed'
        ? 'ok'
        : props.state === 'recording'
          ? 'rec'
          : 'neutral'
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" />
      {props.label}
    </span>
  )
}
