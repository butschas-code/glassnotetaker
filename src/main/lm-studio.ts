import { z } from 'zod'
import type { AppSettings, MeetingSummaryJson } from '../shared/types'

export const SUMMARIZATION_PROMPT = `You are a meeting-notes JSON generator. You MUST output ONLY a JSON object with no other text.

IMPORTANT: Your entire response must be a single valid JSON object. Do not include any explanation, preamble, or markdown. Start your response with { and end with }.

You will receive a call transcript. Extract the useful content and return this exact JSON structure:

{"title":"short meeting title","summary":"2-3 sentence summary","participants":["Speaker 1","Speaker 2"],"topics":["topic1"],"decisions":["decision1"],"action_items":[{"task":"description","owner":"","due":""}],"open_questions":["question1"],"next_steps":["step1"]}

CRITICAL RULES — FOLLOW STRICTLY:
- ONLY use information that is EXPLICITLY stated in the transcript. NEVER invent, guess, or fabricate content.
- If the transcript is short, trivial, or contains no real meeting content (e.g. just "test", greetings, silence), return EMPTY arrays and a summary that honestly describes what was said.
- For a transcript like "test test test", the correct output is: {"title":"Test Recording","summary":"The recording contained only test audio with no meeting content.","participants":[],"topics":[],"decisions":[],"action_items":[],"open_questions":[],"next_steps":[]}
- NEVER make up project names, tasks, decisions, or speaker names that do not appear in the transcript.
- NEVER add action items unless someone in the transcript explicitly commits to doing something.
- If there is nothing meaningful, say so honestly in the summary. Empty arrays are correct and expected.
- Output ONLY valid JSON, nothing else
- Use speaker names if mentioned, otherwise use SPEAKER_00 etc
- Leave owner/due as empty string if unclear

Transcript:
{{TRANSCRIPT}}`

const RETRY_PROMPT = `Your previous response was not valid JSON. You MUST respond with ONLY a JSON object.

Start with { and end with }. No explanation, no markdown, no preamble.

CRITICAL: Only include facts from the transcript. If the transcript has no real content, use empty arrays []. NEVER invent information.

Here is the transcript again. Respond with ONLY the JSON object:

{{TRANSCRIPT}}`

/** Above this size, send the transcript in chunks so small-context models (e.g. Gemma 3 4B) do not overflow. */
const SINGLE_SHOT_MAX_TRANSCRIPT_CHARS = 5_000
/** Target max characters of transcript text per chunk (prompt overhead stays under typical 8k-token windows). */
const TRANSCRIPT_CHUNK_CHARS = 4_800
/** Cap consolidated bullet text for the final title/summary call. */
const FINALIZE_MAX_CHARS = 14_000

const CHUNK_EXTRACTION_PROMPT = `You extract structured facts from ONE part of a longer call transcript (part {{PART_INDEX}} of {{PART_TOTAL}}).

Output ONLY valid JSON with this exact shape (no markdown, no explanation):
{"participants":[],"topics":[],"decisions":[],"action_items":[{"task":"","owner":"","due":""}],"open_questions":[],"next_steps":[]}

Rules:
- ONLY facts explicitly stated in THIS segment. Never invent names, tasks, or decisions.
- Use speaker labels from the segment (e.g. SPEAKER_00) if no names are given.
- Leave owner and due as "" when unknown.
- If this segment has no substantive content, return empty arrays.

Segment:
{{SEGMENT}}`

const FINALIZE_PROMPT = `You write a meeting title and short summary from consolidated notes (extracted from a long transcript). Output ONLY JSON:
{"title":"short descriptive title","summary":"2-3 sentences covering main outcomes"}

Rules:
- Use ONLY the bullet lists below. Do not invent participants, tasks, or decisions.
- If lists are sparse, say so honestly in the summary.

Consolidated notes:
{{NOTES}}`

const ActionItemSchema = z.object({
  task: z.string(),
  owner: z.string(),
  due: z.string()
})

export const MeetingSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  participants: z.array(z.string()),
  topics: z.array(z.string()),
  decisions: z.array(z.string()),
  action_items: z.array(ActionItemSchema),
  open_questions: z.array(z.string()),
  next_steps: z.array(z.string())
})

const ChunkFactsSchema = MeetingSummarySchema.omit({ title: true, summary: true })
type ChunkFacts = z.infer<typeof ChunkFactsSchema>

const TitleSummarySchema = z.object({
  title: z.string(),
  summary: z.string()
})

function buildPrompt(transcript: string): string {
  return SUMMARIZATION_PROMPT.replace('{{TRANSCRIPT}}', transcript.trim())
}

function buildRetryPrompt(transcript: string): string {
  return RETRY_PROMPT.replace('{{TRANSCRIPT}}', transcript.trim())
}

function extractJsonObject(text: string): string {
  const t = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
  const body = fence ? fence[1].trim() : t
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) return body.slice(start, end + 1)
  return body
}

