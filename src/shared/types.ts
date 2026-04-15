export type ProcessingState =
  | 'idle'
  | 'recording'
  | 'finalizing_audio'
  | 'transcribing'
  | 'diarizing'
  | 'summarizing'
  | 'creating_notion_page'
  | 'completed'
  | 'failed'

export type RecordingStatus =
  | 'draft'
  | 'recording'
  | 'processing'
  | 'completed'
  | 'failed'

export type TranscriptionBackend = 'whisperx' | 'faster_whisper' | 'vibevocal_asr'

export type RecordingMode = 'system_only' | 'mic_and_system'

export interface ActionItem {
  task: string
  owner: string
  due: string
}

export interface MeetingSummaryJson {
  title: string
  /** Multi-paragraph narrative; only facts supported by the transcript */
  summary: string
  participants: string[]
  decisions: string[]
  action_items: ActionItem[]
}

export interface AppSettings {
  notionToken: string
  notionDatabaseId: string
  notionTitleProperty: string
  notionDateProperty: string
  notionStatusProperty: string
  notionDurationProperty: string
  lmStudioBaseUrl: string
  lmStudioModel: string
  /** faster-whisper model id when using faster_whisper backend or Python fallback */
  whisperModelSize: string
  /** WhisperX ASR model name, e.g. large-v2, large-v3 */
  whisperxModel: string
  transcriptionBackend: TranscriptionBackend
  diarizationEnabled: boolean
  /** Hugging Face token for pyannote (store locally; required for diarization) */
  huggingFaceToken: string
  whisperxBatchSize: number
  outputFolder: string
  transcriptLanguage: string
  /**
   * Boost microphone level before ASR (dB). Applied in capture (Web Audio) and when mixing mic + system in the Python worker.
   * 0 = unity; typical quiet laptop mics: 6–12.
   */
  micInputGainDb: number
  autoOpenNotion: boolean
  recordingMode: RecordingMode
}

export interface RecordingRow {
  id: string
  created_at: number
  updated_at: number
  status: RecordingStatus
  processing_state: ProcessingState
  audio_path: string | null
  /** Plain-text transcript path */
  transcript_path: string | null
  /** Structured JSON with segments {speaker,start,end,text} */
  transcript_json_path: string | null
  summary_json_path: string | null
  notion_page_id: string | null
  notion_page_url: string | null
  duration_sec: number | null
  error_message: string | null
  processing_started_at: number | null
  processing_finished_at: number | null
}

export interface PipelineProgress {
  recordingId: string
  state: ProcessingState
  message?: string
  notionPageUrl?: string
}

export interface TranscriptSegment {
  speaker: string
  start: number
  end: number
  text: string
}
