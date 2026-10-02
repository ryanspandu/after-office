import { accessSync, constants, openSync, readSync, closeSync, statSync } from 'node:fs'
import { CLAUDE_PROJECTS_DIR } from '../fsroots'
import { join, dirname } from 'node:path'
import { ISOLATED } from './env'
import { runAsAgent } from './asagent'
import type { ChatItem, LiveMode } from '@after-office/shared'
import { agentsRepo, offsetsRepo, sideSessionsRepo, usageRepo, type AgentRow } from '../db'
import { publish, runtimeOf, sideRuntimeOf, updateRuntime, updateSideRuntime } from './registry'
import type { Runtime } from './state'
import { ATTACH_HEADER, withAttachments } from './uploads'

// Claude Code writes every session to ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session-id>.jsonl.
// We read it incrementally for token usage and title/mode changes, and on demand for the Chat tab.

const TZ = process.env.OFFICE_TZ ?? 'Asia/Jakarta'
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** `key`: one of its side sessions (unset: its main session). */
export function transcriptPath(row: AgentRow, key = '') {
  const dir = join(CLAUDE_PROJECTS_DIR, row.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!key) return runtimeOf(row.id).transcriptPath ?? join(dir, `${row.session_id}.jsonl`)
  const side = sideSessionsRepo.get(row.id, key)
  return sideRuntimeOf(row.id, key).transcriptPath ?? join(dir, `${side?.session_id ?? 'none'}.jsonl`)
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

// On the hardened server the dashboard reads the agents' transcripts through an ACL (setup-vps.sh). Claude Code
// writes new ones (a new agent, a new session) with mode 0700 / 0600, and a file's group bits cap its ACL (the
// "mask"), so the dashboard can't read it: that chat stays empty and its tokens aren't counted. The agents' user
// widens the mask again, on that agent's folder of transcripts only; the next poll reads it.
// Not with chmod: the folders carry the setgid bit (projects/ is 2750, new folders inherit it) and the agents' service
// runs with RestrictSUIDSGID, which refuses any chmod of a setgid folder ("Operation not permitted"). setfacl changes
// the mask without touching the mode's special bits.
const unlocking = new Map<string, number>()
function unlock(path: string) {
  if (!ISOLATED || Date.now() - (unlocking.get(path) ?? 0) < 30_000) return
  unlocking.set(path, Date.now())
  const dir = dirname(path)
  if (dirname(dir) !== CLAUDE_PROJECTS_DIR) return // not one of the agents' transcript folders
  // (no setfacl: at least the files, which have no setgid bit)
  const script = 'setfacl -R -m m::rX "$1" || find "$1" -type f -exec chmod g+r {} +'
  void runAsAgent(['sh', '-c', script, 'unlock', dir], { cwd: CLAUDE_PROJECTS_DIR, timeoutMs: 30_000, mergeStderr: true })
    .then((r) => {
      if (r.code !== 0) console.warn(`[transcripts] could not open ${dir} to the dashboard (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${r.out.trim().slice(0, 300)}`)
      else console.log(`[transcripts] opened ${dir} to the dashboard`)
    })
    .catch((e) => console.warn(`[transcripts] could not open ${dir} to the dashboard:`, (e as Error).message))
}

/**
 * Can the dashboard read this transcript? (If not because of its mode: asks the agents' user to fix it.) A new agent's
 * folder of transcripts can be the one locked (Claude Code makes it 0700): then the file looks missing (existsSync is
 * false), but access() says EACCES, which is what asks for the fix.
 */
function readable(path: string) {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EACCES') unlock(path)
    return false
  }
}

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
  // every agent's main session, and the side sessions that are open (their tokens count for the agent too)
  const sessions = agentsRepo.all().flatMap((row) => [
    { row, key: '' },
    ...sideSessionsRepo
      .forAgent(row.id)
      .filter((s) => !s.closed_at)
      .map((s) => ({ row, key: s.key })),
  ])
  for (const { row, key: sessionKey } of sessions) {
    const update = (fn: (rt: Runtime) => Runtime) => (sessionKey ? updateSideRuntime(row.id, sessionKey, fn) : updateRuntime(row.id, fn))
    const path = transcriptPath(row, sessionKey)
    if (!readable(path)) continue
    const offset = offsetsRepo.get(path)
    let text: string
    try {
      text = readFrom(path, offset).text
    } catch {
      continue // one unreadable transcript doesn't stop the others
    }
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
      if (l.type === 'ai-title' && l.aiTitle) update((rt) => ({ ...rt, title: l.aiTitle }))
      if (l.type === 'ai-title' && l.aiTitle && sessionKey) sideSessionsRepo.update(row.id, sessionKey, { title: l.aiTitle })
      if (l.type === 'permission-mode' && l.permissionMode) update((rt) => ({ ...rt, permissionMode: l.permissionMode as LiveMode }))
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
export function readChat(row: AgentRow, limit = 200, key = ''): ChatItem[] {
  const path = transcriptPath(row, key)
  if (!readable(path)) return []
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
