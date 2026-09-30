import { useCallback, useEffect, useState } from 'react'
import { LuChevronRight, LuCornerLeftUp, LuDownload, LuFile, LuFileArchive, LuFileImage, LuFileText, LuFolder, LuLink, LuRefreshCw, LuX } from 'react-icons/lu'
import type { FolderEntry, FolderListing } from '@after-office/shared'
import { api } from '../state/auth'
import { useNow } from '../state/clock'
import { canPreview, FilePreview, formatSize, saveUrl } from './Attachments'
import { ago } from './FollowUps'

// A read-only file manager for a folder in the Projects tab: browse its folders, preview text / Markdown files,
// open pictures, download the rest. The server keeps it inside that folder (no "..", no symlinks, no hidden files).

const fileUrl = (root: string, path: string, inline = false) =>
  `/api/workspaces/file?${new URLSearchParams({ root, path, ...(inline ? { inline: '1' } : {}) })}`

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

export function FileBrowser({ root }: { root: string }) {
  const now = useNow(60_000).getTime()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ path: string; size: number } | null>(null)
  // ticked entries of the folder on screen (names); cleared when moving to another folder
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [zipping, setZipping] = useState(false)

  const rootName = root.split('/').filter(Boolean).pop() ?? root
  const load = useCallback(
    async (dir: string) => {
      setLoading(true)
      setError(null)
      try {
        const r = await api(`/api/workspaces/files?${new URLSearchParams({ root, path: dir })}`)
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not read the folder (${r.status})`)
        setListing(await r.json())
        setPath(dir)
        setPicked(new Set())
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [root],
  )
  useEffect(() => {
    void load('')
  }, [load])

  const open = (e: FolderEntry) => {
    if (e.link) return
    const p = join(path, e.name)
    if (e.dir) return void load(p)
    const att = { path: p, size: e.size, ...(e.image ? { image: true } : {}) }
    if (canPreview(att)) setPreview(att)
    else if (e.image) window.open(fileUrl(root, p, true), '_blank', 'noopener,noreferrer')
    else saveUrl(fileUrl(root, p), e.name)
  }

  const pickable = (listing?.entries ?? []).filter((e) => !e.link)
  const allPicked = pickable.length > 0 && pickable.every((e) => picked.has(e.name))
  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const pickedSize = (listing?.entries ?? []).filter((e) => picked.has(e.name)).reduce((n, e) => n + e.size, 0)
  const pickedDirs = (listing?.entries ?? []).filter((e) => picked.has(e.name) && e.dir).length

  // the ticked files and folders as one ZIP (made by the server, same rules as browsing)
  const downloadPicked = async () => {
    setZipping(true)
    setError(null)
    try {
      const r = await api('/api/workspaces/zip', { method: 'POST', body: JSON.stringify({ root, paths: [...picked].map((n) => join(path, n)) }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not make the download (${r.status})`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const folder = path ? path.split('/').pop() : rootName
      saveUrl(url, `${folder}-${picked.size === 1 ? [...picked][0].replace(/\.[^.]+$/, '') : `${picked.size}-items`}.zip`)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setZipping(false)
    }
  }

  const crumbs = path ? path.split('/') : []
  return (
    <div className="fb">
      <div className="fb__bar">
        <input
          className="check fb__all"
          type="checkbox"
          checked={allPicked}
          ref={(el) => {
            if (el) el.indeterminate = picked.size > 0 && !allPicked
          }}
          disabled={!pickable.length}
          onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((e) => e.name)))}
          aria-label="Select all"
          data-tip={allPicked ? 'Clear selection' : 'Select all'}
        />
        <button className="icon-btn small ghost" disabled={!path || loading} onClick={() => void load(crumbs.slice(0, -1).join('/'))} data-tip="Up" aria-label="Up one folder">
          <LuCornerLeftUp />
        </button>
        <nav className="fb__crumbs" aria-label="Folder">
          <button className="fb__crumb" onClick={() => void load('')} disabled={!path}>
            {rootName}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="fb__crumb-wrap">
              <LuChevronRight className="muted" />
              <button className="fb__crumb" onClick={() => void load(crumbs.slice(0, i + 1).join('/'))} disabled={i === crumbs.length - 1}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <button className="icon-btn small ghost" onClick={() => void load(path)} disabled={loading} data-tip="Refresh" aria-label="Refresh">
          <LuRefreshCw className={loading ? 'spin' : ''} />
        </button>
      </div>
      {picked.size > 0 && (
        <div className="fb__picked">
          <span>
            <b>{picked.size}</b> selected{pickedDirs ? ` (${pickedDirs} folder${pickedDirs === 1 ? '' : 's'} with everything in them)` : ` · ${formatSize(pickedSize)}`}
          </span>
          <span className="grow" />
          <button className="small primary" onClick={() => void downloadPicked()} disabled={zipping}>
            {zipping ? <LuRefreshCw className="spin" /> : <LuFileArchive />} {zipping ? 'Packing…' : 'Download .zip'}
          </button>
          <button className="icon-btn small ghost" onClick={() => setPicked(new Set())} data-tip="Clear selection" aria-label="Clear selection">
            <LuX />
          </button>
        </div>
      )}
      {error ? (
        <div className="row__error">{error}</div>
      ) : !listing ? (
        <div className="muted fb__empty">Loading…</div>
      ) : !listing.entries.length ? (
        <div className="muted fb__empty">This folder is empty.</div>
      ) : (
        <ul className="fb__list">
          {listing.entries.map((e) => {
            const previewable = !e.dir && canPreview({ path: e.name, size: e.size })
            return (
              <li key={e.name} className={`fb__item${picked.has(e.name) ? ' is-picked' : ''}`}>
                <input
                  className="check"
                  type="checkbox"
                  checked={picked.has(e.name)}
                  disabled={e.link}
                  onChange={() => toggle(e.name)}
                  aria-label={`Select ${e.name}`}
                />
                <button
                  className={`fb__row${e.link ? ' is-link' : ''}`}
                  onClick={() => open(e)}
                  disabled={e.link}
                  data-tip={e.link ? 'A link to somewhere else: not opened here' : e.dir ? undefined : previewable ? 'Preview' : e.image ? 'Open' : 'Download'}
                >
                  <span className="fb__icon">
                    {e.link ? <LuLink /> : e.dir ? <LuFolder className="fb__folder" /> : e.image ? <LuFileImage /> : previewable ? <LuFileText /> : <LuFile />}
                  </span>
                  <span className="fb__name truncate">{e.name}</span>
                  <span className="fb__meta muted">{e.dir ? '' : formatSize(e.size)}</span>
                  <span className="fb__meta muted fb__when">{ago(now - e.updatedAt)}</span>
                  {!e.dir && !e.link && !previewable && !e.image && <LuDownload className="fb__dl muted" />}
                </button>
              </li>
            )
          })}
          {listing.more > 0 && <li className="muted fb__empty">…and {listing.more} more</li>}
        </ul>
      )}
      {preview && (
        <FilePreview
          file={{ path: `${root}/${preview.path}`, size: preview.size }}
          url={fileUrl(root, preview.path)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
