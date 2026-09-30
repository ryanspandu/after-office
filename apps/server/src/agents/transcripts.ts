import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { CLAUDE_PROJECTS_DIR } from '../fsroots'
import { join } from 'node:path'
import type { ChatItem, LiveMode } from '@after-office/shared'
import { agentsRepo, offsetsRepo, usageRepo, type AgentRow } from '../db'
import { publish, runtimeOf, updateRuntime } from './registry'
import { ATTACH_HEADER, withAttachments } from './uploads'

// Claude Code writes every session to ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session-id>.jsonl.
// We read it incrementally for token usage and title/mode changes, and on demand for the Chat tab.

const TZ = process.env.OFFICE_TZ ?? 'Asia/Jakarta'
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

export function transcriptPath(row: AgentRow) {
  return runtimeOf(row.id).transcriptPath ?? join(CLAUDE_PROJECTS_DIR, row.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${row.session_id}.jsonl`)
}

interface Line {
  type?: string
  timestamp?: string
  requestId?: string
  uuid?: string
  isSidechain?: boolean
  /** the owner's prompt this line belongs to (a picture's path comes in a line of its own with the same id) */
  promptId?: string
  permissionMode?: string
  aiTitle?: string
  message?: {
    id?: string
    role?: string
    model?: string
    content?: unknown
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  }
}

/**
 * One message of the owner, as the chat shows it. Files attached in the chat end the message with an "[Attached
 * files]" list (agents/uploads.ts); Claude Code turns pictures in it into real images, leaving "[Image #1]" in the text
 * and their paths in separate blocks. Those go back into the list, so the chat can show every file again.
 */
export function ownerMessage(texts: string[], pictures: string[] = []) {
  let text = texts.map(unwrapPaste).join('\n\n')
  if (pictures.length) text = text.replace(/\[Image #\d+\]/g, '')
  const at = text.lastIndexOf(ATTACH_HEADER)
  const listed = at === -1 ? [] : text.slice(at + ATTACH_HEADER.length).split('\n').map((x) => x.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
  if (at !== -1) text = text.slice(0, at)
  return withAttachments(text.trim(), [...new Set([...pictures, ...listed])])
}

/** Long prompts typed via paste are stored wrapped in <pasted_content id="…"> tags; show just the text. */
export const unwrapPaste = (t: string) =>
  t.replace(/<pasted_content\b[^>]*>\n?/g, '').replace(/\n?<\/pasted_content\b[^>]*>/g, '').trim()

function readFrom(path: string, offset: number): { text: string; size: number } {
  const size = statSync(path).size
  if (size <= offset) return { text: '', size }
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    return { text: buf.toString('utf8'), size }
  } finally {
    closeSync(fd)
  }
}

// message id + request id already counted, per transcript (Claude Code writes one line per content block, each
// carrying the same usage; counting every line overstates tokens ~4x)
const seen = new Map<string, Set<string>>()

/** Read new lines of every agent's transcript. Cheap: only the bytes appended since the last call. */
export function pollTranscripts() {
  for (const row of agentsRepo.all()) {
    const path = transcriptPath(row)
    if (!existsSync(path)) continue
    const offset = offsetsRepo.get(path)
    const { text } = readFrom(path, offset)
    if (!text) continue
    // keep a trailing partial line for next time
    const end = text.lastIndexOf('\n')
    if (end < 0) continue
    const consumed = Buffer.byteLength(text.slice(0, end + 1))
    offsetsRepo.set(path, offset + consumed)
    const ids = seen.get(path) ?? new Set<string>()
    seen.set(path, ids)

    for (const raw of text.slice(0, end).split('\n')) {
      let l: Line
      try {
        l = JSON.parse(raw)
      } catch {
        continue
      }
      if (l.type === 'ai-title' && l.aiTitle) updateRuntime(row.id, (rt) => ({ ...rt, title: l.aiTitle }))
      if (l.type === 'permission-mode' && l.permissionMode)
        updateRuntime(row.id, (rt) => ({ ...rt, permissionMode: l.permissionMode as LiveMode }))
      const u = l.type === 'assistant' ? l.message?.usage : undefined
      if (!u) continue
      const key = `${l.message?.id}:${l.requestId}`
      if (ids.has(key)) continue
      ids.add(key)
      if (ids.size > 5000) ids.delete(ids.values().next().value!)
      const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      const output = u.output_tokens ?? 0
      const date = dayFmt.format(l.timestamp ? new Date(l.timestamp) : new Date())
      usageRepo.add(date, row.id, input, output)
      publish({ type: 'usage', date, agentId: row.id, input, output })
    }
  }
}

// ── Chat tab ──

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s)

function toolSummary(name: string, input: Record<string, unknown>) {
  if (name === 'Bash') return String(input.command ?? '')
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.url === 'string') return input.url
  if (typeof input.description === 'string') return input.description
  return ''
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  return ''
}

/** Last `limit` conversation items of an agent, simplified for rendering. Reads only the tail of the file. */
export function readChat(row: AgentRow, limit = 200): ChatItem[] {
  const path = transcriptPath(row)
  if (!existsSync(path)) return []
  const size = statSync(path).size
  const { text } = readFrom(path, Math.max(0, size - 4_000_000))
  const items: ChatItem[] = []
  const seenIds = new Set<string>()
  // the owner's last message: pictures stored in a later line of the same prompt are added to it
  let owner: { index: number; promptId?: string; said: string[]; pictures: string[] } | null = null
  for (const raw of text.split('\n')) {
    let l: Line
    try {
      l = JSON.parse(raw)
    } catch {
      continue
    }
    if (l.isSidechain || !l.message) continue
    const at = l.timestamp ? Date.parse(l.timestamp) : 0
    const content = l.message.content
    if (l.type === 'user') {
      if (typeof content === 'string') {
        // skip Claude Code's internal wrappers (command output, reminders)
        const text = unwrapPaste(content)
        if (!text.startsWith('<')) {
          owner = { index: items.length, promptId: l.promptId, said: [content], pictures: [] }
          items.push({ kind: 'user', id: l.uuid ?? String(at), at, text: clip(ownerMessage([content])) })
        }
      } else if (Array.isArray(content)) {
        const said: string[] = []
        const pictures: string[] = []
        for (const b of content) {
          if (b?.type === 'tool_result')
            items.push({
              kind: 'tool-result',
              id: `${b.tool_use_id}:r`,
              at,
              toolUseId: b.tool_use_id,
              ok: !b.is_error,
              text: clip(textOf(b.content), 1500),
            })
          else if (b?.type === 'text' && typeof b.text === 'string') {
            // a picture Claude Code attached from a pasted path comes as its own "[Image: source: <path>]" block
            const pic = /^\[Image: source: (.+)\]$/.exec(b.text.trim())
            if (pic) pictures.push(pic[1])
            else if (!b.text.startsWith('<') || b.text.startsWith('<pasted_content')) said.push(b.text)
          }
        }
        const last = owner ? items[owner.index] : undefined
        if (!said.length && pictures.length && owner && last?.kind === 'user' && (!l.promptId || l.promptId === owner.promptId)) {
          owner.pictures.push(...pictures)
          last.text = clip(ownerMessage(owner.said, owner.pictures))
        } else {
          const text = ownerMessage(said, pictures)
          if (text) {
            owner = { index: items.length, promptId: l.promptId, said, pictures }
            items.push({ kind: 'user', id: `${l.uuid}:u`, at, text: clip(text) })
          }
        }
      }
    } else if (l.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) {
          const id = `${l.message.id}:t:${b.text.length}`
          if (seenIds.has(id)) continue
          seenIds.add(id)
          items.push({ kind: 'assistant', id, at, text: clip(b.text), model: l.message.model })
        } else if (b?.type === 'tool_use') {
          if (seenIds.has(b.id)) continue
          seenIds.add(b.id)
          items.push({ kind: 'tool', id: b.id, at, tool: b.name, summary: clip(toolSummary(b.name, b.input ?? {}), 300), input: b.input })
        }
      }
    }
  }
  return items.slice(-limit)
}
