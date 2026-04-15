import { z } from 'zod'
import type { AppSettings, MeetingSummaryJson } from '../shared/types'

export const SUMMARIZATION_PROMPT = `You are a meeting-notes JSON generator. You MUST output ONLY a JSON object with no other text.

{{LANGUAGE_DIRECTIVE}}

IMPORTANT: Your entire response must be a single valid JSON object. Do not include any explanation, preamble, or markdown. Start your response with { and end with }.

You will receive a call transcript. Extract the useful content and return this exact JSON structure:

{"title":"short meeting title","summary":"…","participants":["Speaker 1","Speaker 2"],"decisions":["decision1"],"action_items":[{"task":"description","owner":"","due":""}]}

The "summary" field must be a DETAILED narrative: at least 3–6 paragraphs separated by blank lines (use \\n\\n between paragraphs in the JSON string). Cover what was actually discussed: context, main points, outcomes, and concrete details — but ONLY if they appear in the transcript. Do not pad with generic filler.

CRITICAL RULES — FOLLOW STRICTLY:
- ONLY use information that is EXPLICITLY stated in the transcript. NEVER invent, guess, or fabricate names, numbers, commitments, or events.
- The transcript may contain ASR errors, repeated filler, or nonsensical phrases from poor audio. Treat obvious garble as noise — do NOT invent meaning for it.
- If the transcript is short, trivial, or contains no real meeting content (e.g. just "test", greetings, silence), use brief paragraphs that honestly describe what was said; use empty arrays where appropriate.
- NEVER add action items unless someone in the transcript explicitly commits to doing something ("I will …", "ich werde …", "can you …", "kannst du …" followed by agreement).
- NEVER add decisions unless the transcript contains an explicit choice or agreement.
- If ASR quality is poor, say so honestly in the summary; do not invent plausible-sounding details.
- Output ONLY valid JSON, nothing else.
- Use speaker names if mentioned, otherwise use SPEAKER_00 etc.
- Leave owner/due as empty string if unclear.

Transcript:
{{TRANSCRIPT}}`

const RETRY_PROMPT = `Your previous response was not valid JSON. You MUST respond with ONLY a JSON object.

{{LANGUAGE_DIRECTIVE}}

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

{{LANGUAGE_DIRECTIVE}}

Output ONLY valid JSON with this exact shape (no markdown, no explanation):
{"participants":[],"decisions":[],"action_items":[{"task":"","owner":"","due":""}]}

Rules:
- ONLY facts explicitly stated in THIS segment. Never invent names, tasks, or decisions.
- The segment may contain ASR errors; treat garble as noise and do NOT invent meaning.
- Only include an action_item when someone explicitly commits to doing something.
- Use speaker labels from the segment (e.g. SPEAKER_00) if no names are given.
- Leave owner and due as "" when unknown.
- If this segment has no substantive content, return empty arrays.

Segment:
{{SEGMENT}}`

