import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { LuDownload, LuFile, LuFileText, LuFileX, LuSheet, LuTable } from 'react-icons/lu'
import { CsvTable } from './preview/CsvTable'
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

/** Text files shown right here instead of downloaded: Markdown rendered, sheets as a table, the rest as plain text. */
const TEXT_RE = /\.(md|markdown|mdx|txt|text|csv|tsv|json|jsonl|log|ya?ml|toml|ini|env\.example|xml|html?|css|js|jsx|ts|tsx|py|sh|sql|go|rs|rb|php|java|kt|swift)$/i
const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p)
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i
type Kind = 'markdown' | 'sheet' | 'text' | 'pdf' | 'docx' | 'image'
/** How a file is previewed here, if it is. */
export function previewKind(path: string): Kind | null {
  if (isMarkdown(path)) return 'markdown'
  if (/\.(csv|tsv)$/i.test(path)) return 'sheet'
  if (TEXT_RE.test(path)) return 'text'
  if (/\.pdf$/i.test(path)) return 'pdf'
  if (/\.docx$/i.test(path)) return 'docx'
  if (IMAGE_RE.test(path)) return 'image'
  return null
}
const TEXT_MAX = 2 * 1024 * 1024
const FILE_MAX = 30 * 1024 * 1024
export const canPreview = (f: Pick<Attachment, 'path' | 'size'>) => {
  const kind = previewKind(f.path)
  return !!kind && f.size <= (kind === 'markdown' || kind === 'text' || kind === 'sheet' ? TEXT_MAX : FILE_MAX)
}
// the heavy viewers load only when such a file is opened
const PdfView = lazy(() => import('./preview/PdfView'))
const DocxView = lazy(() => import('./preview/DocxView'))

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
            <button type="button" className="attachment__preview" onClick={() => setPreview(f)} aria-label={`Preview ${baseName(f.path)}`}>
              <img src={url(f.path, true)} alt={baseName(f.path)} loading="lazy" />
            </button>
          ) : (
            <span className="attachment__icon">{/\.(csv|tsv)$/i.test(f.path) ? <LuSheet /> : /\.(md|txt|json|log|pdf|docx)$/i.test(f.path) ? <LuFileText /> : <LuFile />}</span>
          )}
          {!f.image && canPreview(f) ? (
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

/**
 * A file the agent made, previewed through the same checked file route as downloads: text (Markdown rendered, sheets as
 * a table), PDFs page by page, Word documents, pictures.
 */
export function FilePreview({ agentId, file, onClose, url }: { agentId?: string; file: Attachment; onClose: () => void; url?: string }) {
  // the file's download address: an agent's file route, or another (e.g. the Projects tab's file manager)
  const src = url ?? fileUrl(agentId ?? '', file.path)
  const kind = previewKind(file.path) ?? 'text'
  const binary = kind === 'pdf' || kind === 'docx' || kind === 'image'
  const [text, setText] = useState<string | null>(null)
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  // a sheet: the table, or the file as it is
  const [raw, setRaw] = useState(false)
  // full size: the whole window, for long documents and wide tables
  const max = useModalMaximize(kind === 'sheet' || kind === 'pdf' || kind === 'docx' ? 960 : 820)
  useEffect(() => {
    let gone = false
    api(src)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not open the file (${r.status})`)
        if (binary) {
          const buf = await r.arrayBuffer()
          if (!gone) setData(buf)
        } else {
          const t = await r.text()
          if (!gone) setText(t)
        }
      })
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
  }, [src, binary])
  // a picture: shown from memory (the file route sends a download)
  const imageUrl = useMemo(() => (kind === 'image' && data ? URL.createObjectURL(new Blob([data], { type: imageType(file.path) })) : null), [kind, data, file.path])
  useEffect(() => () => void (imageUrl && URL.revokeObjectURL(imageUrl)), [imageUrl])
  const body = text === null ? null : /\.json$/i.test(file.path) ? pretty(text) : text
  const loading = <div className="muted">Loading…</div>
  return (
    <Modal open onClose={onClose} title={baseName(file.path)} description={file.path.replace(/^\/(Users|home)\/[^/]+/, '~')} {...max.modalProps}>
      <div className={`modal__body file-preview file-preview--${kind}`} ref={max.bodyRef}>
        {error ? (
          <div className="row__error">{error}</div>
        ) : binary ? (
          !data ? (
            loading
          ) : kind === 'image' ? (
            imageUrl && <img className="file-preview__image" src={imageUrl} alt={baseName(file.path)} />
          ) : (
            <Suspense fallback={loading}>{kind === 'pdf' ? <PdfView data={data} /> : <DocxView data={data} />}</Suspense>
          )
        ) : body === null ? (
          loading
        ) : kind === 'markdown' ? (
          <div className="file-preview__md">
            <Markdown text={body} />
          </div>
        ) : kind === 'sheet' && !raw ? (
          <CsvTable text={body} path={file.path} />
        ) : (
          <pre className="file-preview__text">{body}</pre>
        )}
        <footer className="modal__foot">
          <span className="muted">{formatSize(file.size)}</span>
          {kind === 'sheet' && text !== null && (
            <div className="seg file-preview__mode">
              <button className={raw ? '' : 'active'} onClick={() => setRaw(false)}>
                <LuTable /> Table
              </button>
              <button className={raw ? 'active' : ''} onClick={() => setRaw(true)}>
                <LuFileText /> Raw
              </button>
            </div>
          )}
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

function imageType(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
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