async function callLmStudio(
  url: string,
  model: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages,
      stream: false,
      response_format: { type: 'text' }
    })
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`LM Studio error ${res.status}: ${errText.slice(0, 500)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('LM Studio returned no message content')
  }
  return content
}

function parseAndValidate(content: string): MeetingSummaryJson {
  const jsonStr = extractJsonObject(content)
  const parsed = JSON.parse(jsonStr)
  const validated = MeetingSummarySchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Schema mismatch: ${validated.error.message}`)
  }
  return validated.data
}

function parseChunkFacts(content: string): ChunkFacts {
  const jsonStr = extractJsonObject(content)
  const parsed = JSON.parse(jsonStr)
  const validated = ChunkFactsSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Schema mismatch: ${validated.error.message}`)
  }
  return validated.data
}

function parseTitleSummary(content: string): z.infer<typeof TitleSummarySchema> {
  const jsonStr = extractJsonObject(content)
  const parsed = JSON.parse(jsonStr)
  const validated = TitleSummarySchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Schema mismatch: ${validated.error.message}`)
  }
  return validated.data
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const k = normalizeKey(item)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(item.trim())
  }
  return out
}

function dedupeActionItems(items: z.infer<typeof ActionItemSchema>[]): z.infer<typeof ActionItemSchema>[] {
  const seen = new Set<string>()
  const out: z.infer<typeof ActionItemSchema>[] = []
  for (const a of items) {
    const k = normalizeKey(a.task)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push({
      task: a.task.trim(),
      owner: (a.owner ?? '').trim(),
      due: (a.due ?? '').trim()
    })
  }
  return out
}

function splitTranscriptIntoChunks(transcript: string, maxChars: number): string[] {
  const lines = transcript.split('\n')
  const chunks: string[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(current.join('\n'))
    current = []
  }

  for (const line of lines) {
    if (line.length > maxChars) {
      flush()
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars))
      }
      continue
    }
    const nextLines = current.length === 0 ? [line] : [...current, line]
    const candidateLen = nextLines.join('\n').length
    if (candidateLen > maxChars && current.length > 0) {
      flush()
      current = [line]
    } else {
      current = nextLines
    }
  }
  flush()
  return chunks.length > 0 ? chunks : [transcript]
}

function mergeChunkFacts(parts: ChunkFacts[]): Omit<MeetingSummaryJson, 'title' | 'summary'> {
  return {
    participants: dedupeStrings(parts.flatMap((p) => p.participants)),
    topics: dedupeStrings(parts.flatMap((p) => p.topics)),
    decisions: dedupeStrings(parts.flatMap((p) => p.decisions)),
    action_items: dedupeActionItems(parts.flatMap((p) => p.action_items)),
    open_questions: dedupeStrings(parts.flatMap((p) => p.open_questions)),
    next_steps: dedupeStrings(parts.flatMap((p) => p.next_steps))
  }
}

function buildConsolidatedNotes(merged: Omit<MeetingSummaryJson, 'title' | 'summary'>): string {
  const fmt = (label: string, arr: string[], maxItems: number): string => {
    const slice = arr.slice(0, maxItems)
    const extra = arr.length - slice.length
    const bullets = slice.map((x) => `- ${x}`).join('\n')
    const suffix = extra > 0 ? `\n... (${extra} more omitted)` : ''
    return `${label}:\n${bullets || '(none)'}${suffix}`
  }

  const actionLines =
    merged.action_items.length === 0
      ? '(none)'
      : merged.action_items
          .slice(0, 45)
          .map(
            (a) =>
              `- ${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}${a.due ? ` due: ${a.due}` : ''}`
          )
          .join('\n') +
        (merged.action_items.length > 45 ? `\n... (${merged.action_items.length - 45} more omitted)` : '')

  const body = [
    fmt('Participants', merged.participants, 40),
    fmt('Topics', merged.topics, 60),
    fmt('Decisions', merged.decisions, 40),
    `Action items:\n${actionLines}`,
    fmt('Open questions', merged.open_questions, 40),
    fmt('Next steps', merged.next_steps, 40)
  ].join('\n\n')

  if (body.length <= FINALIZE_MAX_CHARS) return body
  return `${body.slice(0, FINALIZE_MAX_CHARS - 80)}\n\n...(notes truncated for model context limit)`
}

function buildChunkPrompt(segment: string, partIndex: number, partTotal: number): string {
  return CHUNK_EXTRACTION_PROMPT.replace('{{PART_INDEX}}', String(partIndex))
    .replace('{{PART_TOTAL}}', String(partTotal))
    .replace('{{SEGMENT}}', segment.trim())
}

