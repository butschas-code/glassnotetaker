import { shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { MeetingSummaryJson, PipelineProgress, ProcessingState } from '../shared/types'
import { SystemAudioCapture } from './audio-capture'
import {
  createRecordingRow,
  getDefaultSettings,
  getRecording,
  getSettings,
  isDatabaseOpen,
  listRecentRecordings,
  saveSettings,
  updateRecording
} from './db'
import { summarizeTranscriptWithLmStudio } from './lm-studio'
import { createNotionMeetingPage } from './notion-client'
import { runTranscription, type TranscriptionProgressPhase } from './transcription'
import { ensureOutputDir } from './paths'

type ProgressFn = (p: PipelineProgress) => void

let activeCapture: SystemAudioCapture | null = null
let activeRecordingId: string | null = null

export function getActiveRecordingId(): string | null {
  return activeRecordingId
}

function mapPhaseToState(phase: TranscriptionProgressPhase): ProcessingState {
  if (phase === 'diarize') return 'diarizing'
  return 'transcribing'
}

export async function startRecordingSession(onProgress: ProgressFn): Promise<{ recordingId: string }> {
  const settings = getSettings()
  const outDir = ensureOutputDir(settings.outputFolder)
  const row = createRecordingRow()
  const audioPath = join(outDir, `capture-${row.id}.webm`)
  updateRecording(row.id, { audio_path: audioPath })
  activeRecordingId = row.id

  const capture = new SystemAudioCapture(audioPath, { micGainDb: settings.micInputGainDb })
  activeCapture = capture

  try {
    await capture.start()
  } catch (e) {
    activeCapture = null
    activeRecordingId = null
    updateRecording(row.id, {
      status: 'failed',
      processing_state: 'failed',
      error_message: (e as Error).message
    })
    throw e
  }

  onProgress({ recordingId: row.id, state: 'recording' })
  return { recordingId: row.id }
}

export async function stopRecordingAndProcess(onProgress: ProgressFn): Promise<void> {
  const recId = activeRecordingId
  const capture = activeCapture
  if (!recId || !capture) {
    throw new Error('No active recording')
  }

  const settings = getSettings()
  const row = getRecording(recId)
  if (!row?.audio_path) throw new Error('Recording row missing audio path')

  activeCapture = null
  activeRecordingId = null

  onProgress({ recordingId: recId, state: 'finalizing_audio' })
  updateRecording(recId, { processing_state: 'finalizing_audio', status: 'processing', processing_started_at: Date.now() })

  let audioPath = row.audio_path
  let durationSec = 0

  try {
    const result = await capture.stop()
    audioPath = result.outputPath
    durationSec = result.durationSec
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }

  if (!existsSync(audioPath)) {
    const msg =
      'No audio was recorded. Please grant Screen Recording permission to GlassCall Notes in System Settings → Privacy & Security → Screen Recording, then restart the app.'
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw new Error(msg)
  }

  updateRecording(recId, {
    audio_path: audioPath,
    duration_sec: durationSec,
    processing_state: 'transcribing'
  })
  onProgress({ recordingId: recId, state: 'transcribing' })

  const outDir = ensureOutputDir(settings.outputFolder)
  const base = basename(audioPath).replace(/\.[^/.]+$/, '')

  const t0 = Date.now()
  let summarizerText: string
  let transcriptPath: string
  let transcriptJsonPath: string
  let detectedLanguage: string | null = null
  try {
    const tr = await runTranscription(audioPath, settings, {
      outDir,
      onPhase: (phase) => {
        onProgress({ recordingId: recId, state: mapPhaseToState(phase) })
      }
    })
    summarizerText = tr.summarizerText
    transcriptPath = tr.transcriptPath
    transcriptJsonPath = tr.transcriptJsonPath
    detectedLanguage = tr.language
    if (durationSec <= 0 && tr.durationSeconds > 0) {
      durationSec = tr.durationSeconds
    }
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }

  updateRecording(recId, {
    transcript_path: transcriptPath,
    transcript_json_path: transcriptJsonPath,
    processing_state: 'summarizing'
  })
  onProgress({ recordingId: recId, state: 'summarizing' })

  let summary: MeetingSummaryJson
  try {
    summary = await summarizeTranscriptWithLmStudio(summarizerText, settings, detectedLanguage)
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }

  const summaryPath = join(outDir, `${base}.summary.json`)
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')

  updateRecording(recId, {
    summary_json_path: summaryPath,
    processing_state: 'creating_notion_page'
  })
  onProgress({ recordingId: recId, state: 'creating_notion_page' })

  const processingMs = Date.now() - t0

  try {
    const notion = await createNotionMeetingPage(settings, summary, summarizerText, {
      durationSec,
      audioPath,
      transcriptPath,
      transcriptJsonPath,
      createdAt: row.created_at,
      processingMs
    })

    updateRecording(recId, {
      notion_page_id: notion.pageId,
      notion_page_url: notion.url,
      status: 'completed',
      processing_state: 'completed',
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'completed', notionPageUrl: notion.url })

    if (settings.autoOpenNotion && notion.url) {
      await shell.openExternal(notion.url)
    }
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }
}

export function cancelRecording(): string | null {
  const recId = activeRecordingId
  const cap = activeCapture
  activeCapture = null
  activeRecordingId = null
  if (cap) cap.kill()
  if (recId) {
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: 'Cancelled',
      processing_finished_at: Date.now()
    })
  }
  return recId
}

