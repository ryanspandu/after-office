import { useEffect, useMemo, useState } from 'react'
import { LuDownload, LuFile, LuFileText, LuFileX } from 'react-icons/lu'
import { useModalMaximize } from './Maximize'
import { Markdown } from './FollowUps'
import { Modal } from './Modal'
import type { Attachment } from '@after-office/shared'
import { api } from '../state/auth'

// Files an agent made or pointed to: shown under its chat messages and reports, with a preview for pictures and a
// download for everything. The server decides which files may be shown (only inside the agent's folders).

export const fileUrl = (agentId: string, path: string, inline = false) =>
  `/api/agents/${agentId}/file?${new URLSearchParams({ path, ...(inline ? { inline: '1' } : {}) })}`

export const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Text files shown right here instead of downloaded: Markdown rendered, the rest as plain text. */
const TEXT_RE = /\.(md|markdown|mdx|txt|text|csv|tsv|json|jsonl|log|ya?ml|toml|ini|env\.example|xml|html?|css|js|jsx|ts|tsx|py|sh|sql|go|rs|rb|php|java|kt|swift)$/i
const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p)
const PREVIEW_MAX = 2 * 1024 * 1024
export const canPreview = (f: Attachment) => !f.image && TEXT_RE.test(f.path) && f.size <= PREVIEW_MAX

/** Where a file is fetched from: the agent's file route, or (reports) the report's own. */
export type UrlFor = (path: string, inline?: boolean) => string

export function Attachments({ agentId, files, urlFor }: { agentId: string; files: Attachment[]; urlFor?: UrlFor }) {
  const [preview, setPreview] = useState<Attachment | null>(null)
  if (!files.length) return null
  const url: UrlFor = urlFor ?? ((path, inline) => fileUrl(agentId, path, inline))
  return (
    <div className="attachments">
      {preview && <FilePreview file={preview} url={url(preview.path)} onClose={() => setPreview(null)} />}
      {files.map((f) =>
        f.missing ? (
          <div key={f.path} className="attachment attachment--gone" data-tip={f.path}>
            <span className="attachment__icon">
              <LuFileX />
            </span>
            <span className="attachment__meta">
              <span className="attachment__name truncate">{baseName(f.path)}</span>
              <span className="attachment__size">This file no longer exists</span>
            </span>
          </div>
        ) : (
        <div key={f.path} className={`attachment${f.image ? ' attachment--image' : ''}`} data-tip={f.path}>
          {f.image ? (
            <a className="attachment__preview" href={url(f.path, true)} target="_blank" rel="noreferrer noopener">
              <img src={url(f.path, true)} alt={baseName(f.path)} loading="lazy" />
            </a>
          ) : (
            <span className="attachment__icon">{/\.(md|txt|csv|json|log)$/i.test(f.path) ? <LuFileText /> : <LuFile />}</span>
          )}
          {canPreview(f) ? (
            <button type="button" className="attachment__meta attachment__open" onClick={() => setPreview(f)} aria-label={`Preview ${baseName(f.path)}`}>
              <span className="attachment__name truncate">{baseName(f.path)}</span>
              <span className="attachment__size">{formatSize(f.size)} · preview</span>
            </button>
          ) : (
            <span className="attachment__meta">
              <span className="attachment__name truncate">{baseName(f.path)}</span>
              <span className="attachment__size">{formatSize(f.size)}</span>
            </span>
          )}
          <a className="icon-btn small ghost" href={url(f.path)} download={baseName(f.path)} aria-label={`Download ${baseName(f.path)}`} data-tip="Download">
            <LuDownload />
          </a>
        </div>
        ),
      )}
    </div>
  )
}

