import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { Attachment } from '@after-office/shared'
import { DATA_DIR, type AgentRow } from '../db'
import { AgentError } from './errors'
import { IMAGE } from './files'

// Files the owner attaches in an agent's chat. Attaching only stages a file in the dashboard's own data folder
// (DATA_DIR/staging/<agent>/<id>/, which no agent can read); sending the message moves it into the agent's folder
// (uploads/<date>/) so it can open it like any of its files (Claude Code reads pictures too). A file removed from the
// message, or never sent (chat closed, page left), is deleted; leftovers go after STAGED_MAX_AGE_MS. The message names
// the files in a block the dashboard recognises (see withAttachments / web ui/agent/chatAttachments.tsx).

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const MAX_UPLOADS = 10

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
  const dir = join(row.cwd, 'uploads', day(now))
  mkdirSync(dir, { recursive: true })
  const root = realpathSync(row.cwd)
  const real = realpathSync(dir)
  if (real !== root && !real.startsWith(root + sep)) throw new AgentError(`${dir} leads outside the agent's folder`, 409)
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
      writeSync(fd, data)
    } finally {
      closeSync(fd)
    }
    return { path, size: data.byteLength, ...(IMAGE.has(ext.toLowerCase()) ? { image: true } : {}) }
  }
  throw new AgentError(`Too many files called ${file} today`, 409)
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
}

/** Keep an attached file until the message is sent (or it's removed). */
export function stageUpload(agentId: string, name: string, data: Uint8Array): StagedUpload {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new AgentError(`${name} is bigger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413)
  const id = crypto.randomUUID()
  const file = safeName(name)
  const dir = stagedDir(agentId, id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, file), data, { mode: 0o600 })
  return { id, name: file, size: data.byteLength, ...(IMAGE.has(extname(file).toLowerCase()) ? { image: true } : {}) }
}

/** Removed from the message before sending: gone. */
export function discardStaged(agentId: string, id: string) {
  rmSync(stagedDir(agentId, id), { recursive: true, force: true })
}

/** Sent: into the agent's folder (uploads/<date>/), out of staging. */
export function commitStaged(row: AgentRow, id: string, now = new Date()): Attachment {
  const dir = stagedDir(row.id, id)
  const name = existsSync(dir) ? readdirSync(dir)[0] : undefined
  if (!name) throw new AgentError('An attached file is gone; attach it again', 400)
  const saved = saveUpload(row, name, readFileSync(join(dir, name)), now)
  rmSync(dir, { recursive: true, force: true })
  return saved
}

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