export function loadAppData() {
  if (!isDatabaseOpen()) {
    return { settings: getDefaultSettings(), recordings: [] }
  }
  return {
    settings: getSettings(),
    recordings: listRecentRecordings(50)
  }
}

export function persistSettings(patch: Parameters<typeof saveSettings>[0]) {
  return saveSettings(patch)
}

export function readSummaryJson(path: string): MeetingSummaryJson | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as MeetingSummaryJson
  } catch {
    return null
  }
}

export async function retryRecording(recId: string, onProgress: ProgressFn): Promise<void> {
  const row = getRecording(recId)
  if (!row?.audio_path || !existsSync(row.audio_path)) {
    throw new Error('Original audio file is missing; cannot retry.')
  }
  const settings = getSettings()
  updateRecording(recId, {
    status: 'processing',
    processing_state: 'transcribing',
    error_message: null,
    processing_started_at: Date.now()
  })

  const outDir = ensureOutputDir(settings.outputFolder)
  const base = basename(row.audio_path).replace(/\.[^/.]+$/, '')
  const t0 = Date.now()

  onProgress({ recordingId: recId, state: 'transcribing' })

  let summarizerText: string
  let transcriptPath: string
  let transcriptJsonPath: string
  let detectedLanguage: string | null = null
  try {
    const tr = await runTranscription(row.audio_path, settings, {
      outDir,
      onPhase: (phase) => onProgress({ recordingId: recId, state: mapPhaseToState(phase) })
    })
    summarizerText = tr.summarizerText
    transcriptPath = tr.transcriptPath
    transcriptJsonPath = tr.transcriptJsonPath
    detectedLanguage = tr.language
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }

  updateRecording(recId, {
    transcript_path: transcriptPath,
    transcript_json_path: transcriptJsonPath,
    processing_state: 'summarizing'
  })
  onProgress({ recordingId: recId, state: 'summarizing' })

  let summary: MeetingSummaryJson
  try {
    summary = await summarizeTranscriptWithLmStudio(summarizerText, settings, detectedLanguage)
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }

  const summaryPath = join(outDir, `${base}.summary.json`)
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')

  updateRecording(recId, {
    summary_json_path: summaryPath,
    processing_state: 'creating_notion_page'
  })
  onProgress({ recordingId: recId, state: 'creating_notion_page' })

  const durationSec = row.duration_sec ?? 0
  const processingMs = Date.now() - t0

  try {
    const notion = await createNotionMeetingPage(settings, summary, summarizerText, {
      durationSec,
      audioPath: row.audio_path,
      transcriptPath,
      transcriptJsonPath,
      createdAt: row.created_at,
      processingMs
    })

    updateRecording(recId, {
      notion_page_id: notion.pageId,
      notion_page_url: notion.url,
      status: 'completed',
      processing_state: 'completed',
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'completed', notionPageUrl: notion.url })

    if (settings.autoOpenNotion && notion.url) {
      await shell.openExternal(notion.url)
    }
  } catch (e) {
    const msg = (e as Error).message
    updateRecording(recId, {
      status: 'failed',
      processing_state: 'failed',
      error_message: msg,
      processing_finished_at: Date.now()
    })
    onProgress({ recordingId: recId, state: 'failed', message: msg })
    throw e
  }
}
