import { lstatSync, realpathSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Attachment, WorkReport } from '@after-office/shared'
import { agentsRepo, extraDirsOf, type AgentRow } from '../db'
import { AGENT_HOME, PROJECTS_DIR, PLANS_DIR } from '../fsroots'

// Files an agent made or pointed to (attachments in its chat and reports). Only files inside the agent's own folder,
// the project folders it was given, or the office's projects folder can be looked at or downloaded (the manager's
// also cover every agent's folders: its reports point at its team's work), never through a symlink, and nothing
// bigger than MAX_BYTES. The dashboard's own files (its .env, database) are outside every agent folder.

export const MAX_BYTES = 100 * 1024 * 1024
/** …except a video (an owner's chat attachment can be one this big: agents/uploads.ts MAX_VIDEO_BYTES) */
const MAX_VIDEO = 500 * 1024 * 1024
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|3gp)$/i
const maxBytes = (path: string) => (VIDEO_RE.test(path) ? MAX_VIDEO : MAX_BYTES)
export const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'])

function allowedRoots(row: AgentRow) {
  const roots: string[] = []
  const team = row.kind === 'manager' ? agentsRepo.all().filter((a) => a.id !== row.id) : []
  // (the plans agents write outside the projects: anyone's, like the projects folder)
  for (const d of [row.cwd, ...extraDirsOf(row), PROJECTS_DIR, PLANS_DIR, ...team.flatMap((a) => [a.cwd, ...extraDirsOf(a)])]) {
    try {
      roots.push(realpathSync(d))
    } catch {
      // folder gone
    }
  }
  return roots
}

/** The file behind `path` (absolute, ~/…, or relative to the agent's folder) if the agent's files may include it. */
export function agentFile(row: AgentRow, path: string): (Attachment & { real: string }) | null {
  if (!path || path.length > 4096 || path.includes('\0')) return null
  const abs = path.startsWith('~/') ? join(AGENT_HOME, path.slice(2)) : isAbsolute(path) ? path : resolve(row.cwd, path)
  try {
    const st = lstatSync(abs)
    if (!st.isFile() || st.size > maxBytes(abs)) return null // no symlinks, devices, folders
    const real = realpathSync(abs)
    if (!allowedRoots(row).some((r) => real === r || real.startsWith(r + sep))) return null
    return { path: abs, real, size: st.size, ...(IMAGE.has(extname(real).toLowerCase()) ? { image: true } : {}) }
  } catch {
    return null
  }
}

/** Which of these paths are files the dashboard may show (deduplicated, at most `limit`). */
export function agentFiles(row: AgentRow, paths: Iterable<string>, limit = 20): Attachment[] {
  const out: Attachment[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    const f = agentFile(row, p)
    if (!f || seen.has(f.real)) continue
    seen.add(f.real)
    out.push({ path: f.path, size: f.size, ...(f.image ? { image: true } : {}) })
    if (out.length >= limit) break
  }
  return out
}

/** Files that tools wrote, from a hook's tool_input (Write, Edit, MultiEdit, NotebookEdit). */
export function writtenFile(tool: string | undefined, input: Record<string, unknown> | undefined) {
  if (!tool || !input || !/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return null
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' ? p : null
}

/**
 * Serve a file an agent made. It's untrusted: opened directly it can't run scripts or reach anything (SVG, HTML…).
 * Pictures and PDFs may show in the page (`inline`); everything else downloads.
 */
export function fileResponse(real: string, size: number, inline: boolean, range?: string | null) {
  const file = Bun.file(real)
  const name = basename(real).replace(/["\\\r\n]/g, '_')
  const video = VIDEO_RE.test(real)
  const show = inline && (IMAGE.has(extname(real).toLowerCase()) || /\.pdf$/i.test(real) || video)
  // a video plays in the page: a part at a time (seeking; Safari asks for parts only)
  const part = video && inline ? /^bytes=(\d*)-(\d*)$/.exec(range ?? '') : null
  if (part && (part[1] || part[2])) {
    const start = part[1] ? Number(part[1]) : Math.max(0, size - Number(part[2]))
    const end = part[1] && part[2] ? Math.min(size - 1, Number(part[2])) : size - 1
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        'content-type': file.type || 'video/mp4',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(real))}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  }
  return new Response(file, {
    headers: {
      ...(video ? { 'accept-ranges': 'bytes' } : {}),
      'content-type': file.type || 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `${show ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(basename(real))}`,
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}

/**
 * A file a report lists: it was checked when the report was filed, so it stays reachable through the report even
 * after its agent is gone, as long as it's still there (a real file, not replaced by a symlink). Nothing else.
 */
export function reportFile(report: WorkReport, path: string): { real: string; size: number } | null {
  const listed = report.files?.find((f) => f.path === path)
  if (!listed) return null
  try {
    const st = lstatSync(listed.path)
    if (!st.isFile() || st.size > maxBytes(listed.path)) return null
    return { real: realpathSync(listed.path), size: st.size }
  } catch {
    return null
  }
}

/** A report's attachments, each marked missing if it has gone since (deleted, or its folder removed). */
export const reportFiles = (report: WorkReport): Attachment[] =>
  (report.files ?? []).map((f) => (reportFile(report, f.path) ? f : { ...f, missing: true }))
