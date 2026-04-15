import { Client } from '@notionhq/client'
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints'
import type { AppSettings, MeetingSummaryJson } from '../shared/types'

const CHUNK = 1800

function chunkText(text: string): string[] {
  if (text.length <= CHUNK) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += CHUNK) {
    parts.push(text.slice(i, i + CHUNK))
  }
  return parts
}

function richParagraphs(text: string): BlockObjectRequest[] {
  return chunkText(text).map(
    (t): BlockObjectRequest => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: t } }]
      }
    })
  )
}

function heading2(text: string): BlockObjectRequest {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: text } }]
    }
  }
}

function bulletList(items: string[]): BlockObjectRequest[] {
  return items.map(
    (t): BlockObjectRequest => ({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ type: 'text', text: { content: t } }]
      }
    })
  )
}

function todoList(items: { text: string; checked?: boolean }[]): BlockObjectRequest[] {
  return items.map(
    (t): BlockObjectRequest => ({
      object: 'block',
      type: 'to_do',
      to_do: {
        rich_text: [{ type: 'text', text: { content: t.text } }],
        checked: t.checked ?? false
      }
    })
  )
}

function divider(): BlockObjectRequest {
  return { object: 'block', type: 'divider', divider: {} }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m === 0) return `${s}s`
  return `${m}m ${s}s`
}

function formatPageTitle(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}`
}

export async function createNotionMeetingPage(
  settings: AppSettings,
  summary: MeetingSummaryJson,
  transcript: string,
  meta: {
    durationSec: number
    audioPath: string
    transcriptPath: string
    transcriptJsonPath: string
    createdAt: number
    processingMs: number
  }
): Promise<{ pageId: string; url: string }> {
  const token = settings.notionToken.trim()
  const parentPageId = settings.notionDatabaseId.trim()
  if (!token) throw new Error('Notion integration token is missing')
  if (!parentPageId) throw new Error('Notion page ID is missing. Set it in Settings (Database ID field).')

  const client = new Client({ auth: token })

  const dateStr = formatPageTitle(new Date(meta.createdAt))
  const pageTitle = summary.title?.trim()
    ? `${summary.title.trim()} — ${dateStr}`
    : `Call Notes — ${dateStr}`

  const children: BlockObjectRequest[] = []

  // Elaborate summary (split on blank lines into paragraphs)
  const summaryText = summary.summary?.trim() ?? ''
  if (summaryText) {
    children.push(heading2('Summary'))
    const paras = summaryText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    const blocks = paras.length ? paras : [summaryText]
    for (const para of blocks) {
      children.push(...richParagraphs(para))
    }
    children.push(divider())
  }

  // Metadata line
  const metaLine = [
    `📅 ${new Date(meta.createdAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
    `⏱ Duration: ${formatDuration(meta.durationSec)}`,
    summary.participants.length ? `👥 ${summary.participants.join(', ')}` : null
  ].filter(Boolean).join('  •  ')
  children.push(...richParagraphs(metaLine))
  children.push(divider())

  // Action Items (as to-do checkboxes)
  if (summary.action_items.length) {
    children.push(heading2('Action Items'))
    children.push(
      ...todoList(
        summary.action_items.map((a) => {
          const parts = [a.task]
          if (a.owner) parts.push(`@${a.owner}`)
          if (a.due) parts.push(`due ${a.due}`)
          return { text: parts.join(' — '), checked: false }
        })
      )
    )
    children.push(divider())
  }

  // Decisions
  if (summary.decisions.length) {
    children.push(heading2('Decisions'))
    children.push(...bulletList(summary.decisions))
  }

  children.push(divider())

  // Transcript (in a toggle for cleanliness)
  children.push({
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: '📝 Full Transcript' } }],
      children: richParagraphs(transcript.trim() || '(empty)').slice(0, 100)
    }
  } as any)

  // Metadata toggle
  children.push({
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: '⚙️ Recording Metadata' } }],
      children: richParagraphs(
        [
          `Audio: ${meta.audioPath}`,
          `Transcript: ${meta.transcriptPath}`,
          `Created: ${new Date(meta.createdAt).toISOString()}`,
          `Processing: ${meta.processingMs}ms`
        ].join('\n')
      )
    }
  } as any)

  // Create page as child of the parent page
  const page = await client.pages.create({
    parent: { page_id: parentPageId },
    icon: { type: 'emoji', emoji: '🎙️' },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: pageTitle.slice(0, 2000) } }]
      }
    },
    children: children.slice(0, 100)
  })

  const pageId = page.id
  let remaining = children.slice(100)
  while (remaining.length) {
    const batch = remaining.slice(0, 100)
    remaining = remaining.slice(100)
    await client.blocks.children.append({ block_id: pageId, children: batch })
  }

  const url = page.url ?? `https://www.notion.so/${pageId.replace(/-/g, '')}`
  return { pageId, url }
}