async function extractChunkFactsWithRetries(
  url: string,
  model: string,
  segment: string,
  partIndex: number,
  partTotal: number
): Promise<ChunkFacts> {
  const userContent = buildChunkPrompt(segment, partIndex, partTotal)
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: 'You are a JSON-only assistant. You MUST respond with valid JSON and nothing else.' },
    { role: 'user', content: userContent }
  ]
  const maxAttempts = 3
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callLmStudio(url, model, messages)
      return parseChunkFacts(content)
    } catch (e) {
      lastError = e as Error
      if (attempt < maxAttempts) {
        messages.push(
          { role: 'assistant', content: '{}' },
          {
            role: 'user',
            content: `Invalid or incomplete JSON. Reply with ONLY this shape, using facts from the SAME segment only:
{"participants":[],"topics":[],"decisions":[],"action_items":[],"open_questions":[],"next_steps":[]}

Segment (${partIndex}/${partTotal}):
${segment.trim()}`
          }
        )
      }
    }
  }
  throw new Error(
    `Chunk ${partIndex}/${partTotal}: failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`
  )
}

async function finalizeTitleSummaryWithRetries(
  url: string,
  model: string,
  notes: string
): Promise<z.infer<typeof TitleSummarySchema>> {
  const userContent = FINALIZE_PROMPT.replace('{{NOTES}}', notes)
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: 'You are a JSON-only assistant. You MUST respond with valid JSON and nothing else.' },
    { role: 'user', content: userContent }
  ]
  const maxAttempts = 3
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callLmStudio(url, model, messages)
      return parseTitleSummary(content)
    } catch (e) {
      lastError = e as Error
      if (attempt < maxAttempts) {
        messages.push(
          { role: 'assistant', content: '{"title":"","summary":""}' },
          {
            role: 'user',
            content:
              'Invalid JSON. Output ONLY: {"title":"...","summary":"..."} using the bullet lists from the previous user message.'
          }
        )
      }
    }
  }
  throw new Error(`Finalize step failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`)
}

async function summarizeTranscriptChunked(
  transcript: string,
  url: string,
  model: string
): Promise<MeetingSummaryJson> {
  const segments = splitTranscriptIntoChunks(transcript, TRANSCRIPT_CHUNK_CHARS)
  const facts: ChunkFacts[] = []
  for (let i = 0; i < segments.length; i++) {
    const part = await extractChunkFactsWithRetries(url, model, segments[i], i + 1, segments.length)
    facts.push(part)
  }
  const merged = mergeChunkFacts(facts)
  const notes = buildConsolidatedNotes(merged)
  const { title, summary } = await finalizeTitleSummaryWithRetries(url, model, notes)
  return {
    title,
    summary,
    ...merged
  }
}

async function summarizeTranscriptSingleShot(
  transcript: string,
  url: string,
  model: string
): Promise<MeetingSummaryJson> {
  const prompt = buildPrompt(transcript)
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: 'You are a JSON-only assistant. You MUST respond with valid JSON and nothing else.' },
    { role: 'user', content: prompt }
  ]

  const maxAttempts = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callLmStudio(url, model, messages)
      return parseAndValidate(content)
    } catch (e) {
      lastError = e as Error
      if (attempt < maxAttempts) {
        messages.push(
          { role: 'assistant', content: (e as Error).message.includes('Schema') ? '{}' : 'error' },
          { role: 'user', content: buildRetryPrompt(transcript) }
        )
      }
    }
  }

  throw new Error(
    `Failed to get valid JSON from LM Studio after ${maxAttempts} attempts. Last error: ${lastError?.message}`
  )
}

function looksLikeContextLimitError(message: string): boolean {
  return /context|token|length|too long|maximum|exceed|413|payload|slot|kv cache|window/i.test(
    message.toLowerCase()
  )
}

function isTrivialTranscript(transcript: string): MeetingSummaryJson | null {
  const cleaned = transcript.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '')
  const words = cleaned.split(/\s+/).filter(Boolean)
  const uniqueWords = new Set(words)

  if (words.length === 0) {
    return {
      title: 'Empty Recording',
      summary: 'The recording contained no speech.',
      participants: [],
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
      next_steps: []
    }
  }

  // If fewer than 10 unique words and fewer than 30 total words, it's trivial
  if (uniqueWords.size <= 10 && words.length < 30) {
    const spoken = [...uniqueWords].join(', ')
    return {
      title: 'Brief Recording',
      summary: `The recording contained only brief audio: "${spoken}". No meeting content was captured.`,
      participants: [],
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
      next_steps: []
    }
  }

  return null
}

export async function summarizeTranscriptWithLmStudio(
  transcript: string,
  settings: AppSettings
): Promise<MeetingSummaryJson> {
  const trivial = isTrivialTranscript(transcript)
  if (trivial) return trivial

  const base = settings.lmStudioBaseUrl.replace(/\/$/, '')
  const url = base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  const model = settings.lmStudioModel.trim()
  if (!model) {
    throw new Error('LM Studio model name is empty. Set it in Settings.')
  }

  const trimmed = transcript.trim()

  if (trimmed.length > SINGLE_SHOT_MAX_TRANSCRIPT_CHARS) {
    return summarizeTranscriptChunked(trimmed, url, model)
  }

  try {
    return await summarizeTranscriptSingleShot(trimmed, url, model)
  } catch (e) {
    const msg = (e as Error).message
    if (looksLikeContextLimitError(msg)) {
      return summarizeTranscriptChunked(trimmed, url, model)
    }
    throw e
  }
}
