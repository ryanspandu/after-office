import { appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { Attachment } from '@after-office/shared'
import { DATA_DIR, type AgentRow } from '../db'
import { AgentError } from './errors'
import { IMAGE } from './files'
import { isVideo, makeContactSheets, stagedSheets } from './videoFrames'

// Files the owner attaches in an agent's chat. Attaching only stages a file in the dashboard's own data folder
// (DATA_DIR/staging/<agent>/<id>/, which no agent can read); sending the message moves it into the agent's folder
// (uploads/<date>/) so it can open it like any of its files (Claude Code reads pictures too). A file removed from the
// message, or never sent (chat closed, page left), is deleted; leftovers go after STAGED_MAX_AGE_MS. The message names
// the files in a block the dashboard recognises (see withAttachments / web ui/agent/chatAttachments.tsx).

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const MAX_UPLOADS = 10
/** A video comes in pieces (stageChunk), up to this size, and gets sheets of its frames (agents/videoFrames.ts). */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024
/** One piece of a video: well under the server's (and a proxy's) request size limits. */
export const CHUNK_BYTES = 8 * 1024 * 1024

/** "My photo (1).PNG" → "My photo (1).PNG"; anything odd (slashes, control characters, dots in front) is replaced. */
export function safeName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(-100)
  return clean || 'file'
}

const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Save one attached file in <agent folder>/uploads/<date>/. Never overwrites: a name that's taken gets " (2)", " (3)"….
 * The folder must really be inside the agent's folder (no symlink leading elsewhere), and the file is created fresh
 * (O_EXCL | O_NOFOLLOW).
 */
export function saveUpload(row: AgentRow, name: string, data: Uint8Array, now = new Date()): Attachment {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new AgentError(`${name} is bigger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  return writeNew(row, join('uploads', day(now)), name, (fd) => void writeSync(fd, data))
}

/** A folder inside the agent's folder (made if needed), checked to really be in there (no symlink out). */
function insideAgent(row: AgentRow, rel: string) {
  const dir = join(row.cwd, rel)
  mkdirSync(dir, { recursive: true })
  const root = realpathSync(row.cwd)
  const real = realpathSync(dir)
  if (real !== root && !real.startsWith(root + sep)) throw new AgentError(`${dir} leads outside the agent's folder`, 409)
  return dir
}

/** A new file in `rel` (inside the agent's folder), never overwriting: "name (2).ext"… Created fresh (O_EXCL |
 *  O_NOFOLLOW) and filled by `fill`. */
function writeNew(row: AgentRow, rel: string, name: string, fill: (fd: number) => void): Attachment {
  const dir = insideAgent(row, rel)
  const file = safeName(name)
  const ext = extname(file)
  const stem = file.slice(0, file.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, n === 1 ? file : `${stem} (${n})${ext}`)
    let fd: number
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o664)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    try {
      fill(fd)
    } finally {
      closeSync(fd)
    }
    return { path, size: statSync(path).size, ...(IMAGE.has(ext.toLowerCase()) ? { image: true } : {}) }
  }
  throw new AgentError(`Too many files called ${file} today`, 409)
}

/** Copy a (possibly big) file into fd a piece at a time, never all of it in memory. */
function copyInto(fd: number, src: string) {
  const from = openSync(src, 'r')
  const buf = Buffer.allocUnsafe(CHUNK_BYTES)
  try {
    for (;;) {
      const n = readSync(from, buf, 0, buf.length, null)
      if (!n) break
      writeSync(fd, buf, 0, n)
    }
  } finally {
    closeSync(from)
  }
}

/** The header of the block that lists attached files at the end of a message (the dashboard shows them as previews). */
export const ATTACH_HEADER = '[Attached files]'

/** The owner's text plus the attached files, as the agent receives it. */
export function withAttachments(text: string, paths: string[]) {
  if (!paths.length) return text
  return [text.trim(), `${ATTACH_HEADER}\n${paths.map((p) => `- ${p}`).join('\n')}`].filter(Boolean).join('\n\n')
}

// ── staging: attached, not sent yet ──

const STAGING = join(DATA_DIR, 'staging')
export const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const stagedDir = (agentId: string, id: string) => {
  if (!ID_RE.test(id) || !/^[\w-]{1,80}$/.test(agentId)) throw new AgentError('No such attachment', 404)
  return join(STAGING, agentId, id)
}

export interface StagedUpload {
  id: string
  name: string
  size: number
  image?: boolean
  video?: boolean
  /** a video's contact sheets made (0: none, e.g. no ffmpeg on the server) */
  sheets?: number
}

// a staged attachment's folder: the file itself, plus (a video) frames/ with its sheets, (being uploaded) meta.json
// and <name>.part
const FRAMES = 'frames'
const META = 'meta.json'
const fileIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).find((f) => f !== FRAMES && f !== META && !f.endsWith('.part')) : undefined)

async function staged(id: string, dir: string, file: string): Promise<StagedUpload> {
  const size = statSync(join(dir, file)).size
  if (!isVideo(file)) return { id, name: file, size, ...(IMAGE.has(extname(file).toLowerCase()) ? { image: true } : {}) }
  const sheets = await makeContactSheets(join(dir, file), join(dir, FRAMES)).catch(() => [])
  return { id, name: file, size, video: true, sheets: sheets.length }
}