const FINALIZE_PROMPT = `You write a meeting title and a DETAILED summary from consolidated notes (extracted from a long transcript). Output ONLY JSON:
{"title":"short descriptive title","summary":"…"}

{{LANGUAGE_DIRECTIVE}}

The "summary" must be 4–8 paragraphs separated by blank lines (use \\n\\n between paragraphs in the JSON string). Write in clear prose: overview, what was discussed, decisions and commitments, and any notable details — using ONLY information implied by the notes below. If the notes are thin or contradictory, say so honestly; do not invent specifics.

Rules:
- Use ONLY the notes below. Do not invent participants, tasks, or decisions.
- Do not add topics, questions, or "next steps" unless they appear as facts in the notes.

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
  decisions: z.array(z.string()),
  action_items: z.array(ActionItemSchema)
})

const ChunkFactsSchema = MeetingSummarySchema.omit({ title: true, summary: true })
type ChunkFacts = z.infer<typeof ChunkFactsSchema>

const TitleSummarySchema = z.object({
  title: z.string(),
  summary: z.string()
})

type OutputLang = 'de' | 'en'

function normalizeLanguage(lang: string | null | undefined): OutputLang {
  const code = (lang || '').trim().toLowerCase().slice(0, 2)
  return code === 'de' ? 'de' : 'en'
}

function languageDirective(lang: OutputLang): string {
  if (lang === 'de') {
    return [
      'LANGUAGE: The audio is in German. You MUST write ALL output (title, summary, decisions, action_items) in GERMAN.',
      'Do not translate to English. Use natural German phrasing.',
      'Example action_item in German: {"task":"Angebot bis Freitag an Kunde senden","owner":"Max","due":"Freitag"}'
    ].join('\n')
  }
  return [
    'LANGUAGE: The audio is in English. You MUST write ALL output (title, summary, decisions, action_items) in ENGLISH.',
    'Example action_item in English: {"task":"Send proposal to client by Friday","owner":"Max","due":"Friday"}'
  ].join('\n')
}

function buildPrompt(transcript: string, lang: OutputLang): string {
  return SUMMARIZATION_PROMPT.replace('{{LANGUAGE_DIRECTIVE}}', languageDirective(lang)).replace(
    '{{TRANSCRIPT}}',
    transcript.trim()
  )
}

function buildRetryPrompt(transcript: string, lang: OutputLang): string {
  return RETRY_PROMPT.replace('{{LANGUAGE_DIRECTIVE}}', languageDirective(lang)).replace(
    '{{TRANSCRIPT}}',
    transcript.trim()
  )
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
    decisions: dedupeStrings(parts.flatMap((p) => p.decisions)),
    action_items: dedupeActionItems(parts.flatMap((p) => p.action_items))
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
    fmt('Decisions', merged.decisions, 40),
    `Action items:\n${actionLines}`
  ].join('\n\n')

  if (body.length <= FINALIZE_MAX_CHARS) return body
  return `${body.slice(0, FINALIZE_MAX_CHARS - 80)}\n\n...(notes truncated for model context limit)`
}

function buildChunkPrompt(segment: string, partIndex: number, partTotal: number, lang: OutputLang): string {
  return CHUNK_EXTRACTION_PROMPT.replace('{{LANGUAGE_DIRECTIVE}}', languageDirective(lang))
    .replace('{{PART_INDEX}}', String(partIndex))
    .replace('{{PART_TOTAL}}', String(partTotal))
    .replace('{{SEGMENT}}', segment.trim())
}

async function extractChunkFactsWithRetries(
  url: string,
  model: string,
  segment: string,
  partIndex: number,
  partTotal: number,
  lang: OutputLang
): Promise<ChunkFacts> {
  const userContent = buildChunkPrompt(segment, partIndex, partTotal, lang)
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
{"participants":[],"decisions":[],"action_items":[]}

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
  notes: string,
  lang: OutputLang
): Promise<z.infer<typeof TitleSummarySchema>> {
  const userContent = FINALIZE_PROMPT.replace('{{LANGUAGE_DIRECTIVE}}', languageDirective(lang)).replace(
    '{{NOTES}}',
    notes
  )
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
              'Invalid JSON. Output ONLY: {"title":"...","summary":"..."} — multi-paragraph summary (use \\n\\n between paragraphs), using ONLY the consolidated notes from the previous user message.'
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
  model: string,
  lang: OutputLang
): Promise<MeetingSummaryJson> {
  const segments = splitTranscriptIntoChunks(transcript, TRANSCRIPT_CHUNK_CHARS)
  const facts: ChunkFacts[] = []
  for (let i = 0; i < segments.length; i++) {
    const part = await extractChunkFactsWithRetries(url, model, segments[i], i + 1, segments.length, lang)
    facts.push(part)
  }
  const merged = mergeChunkFacts(facts)
  const notes = buildConsolidatedNotes(merged)
  const { title, summary } = await finalizeTitleSummaryWithRetries(url, model, notes, lang)
  return {
    title,
    summary,
    ...merged
  }
}

async function summarizeTranscriptSingleShot(
  transcript: string,
  url: string,
  model: string,
  lang: OutputLang
): Promise<MeetingSummaryJson> {
  const prompt = buildPrompt(transcript, lang)
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
          { role: 'user', content: buildRetryPrompt(transcript, lang) }
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
      decisions: [],
      action_items: []
    }
  }

  // If fewer than 10 unique words and fewer than 30 total words, it's trivial
  if (uniqueWords.size <= 10 && words.length < 30) {
    const spoken = [...uniqueWords].join(', ')
    return {
      title: 'Brief Recording',
      summary: `The recording contained only brief audio: "${spoken}". No meeting content was captured.`,
      participants: [],
      decisions: [],
      action_items: []
    }
  }

  return null
}

/**
 * Strip the `[HH:MM:SS] Speaker:` prefix from each line so only spoken content
 * remains — used for grounding the model's outputs against what was actually said.
 */
function stripTranscriptMetadata(transcript: string): string {
  return transcript
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*[^:]+:\s*/, ''))
    .join(' ')
}

const GROUNDING_STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must', 'shall',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  'this', 'that', 'these', 'those', 'as', 'if', 'then', 'than', 'so', 'not', 'no',
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'von', 'zu', 'zur', 'zum', 'in', 'im', 'an', 'am', 'auf', 'bei', 'für', 'mit',
  'ist', 'sind', 'war', 'waren', 'sein', 'gewesen', 'hat', 'haben', 'hatte', 'hatten',
  'wird', 'werden', 'würde', 'würden', 'soll', 'sollen', 'kann', 'können', 'muss', 'müssen',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'dich', 'mir', 'dir', 'uns', 'euch', 'ihn', 'ihm',
  'mein', 'dein', 'sein', 'unser', 'euer', 'dies', 'diese', 'dieser', 'dieses', 'jenes',
  'als', 'wenn', 'dann', 'auch', 'nicht', 'nein', 'ja', 'noch', 'schon', 'nur', 'sehr'
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GROUNDING_STOPWORDS.has(t))
}

/**
 * Drops action_items and decisions whose content words are not present in the
 * transcript. Defensive filter against small-model hallucination (Gemma 3 4B
 * will confidently invent tasks even with a "don't invent" prompt).
 *
 * Keeps an item if ≥60% of its content tokens (len ≥3, non-stopword) appear
 * in the transcript vocabulary, or if it has ≤2 content tokens and any match.
 */
function groundSummaryAgainstTranscript(
  summary: MeetingSummaryJson,
  transcript: string
): MeetingSummaryJson {
  const transcriptText = stripTranscriptMetadata(transcript)
  const transcriptVocab = new Set(tokenize(transcriptText))
  if (transcriptVocab.size === 0) return summary

  const isGrounded = (text: string): boolean => {
    const tokens = tokenize(text)
    if (tokens.length === 0) return false
    const matches = tokens.filter((t) => transcriptVocab.has(t)).length
    if (tokens.length <= 2) return matches >= 1
    return matches / tokens.length >= 0.6
  }

  return {
    ...summary,
    decisions: summary.decisions.filter(isGrounded),
    action_items: summary.action_items.filter((a) => isGrounded(a.task)),
    participants: summary.participants.filter((p) => {
      // Keep SPEAKER_xx labels verbatim; otherwise require the name to appear.
      if (/^SPEAKER_\d+$/i.test(p.trim())) return true
      return isGrounded(p)
    })
  }
}

export async function summarizeTranscriptWithLmStudio(
  transcript: string,
  settings: AppSettings,
  detectedLanguage?: string | null
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
  const lang = normalizeLanguage(detectedLanguage)

  let raw: MeetingSummaryJson
  if (trimmed.length > SINGLE_SHOT_MAX_TRANSCRIPT_CHARS) {
    raw = await summarizeTranscriptChunked(trimmed, url, model, lang)
  } else {
    try {
      raw = await summarizeTranscriptSingleShot(trimmed, url, model, lang)
    } catch (e) {
      const msg = (e as Error).message
      if (looksLikeContextLimitError(msg)) {
        raw = await summarizeTranscriptChunked(trimmed, url, model, lang)
      } else {
        throw e
      }
    }
  }

  return groundSummaryAgainstTranscript(raw, trimmed)
}
