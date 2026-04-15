import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { AppSettings, TranscriptSegment } from '../shared/types'
import { resolvePythonWorkerDir } from './paths'

export type TranscriptionProgressPhase = 'prepare' | 'transcribe' | 'align' | 'diarize'

export interface TranscribeResult {
  transcriptPath: string
  transcriptJsonPath: string
  /** Plain .txt (human-readable) */
  text: string
  /** Text with [timestamp] Speaker: line format for LM Studio */
  summarizerText: string
  segments: TranscriptSegment[]
  durationSeconds: number
  language: string | null
  diarizationApplied: boolean
  backendUsed: string
}

export interface RunTranscriptionOptions {
  onPhase?: (phase: TranscriptionProgressPhase) => void
}

function findPython(): string {
  if (process.env.GLASSCALL_PYTHON?.trim()) return process.env.GLASSCALL_PYTHON.trim()

  const candidates = [
    join(resolvePythonWorkerDir(), '.venv', 'bin', 'python3'),
    join(app.getPath('userData'), 'python-worker', '.venv', 'bin', 'python3')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return 'python3'
}

function mapStderrPhase(
  line: string,
  onPhase?: (phase: TranscriptionProgressPhase) => void
): void {
  const prefix = 'GLASSCALL_PROGRESS '
  if (!line.includes(prefix)) return
  const idx = line.indexOf(prefix)
  const jsonPart = line.slice(idx + prefix.length).trim()
  try {
    const j = JSON.parse(jsonPart) as { phase?: string }
    const p = j.phase
    if (p === 'prepare' || p === 'transcribe' || p === 'align' || p === 'diarize') {
      onPhase?.(p)
    }
  } catch {
    /* ignore */
  }
}

export interface TranscriptJsonFile {
  duration_seconds: number
  language: string | null
  segments_count: number
  diarization_applied: boolean
  backend?: string
  segments: TranscriptSegment[]
}

export function parseTranscriptJson(content: string): TranscriptJsonFile {
  return JSON.parse(content) as TranscriptJsonFile
}

/**
 * Pluggable transcription entry: default worker is WhisperX-capable `transcribe.py`.
 */
export async function runTranscription(
  audioPath: string,
  settings: AppSettings,
  opts: { outDir: string; micAudioPath?: string | null } & RunTranscriptionOptions
): Promise<TranscribeResult> {
  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`)
  }
  const workerDir = resolvePythonWorkerDir()
  const script = join(workerDir, 'transcribe.py')
  if (!existsSync(script)) {
    throw new Error(`Python worker not found at ${script}`)
  }

  const base = basename(audioPath).replace(/\.[^/.]+$/, '')
  const py = findPython()

  const backend = settings.transcriptionBackend || 'whisperx'
  if (backend === 'vibevocal_asr') {
    throw new Error('vibevocal_asr backend is not implemented. Choose whisperx or faster_whisper in Settings.')
  }

  const micGainDb = Math.max(0, Math.min(24, Number(settings.micInputGainDb) || 0))

  const args = [
    script,
    '--input',
    audioPath,
    '--output-dir',
    opts.outDir,
    '--basename',
    base,
    '--backend',
    backend === 'whisperx' ? 'whisperx' : 'faster_whisper',
    '--language',
    settings.transcriptLanguage || 'auto',
    '--whisperx-model',
    settings.whisperxModel || 'large-v2',
    '--batch-size',
    String(Math.max(2, Math.min(settings.whisperxBatchSize || 8, 16))),
    '--faster-model',
    settings.whisperModelSize || 'small',
    '--mic-gain-db',
    String(micGainDb)
  ]

  if (settings.diarizationEnabled) {
    args.push('--diarize')
  }
  const hf = settings.huggingFaceToken?.trim()
  if (hf) {
    args.push('--hf-token', hf)
  }

  if (opts.micAudioPath && existsSync(opts.micAudioPath)) {
    args.push('--input-mic', opts.micAudioPath)
  }

  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    const proc = spawn(py, args, {
      cwd: workerDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        HF_TOKEN: hf || process.env.HF_TOKEN,
        HUGGING_FACE_HUB_TOKEN: hf || process.env.HUGGING_FACE_HUB_TOKEN
      }
    })
    let stderr = ''
    let stdout = ''
    proc.stderr?.on('data', (c: Buffer) => {
      const chunk = c.toString('utf8')
      stderr += chunk
      for (const line of chunk.split('\n')) {
        if (line.includes('GLASSCALL_PROGRESS')) mapStderrPhase(line, opts.onPhase)
      }
    })
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    proc.on('close', (code) => resolve({ code, stderr, stdout }))
  })

  if (result.code !== 0) {
    throw new Error(`Transcription failed (exit ${result.code}): ${result.stderr.slice(-4000)}`)
  }

  const lastLine = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
  if (!lastLine) {
    throw new Error('Transcription produced no stdout result')
  }

  let summary: {
    ok?: boolean
    transcript_json?: string
    transcript_txt?: string
    summarizer_text?: string
    error?: string
    duration_seconds?: number
    language?: string | null
    segments_count?: number
    diarization_applied?: boolean
    backend?: string
  }
  try {
    summary = JSON.parse(lastLine) as typeof summary
  } catch {
    throw new Error(`Invalid transcription JSON: ${lastLine.slice(0, 500)}`)
  }

  if (!summary.ok) {
    throw new Error(summary.error || 'Transcription worker reported failure')
  }

  const jsonPath = summary.transcript_json
  const txtPath = summary.transcript_txt
  if (!jsonPath || !existsSync(jsonPath)) {
    throw new Error(`Missing transcript JSON at ${jsonPath}`)
  }
  if (!txtPath || !existsSync(txtPath)) {
    throw new Error(`Missing transcript text at ${txtPath}`)
  }

  const jsonBody = readFileSync(jsonPath, 'utf8')
  const parsed = parseTranscriptJson(jsonBody)
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.map((s) => ({
        speaker: String(s.speaker || 'Unknown'),
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text || '')
      }))
    : []

  const text = readFileSync(txtPath, 'utf8')
  const summarizerText =
    summary.summarizer_text?.trim() ||
    segments
      .map((s) => {
        const t = formatTs(s.start)
        return `[${t}] ${s.speaker}: ${s.text.trim()}`
      })
      .join('\n')

  return {
    transcriptPath: txtPath,
    transcriptJsonPath: jsonPath,
    text,
    summarizerText,
    segments,
    durationSeconds: summary.duration_seconds ?? parsed.duration_seconds ?? 0,
    language: summary.language ?? parsed.language ?? null,
    diarizationApplied: summary.diarization_applied ?? parsed.diarization_applied ?? false,
    backendUsed: summary.backend || parsed.backend || backend
  }
}

function formatTs(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