/** Keep an attached file until the message is sent (or it's removed). A video gets its frame sheets now. */
export async function stageUpload(agentId: string, name: string, data: Uint8Array): Promise<StagedUpload> {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new AgentError(`${name} is bigger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  const id = crypto.randomUUID()
  const file = safeName(name)
  const dir = stagedDir(agentId, id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, file), data, { mode: 0o600 })
  return staged(id, dir, file)
}

/** A video sent in pieces: its place, before the first piece. */
export function startChunked(agentId: string, name: string, size: number) {
  const file = safeName(name)
  if (!isVideo(file)) throw new AgentError(`Only videos come in pieces; ${file} must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller`, 400)
  if (!Number.isFinite(size) || size <= 0) throw new AgentError(`${file} is empty`, 400)
  if (size > MAX_VIDEO_BYTES) throw new AgentError(`${file} is bigger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB`, 413)
  const id = crypto.randomUUID()
  const dir = stagedDir(agentId, id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, META), JSON.stringify({ name: file, size }), { mode: 0o600 })
  writeFileSync(join(dir, `${file}.part`), new Uint8Array(), { mode: 0o600 })
  return { id, name: file }
}

const metaOf = (dir: string) => {
  try {
    return JSON.parse(readFileSync(join(dir, META), 'utf8')) as { name: string; size: number }
  } catch {
    throw new AgentError('No such upload (it may have expired): attach it again', 404)
  }
}

/** One piece, at `offset` (pieces come in order; one sent twice after a retry is taken once). */
export function stageChunk(agentId: string, id: string, offset: number, data: Uint8Array) {
  const dir = stagedDir(agentId, id)
  const meta = metaOf(dir)
  const part = join(dir, `${meta.name}.part`)
  const have = statSync(part).size
  if (offset + data.byteLength <= have) return { received: have }
  if (offset !== have) throw new AgentError(`Expected the piece at ${have}, got ${offset}`, 409)
  if (data.byteLength > CHUNK_BYTES || have + data.byteLength > meta.size) throw new AgentError('That piece is too big', 413)
  appendFileSync(part, data)
  return { received: have + data.byteLength }
}

/** All pieces in: the video is staged (and its frame sheets made). */
export async function finishChunked(agentId: string, id: string): Promise<StagedUpload> {
  const dir = stagedDir(agentId, id)
  const meta = metaOf(dir)
  const part = join(dir, `${meta.name}.part`)
  if (statSync(part).size !== meta.size) throw new AgentError(`${meta.name} didn't arrive whole: attach it again`, 409)
  renameSync(part, join(dir, meta.name))
  rmSync(join(dir, META), { force: true })
  return staged(id, dir, meta.name)
}

/** Removed from the message before sending: gone. */
export function discardStaged(agentId: string, id: string) {
  rmSync(stagedDir(agentId, id), { recursive: true, force: true })
}

/** Sent: into the agent's folder (uploads/<date>/), out of staging. A video's frame sheets go next to it, in
 *  "<video>-frames/" (their paths in `sheets`). */
export function commitStaged(row: AgentRow, id: string, now = new Date()): Attachment & { sheets?: string[] } {
  const dir = stagedDir(row.id, id)
  const name = fileIn(dir)
  if (!name) throw new AgentError('An attached file is gone; attach it again', 400)
  const rel = join('uploads', day(now))
  const saved = writeNew(row, rel, name, (fd) => copyInto(fd, join(dir, name)))
  const frames = stagedSheets(join(dir, FRAMES))
  let sheets: string[] | undefined
  if (frames.length) {
    const video = saved.path.slice(saved.path.lastIndexOf(sep) + 1)
    const into = join(rel, `${video.slice(0, video.length - extname(video).length)}-frames`)
    sheets = frames.map((f) => writeNew(row, into, f, (fd) => copyInto(fd, join(dir, FRAMES, f))).path)
  }
  rmSync(dir, { recursive: true, force: true })
  return { ...saved, ...(sheets ? { sheets } : {}) }
}

/** The paths a sent message lists: each file, and a video's frame sheets after it. */
export const committedPaths = (list: (Attachment & { sheets?: string[] })[]) => list.flatMap((a) => [a.path, ...(a.sheets ?? [])])

/** Attachments never sent (the page was closed mid-message…): deleted once older than maxAge. */
export function sweepStaged(maxAge = STAGED_MAX_AGE_MS, now = Date.now()) {
  if (!existsSync(STAGING)) return 0
  let removed = 0
  for (const agent of readdirSync(STAGING)) {
    const agentDir = join(STAGING, agent)
    for (const id of readdirSync(agentDir)) {
      const dir = join(agentDir, id)
      if (now - statSync(dir).mtimeMs > maxAge) {
        rmSync(dir, { recursive: true, force: true })
        removed++
      }
    }
    if (!readdirSync(agentDir).length) rmSync(agentDir, { recursive: true, force: true })
  }
  return removed
}