/** A text file the agent made, read through the same checked file route as downloads. */
export function FilePreview({ agentId, file, onClose, url }: { agentId?: string; file: Attachment; onClose: () => void; url?: string }) {
  // the file's download address: an agent's file route, or another (e.g. the Projects tab's file manager)
  const src = url ?? fileUrl(agentId ?? '', file.path)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // full size: the whole window, for long documents and wide tables
  const max = useModalMaximize(820)
  useEffect(() => {
    let gone = false
    api(src)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not open the file (${r.status})`)
        return r.text()
      })
      .then((t) => !gone && setText(t))
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
  }, [src])
  const body = text === null ? null : /\.json$/i.test(file.path) ? pretty(text) : text
  return (
    <Modal open onClose={onClose} title={baseName(file.path)} description={file.path.replace(/^\/(Users|home)\/[^/]+/, '~')} {...max.modalProps}>
      <div className="modal__body file-preview" ref={max.bodyRef}>
        {error ? (
          <div className="row__error">{error}</div>
        ) : body === null ? (
          <div className="muted">Loading…</div>
        ) : isMarkdown(file.path) ? (
          <div className="file-preview__md">
            <Markdown text={body} />
          </div>
        ) : (
          <pre className="file-preview__text">{body}</pre>
        )}
        <footer className="modal__foot">
          <span className="muted">{formatSize(file.size)}</span>
          <span className="grow" />
          <button
            className="small"
            onClick={() => saveUrl(src, baseName(file.path))}
          >
            <LuDownload /> Download
          </button>
          <button className="small" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function pretty(json: string) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

/** "~/a/b.md", "/Users/x/a/b.md" or "b.md" as written, against a file's full path. */
export function sameFile(written: string, abs: string) {
  if (written === abs) return true
  const tail = written.replace(/^~(?=\/)/, '').replace(/^\.\//, '')
  return abs.endsWith(tail.startsWith('/') ? tail : `/${tail}`)
}

/** Save a file the agent may share (the browser's download, through the checked file route). */
export function downloadFile(agentId: string, path: string) {
  saveUrl(fileUrl(agentId, path), baseName(path))
}

export function saveUrl(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

/**
 * Which of these paths are files the agent may share (one request for a whole chat; unchanged lists aren't asked
 * again). Returns a lookup by the path as written.
 */
/** Which of these paths are files the dashboard may show. `markMissing`: the others come back as gone (once checked). */
export function useAgentFiles(agentId: string, paths: string[], markMissing = false) {
  const key = useMemo(() => [...new Set(paths)].sort().join('\n'), [paths])
  const [found, setFound] = useState<Map<string, Attachment>>(new Map())
  useEffect(() => {
    if (!key) return setFound(new Map())
    let gone = false
    api(`/api/agents/${agentId}/files/stat`, { method: 'POST', body: JSON.stringify({ paths: key.split('\n') }) })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Attachment[]) => {
        if (gone) return
        // the server answers with full paths; the agent may have written ~/… or a relative one
        const byWritten = new Map<string, Attachment>()
        for (const p of key.split('\n')) {
          const f = list.find((x) => sameFile(p, x.path))
          if (f) byWritten.set(p, f)
          else if (markMissing) byWritten.set(p, { path: p, size: 0, missing: true })
        }
        setFound(byWritten)
      })
      .catch(() => {})
    return () => void (gone = true)
  }, [agentId, key])
  return found
}

/** A report's attachments as they are now: the server marks the ones that are gone (also after the agent left). */
export function useReportFiles(reportId: string, files: Attachment[] | undefined) {
  const [now, setNow] = useState<Attachment[]>(files ?? [])
  const key = (files ?? []).map((f) => f.path).join('\n')
  useEffect(() => {
    setNow(files ?? [])
    if (!key) return
    let gone = false
    api(`/api/reports/${reportId}/files`)
      .then((r) => (r.ok ? r.json() : null))
      .then((list: Attachment[] | null) => !gone && list && setNow(list))
      .catch(() => {})
    return () => void (gone = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, key])
  return now
}

export const reportUrl =
  (reportId: string): UrlFor =>
  (path, inline) =>
    `/api/reports/${reportId}/file?${new URLSearchParams({ path, ...(inline ? { inline: '1' } : {}) })}`
