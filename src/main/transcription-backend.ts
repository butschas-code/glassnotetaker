/**
 * Pluggable transcription backends (worker implemented in Python `transcribe.py`).
 * Node only dispatches CLI args; add new backends in Python and extend `TranscriptionBackend` in shared/types.
 */
export const TRANSCRIPTION_BACKENDS = ['whisperx', 'faster_whisper', 'vibevocal_asr'] as const

export function isImplementedBackend(id: string): boolean {
  return id === 'whisperx' || id === 'faster_whisper'
}
