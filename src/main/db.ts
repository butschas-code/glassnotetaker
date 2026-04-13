import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import initSqlJs, { type Database as SqlDatabase } from 'sql.js'
import type { AppSettings, ProcessingState, RecordingRow, RecordingStatus } from '../shared/types'
import { getDbPath } from './paths'

const require = createRequire(import.meta.url)

let db: SqlDatabase | null = null

const defaultSettings: AppSettings = {
  notionToken: '',
  notionDatabaseId: '',
  notionTitleProperty: 'Name',
  notionDateProperty: 'Date',
  notionStatusProperty: 'Status',
  notionDurationProperty: 'Duration',
  lmStudioBaseUrl: 'http://localhost:1234/v1',
  lmStudioModel: '',
  whisperModelSize: 'small',
  whisperxModel: 'large-v2',
  transcriptionBackend: 'whisperx',
  diarizationEnabled: true,
  huggingFaceToken: '',
  whisperxBatchSize: 8,
  outputFolder: '',
  transcriptLanguage: 'en',
  autoOpenNotion: true,
  recordingMode: 'system_only'
}

function wasmLocateFile(file: string): string {
  const p = require.resolve(`sql.js/dist/${file}`)
  /* WASM must load from disk; packaged app keeps sql.js in app.asar.unpacked */
  return p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
}

function persist(): void {
  if (!db) return
  const data = db.export()
  const path = getDbPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, Buffer.from(data))
}

export function isDatabaseOpen(): boolean {
  return db !== null
}

export function getDefaultSettings(): AppSettings {
  return { ...defaultSettings }
}

export async function openDatabase(): Promise<SqlDatabase> {
  if (db) return db
  const path = getDbPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const SQL = await initSqlJs({ locateFile: wasmLocateFile })
  if (existsSync(path)) {
    const file = readFileSync(path)
    db = new SQL.Database(new Uint8Array(file))
  } else {
    db = new SQL.Database()
  }
  migrate()
  persist()
  return db
}

function ensureDb(): SqlDatabase {
  if (!db) throw new Error('Database not initialized')
  return db
}

function migrate(): void {
  const d = ensureDb()
  d.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      processing_state TEXT NOT NULL DEFAULT 'idle',
      audio_path TEXT,
      transcript_path TEXT,
      summary_json_path TEXT,
      notion_page_id TEXT,
      notion_page_url TEXT,
      duration_sec REAL,
      error_message TEXT,
      processing_started_at INTEGER,
      processing_finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at DESC);
  `)
  tryMigrateColumns()
}

function tryMigrateColumns(): void {
  const d = ensureDb()
  const stmts = ['ALTER TABLE recordings ADD COLUMN transcript_json_path TEXT']
  for (const sql of stmts) {
    try {
      d.run(sql)
    } catch {
      /* column exists */
    }
  }
}

export function getSettings(): AppSettings {
  const d = ensureDb()
  const stmt = d.prepare('SELECT key, value FROM settings')
  const map: Record<string, string> = {}
  while (stmt.step()) {
    const row = stmt.getAsObject() as { key: string; value: string }
    map[row.key] = row.value
  }
  stmt.free()
  const merged = { ...defaultSettings }
  for (const k of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
    if (map[k as string] !== undefined) {
      const v = map[k as string]
      if (k === 'autoOpenNotion' || k === 'diarizationEnabled') {
        (merged as Record<string, unknown>)[k] = v === 'true' || v === '1'
      } else if (k === 'whisperxBatchSize') {
        (merged as Record<string, unknown>)[k] = Number(v) || defaultSettings.whisperxBatchSize
      } else {
        (merged as Record<string, unknown>)[k] = v
      }
    }
  }
  return merged
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next = { ...current, ...partial }
  const d = ensureDb()
  for (const key of Object.keys(next) as (keyof AppSettings)[]) {
    const val = next[key]
    const str = typeof val === 'boolean' ? (val ? 'true' : 'false') : String(val ?? '')
    d.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      str
    ])
  }
  persist()
  return next
}

export function createRecordingRow(initial?: Partial<Pick<RecordingRow, 'audio_path'>>): RecordingRow {
  const d = ensureDb()
  const id = randomUUID()
  const now = Date.now()
  const row: RecordingRow = {
    id,
    created_at: now,
    updated_at: now,
    status: 'recording',
    processing_state: 'recording',
    audio_path: initial?.audio_path ?? null,
    transcript_path: null,
    transcript_json_path: null,
    summary_json_path: null,
    notion_page_id: null,
    notion_page_url: null,
    duration_sec: null,
    error_message: null,
    processing_started_at: null,
    processing_finished_at: null
  }
  d.run(
    `INSERT INTO recordings (
      id, created_at, updated_at, status, processing_state, audio_path, transcript_path, transcript_json_path, summary_json_path,
      notion_page_id, notion_page_url, duration_sec, error_message, processing_started_at, processing_finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.created_at,
      row.updated_at,
      row.status,
      row.processing_state,
      row.audio_path,
      row.transcript_path,
      row.transcript_json_path,
      row.summary_json_path,
      row.notion_page_id,
      row.notion_page_url,
      row.duration_sec,
      row.error_message,
      row.processing_started_at,
      row.processing_finished_at
    ]
  )
  persist()
  return row
}

export function updateRecording(
  id: string,
  patch: Partial<
    Pick<
      RecordingRow,
      | 'status'
      | 'processing_state'
      | 'audio_path'
      | 'transcript_path'
      | 'transcript_json_path'
      | 'summary_json_path'
      | 'notion_page_id'
      | 'notion_page_url'
      | 'duration_sec'
      | 'error_message'
      | 'processing_started_at'
      | 'processing_finished_at'
    >
  >
): void {
  const cur = getRecording(id)
  if (!cur) return
  const next = { ...cur, ...patch, updated_at: Date.now() }
  const d = ensureDb()
  d.run(
    `UPDATE recordings SET
      updated_at = ?,
      status = ?,
      processing_state = ?,
      audio_path = ?,
      transcript_path = ?,
      transcript_json_path = ?,
      summary_json_path = ?,
      notion_page_id = ?,
      notion_page_url = ?,
      duration_sec = ?,
      error_message = ?,
      processing_started_at = ?,
      processing_finished_at = ?
    WHERE id = ?`,
    [
      next.updated_at,
      next.status,
      next.processing_state,
      next.audio_path,
      next.transcript_path,
      next.transcript_json_path,
      next.summary_json_path,
      next.notion_page_id,
      next.notion_page_url,
      next.duration_sec,
      next.error_message,
      next.processing_started_at,
      next.processing_finished_at,
      id
    ]
  )
  persist()
}

function rowFromObject(o: Record<string, unknown>): RecordingRow {
  return {
    id: String(o.id),
    created_at: Number(o.created_at),
    updated_at: Number(o.updated_at),
    status: o.status as RecordingRow['status'],
    processing_state: o.processing_state as RecordingRow['processing_state'],
    audio_path: (o.audio_path as string | null) ?? null,
    transcript_path: (o.transcript_path as string | null) ?? null,
    transcript_json_path: (o.transcript_json_path as string | null) ?? null,
    summary_json_path: (o.summary_json_path as string | null) ?? null,
    notion_page_id: (o.notion_page_id as string | null) ?? null,
    notion_page_url: (o.notion_page_url as string | null) ?? null,
    duration_sec: o.duration_sec != null ? Number(o.duration_sec) : null,
    error_message: (o.error_message as string | null) ?? null,
    processing_started_at: o.processing_started_at != null ? Number(o.processing_started_at) : null,
    processing_finished_at: o.processing_finished_at != null ? Number(o.processing_finished_at) : null
  }
}

export function getRecording(id: string): RecordingRow | null {
  const d = ensureDb()
  const stmt = d.prepare('SELECT * FROM recordings WHERE id = ?')
  stmt.bind([id])
  if (!stmt.step()) {
    stmt.free()
    return null
  }
  const o = stmt.getAsObject()
  stmt.free()
  return rowFromObject(o as Record<string, unknown>)
}

export function listRecentRecordings(limit = 50): RecordingRow[] {
  const d = ensureDb()
  const stmt = d.prepare('SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?')
  stmt.bind([limit])
  const rows: RecordingRow[] = []
  while (stmt.step()) {
    rows.push(rowFromObject(stmt.getAsObject() as Record<string, unknown>))
  }
  stmt.free()
  return rows
}

export function setRecordingState(id: string, processing_state: ProcessingState, status?: RecordingStatus): void {
  const d = ensureDb()
  const s =
    status ??
    (processing_state === 'failed' ? 'failed' : processing_state === 'completed' ? 'completed' : 'processing')
  d.run('UPDATE recordings SET processing_state = ?, status = ?, updated_at = ? WHERE id = ?', [
    processing_state,
    s,
    Date.now(),
    id
  ])
  persist()
}
