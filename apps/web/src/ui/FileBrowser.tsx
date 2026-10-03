import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  LuCheck,
  LuChevronRight,
  LuCopy,
  LuCornerLeftUp,
  LuDownload,
  LuEllipsis,
  LuEye,
  LuFile,
  LuFileArchive,
  LuFileImage,
  LuFileText,
  LuFolder,
  LuFolderOpen,
  LuFolderPlus,
  LuLink,
  LuPencil,
  LuRefreshCw,
  LuTrash2,
  LuUpload,
  LuX,
} from 'react-icons/lu'
import type { FolderEntry, FolderListing } from '@after-office/shared'
import { api } from '../state/auth'
import { useNow } from '../state/clock'
import { canPreview, FilePreview, formatSize, saveUrl } from './Attachments'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { SearchBox } from './SearchBox'
import { ActionMenu, type MenuAction } from './ActionMenu'

// A file manager for a folder the agents work in (the folder details, an agent's Folder tab): browse, preview, upload,
// new folders, rename, download (one file, or several as a .zip) and delete, which moves things to the office's trash
// (restored from there). The server keeps it inside that folder: no "..", no links followed, nothing hidden.

export const fileUrl = (root: string, path: string, inline = false) =>
  `/api/workspaces/file?${new URLSearchParams({ root, path, ...(inline ? { inline: '1' } : {}) })}`

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

async function post(url: string, body: unknown) {
  const r = await api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const out = await r.json().catch(() => null)
  if (!r.ok) throw new Error(out?.error ?? `Failed (${r.status})`)
  return out
}

type Menu = { entry: FolderEntry; x: number; y: number }

/**
 * `onTrashed`: something went to the trash (the folder details count it). `fill`: the list takes the height it's given
 * and scrolls inside (a large panel) instead of growing with its content.
 */
export function FileBrowser({ root, onTrashed, fill = false }: { root: string; onTrashed?: () => void; fill?: boolean }) {
  const now = useNow(60_000).getTime()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ path: string; size: number } | null>(null)
  // ticked entries of the folder on screen (names); cleared when moving to another folder
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const lastPicked = useRef<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // files the owner adds to the folder on screen (the agents can use them right away)
  const [uploading, setUploading] = useState(0)
  const uploadInput = useRef<HTMLInputElement>(null)
  // a new folder in the folder on screen: its name typed in a row under the bar
  const [newFolder, setNewFolder] = useState<string | null>(null)
  // an entry being renamed (its name)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const rootName = root.split('/').filter(Boolean).pop() ?? root
  // the folder on screen, for load() (a refresh keeps the filter; going elsewhere clears it)
  const here = useRef('')
  const load = useCallback(
    async (dir: string, keepPicked = false) => {
      setLoading(true)
      setError(null)
      try {
        const r = await api(`/api/workspaces/files?${new URLSearchParams({ root, path: dir })}`)
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not read the folder (${r.status})`)
        setListing(await r.json())
        if (dir !== here.current) setFilter('')
        here.current = dir
        setPath(dir)
        if (!keepPicked) setPicked(new Set())
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

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const makeFolder = () =>
    act('folder', async () => {
      const name = newFolder?.trim()
      if (!name) return
      await post('/api/workspaces/folders', { root, path, name })
      setNewFolder(null)
      await load(path)
    })
  const upload = async (files: File[]) => {
    if (!files.length) return
    setUploading(files.length)
    const problems: string[] = []
    for (const file of files) {
      try {
        const r = await api(`/api/workspaces/files?${new URLSearchParams({ root, path })}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
          body: file,
        })
        if (!r.ok) problems.push((await r.json().catch(() => null))?.error ?? `Could not add ${file.name}`)
      } catch {
        problems.push(`Could not add ${file.name}`)
      }
      setUploading((n) => n - 1)
    }
    setUploading(0)
    await load(path)
    if (problems.length) setError(problems.join(' · '))
  }
  const rename = (e: FolderEntry, name: string | null) => {
    setRenaming(null)
    const next = name?.trim()
    if (!next || next === e.name) return
    void act('rename', async () => {
      await post('/api/workspaces/entry/rename', { root, path: join(path, e.name), name: next })
      await load(path)
    })
  }
  const trash = async (names: string[]) => {
    if (!names.length) return
    const ok = await confirm({
      title: names.length === 1 ? `Move “${names[0]}” to the Trash?` : `Move ${names.length} items to the Trash?`,
      message: 'They leave this folder and wait in the office’s trash: restore them from Trash any time, until it’s emptied.',
      confirmLabel: 'Move to Trash',
    })
    if (!ok) return
    await act('trash', async () => {
      await post('/api/workspaces/trash', { root, paths: names.map((n) => join(path, n)) })
      await load(path)
      onTrashed?.()
    })
  }
  const download = (e: FolderEntry) => (e.dir ? void zip([e.name]) : saveUrl(fileUrl(root, join(path, e.name)), e.name))
  // files and folders as one ZIP (made by the server, same rules as browsing)
  const zip = (names: string[]) =>
    act('zip', async () => {
      const r = await api('/api/workspaces/zip', { method: 'POST', body: JSON.stringify({ root, paths: names.map((n) => join(path, n)) }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not make the download (${r.status})`)
      const url = URL.createObjectURL(await r.blob())
      const folder = path ? path.split('/').pop() : rootName
      saveUrl(url, `${folder}-${names.length === 1 ? names[0].replace(/\.[^.]+$/, '') : `${names.length}-items`}.zip`)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    })
  const copyPath = (e: FolderEntry) => {
    const full = `${root}/${join(path, e.name)}`
    void navigator.clipboard?.writeText(full).then(() => {
      setCopied(e.name)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  const open = (e: FolderEntry) => {
    if (e.link) return
    const p = join(path, e.name)
    if (e.dir) return void load(p)
    const att = { path: p, size: e.size, ...(e.image ? { image: true } : {}) }
    if (canPreview(att)) setPreview(att)
    else saveUrl(fileUrl(root, p), e.name)
  }

  const entries = useMemo(() => {
    const all = listing?.entries ?? []
    const q = filter.trim().toLowerCase()
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all
  }, [listing, filter])
  const pickable = entries.filter((e) => !e.link)
  const allPicked = pickable.length > 0 && pickable.every((e) => picked.has(e.name))
  // a click ticks one; Shift-click ticks everything between it and the last one ticked
  const toggle = (name: string, range: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      const from = lastPicked.current ? pickable.findIndex((e) => e.name === lastPicked.current) : -1
      const to = pickable.findIndex((e) => e.name === name)
      if (range && from >= 0 && to >= 0) {
        for (const e of pickable.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(e.name)
      } else if (next.has(name)) next.delete(name)
      else next.add(name)
      lastPicked.current = name
      return next
    })
  const pickedEntries = entries.filter((e) => picked.has(e.name))
  const pickedSize = pickedEntries.reduce((n, e) => n + e.size, 0)
  const pickedDirs = pickedEntries.filter((e) => e.dir).length

  const crumbs = path ? path.split('/') : []
  return (
    <div
      className={`fb${fill ? ' fb--fill' : ''}`}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void upload([...e.dataTransfer.files])
      }}
    >
      <div className="fb__bar">
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
        <SearchBox value={filter} onChange={setFilter} placeholder="Filter" className="fb__filter" />
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <button className="icon-btn small ghost" onClick={() => setNewFolder((v) => (v === null ? '' : null))} data-tip="New folder here" aria-label="New folder" aria-expanded={newFolder !== null}>
          <LuFolderPlus />
        </button>
        <button className="icon-btn small ghost" onClick={() => uploadInput.current?.click()} disabled={uploading > 0} data-tip={uploading ? `Adding ${uploading}…` : 'Upload files here (or drop them on the list)'} aria-label="Upload files">
          {uploading ? <LuRefreshCw className="spin" /> : <LuUpload />}
        </button>
        <button className="icon-btn small ghost" onClick={() => void load(path, true)} disabled={loading} data-tip="Refresh" aria-label="Refresh">
          <LuRefreshCw className={loading ? 'spin' : ''} />
        </button>
      </div>
      {newFolder !== null && (
        <div className="fb__new">
          <LuFolder className="fb__new-icon" />
          <input
            autoFocus
            value={newFolder}
            maxLength={120}
            placeholder="Folder name"
            onChange={(e) => {
              setNewFolder(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void makeFolder()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setNewFolder(null)
              }
            }}
          />
          <button className="icon-btn small ghost" onClick={() => void makeFolder()} disabled={!newFolder.trim() || busy === 'folder'} data-tip="Create" aria-label="Create the folder">
            {busy === 'folder' ? <LuRefreshCw className="spin" /> : <LuCheck />}
          </button>
          <button className="icon-btn small ghost" onClick={() => setNewFolder(null)} data-tip="Cancel" aria-label="Cancel">
            <LuX />
          </button>
        </div>
      )}
      {picked.size > 0 && (
        <div className="fb__picked">
          <span>
            <b>{picked.size}</b> selected{pickedDirs ? ` (${pickedDirs} folder${pickedDirs === 1 ? '' : 's'} with everything in them)` : ` · ${formatSize(pickedSize)}`}
          </span>
          <span className="grow" />
          <button className="small" onClick={() => void zip([...picked])} disabled={busy === 'zip'}>
            {busy === 'zip' ? <LuRefreshCw className="spin" /> : <LuFileArchive />} {busy === 'zip' ? 'Packing…' : 'Download .zip'}
          </button>
          <button className="small danger-text" onClick={() => void trash([...picked])} disabled={busy === 'trash'}>
            {busy === 'trash' ? <LuRefreshCw className="spin" /> : <LuTrash2 />} Move to Trash
          </button>
          <button className="icon-btn small ghost" onClick={() => setPicked(new Set())} data-tip="Clear selection" aria-label="Clear selection">
            <LuX />
          </button>
        </div>
      )}
      {error && <div className="row__error fb__error">{error}</div>}
      {!listing ? (
        !error && <div className="muted fb__empty">Loading…</div>
      ) : (
        <div className="fb__table" role="table" aria-label="Files">
          <div className="fb__head" role="row">
            <input
              className="check"
              type="checkbox"
              checked={allPicked}
              ref={(el) => {
                if (el) el.indeterminate = picked.size > 0 && !allPicked
              }}
              disabled={!pickable.length}
              onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((e) => e.name)))}
              aria-label="Select all"
            />
            <span>Name</span>
            <span className="fb__col-size">Size</span>
            <span className="fb__col-when">Modified</span>
            <span />
          </div>
          {!entries.length ? (
            <div className="muted fb__empty">{filter.trim() ? `Nothing called “${filter.trim()}” here.` : 'This folder is empty. Drop files here to upload them.'}</div>
          ) : (
            <ul className="fb__list">
              {entries.map((e) => {
                const previewable = !e.dir && canPreview({ path: e.name, size: e.size })
                return (
                  <li
                    key={e.name}
                    className={`fb__item${picked.has(e.name) ? ' is-picked' : ''}${menu?.entry.name === e.name ? ' is-menu' : ''}`}
                    onContextMenu={(ev) => {
                      if (e.link) return
                      ev.preventDefault()
                      setMenu({ entry: e, x: ev.clientX, y: ev.clientY })
                    }}
                  >
                    <input
                      className="check"
                      type="checkbox"
                      checked={picked.has(e.name)}
                      disabled={e.link}
                      onChange={() => undefined}
                      onClick={(ev) => toggle(e.name, ev.shiftKey)}
                      aria-label={`Select ${e.name}`}
                    />
                    {renaming === e.name ? (
                      <RenameField name={e.name} dir={e.dir} onDone={(name) => rename(e, name)} />
                    ) : (
                      <button
                        className={`fb__row${e.link ? ' is-link' : ''}`}
                        onClick={() => open(e)}
                        disabled={e.link}
                        data-tip={e.link ? 'A link to somewhere else: not opened here' : undefined}
                      >
                        <span className="fb__icon">
                          {e.link ? <LuLink /> : e.dir ? <LuFolder className="fb__folder" /> : e.image ? <LuFileImage /> : previewable ? <LuFileText /> : <LuFile />}
                        </span>
                        <span className="fb__name truncate">{e.name}</span>
                      </button>
                    )}
                    <span className="fb__col-size muted">{e.dir ? '—' : formatSize(e.size)}</span>
                    <span className="fb__col-when muted">{ago(now - e.updatedAt)}</span>
                    <button
                      className="icon-btn small ghost fb__more"
                      disabled={e.link}
                      aria-label={`Actions for ${e.name}`}
                      onClick={(ev) => {
                        const r = ev.currentTarget.getBoundingClientRect()
                        setMenu(menu?.entry.name === e.name ? null : { entry: e, x: r.right, y: r.bottom })
                      }}
                    >
                      {copied === e.name ? <LuCheck /> : <LuEllipsis />}
                    </button>
                  </li>
                )
              })}
              {listing.more > 0 && <li className="muted fb__empty">…and {listing.more} more</li>}
            </ul>
          )}
        </div>
      )}
      {menu && (
        <EntryMenu
          at={menu}
          onClose={() => setMenu(null)}
          actions={[
            {
              icon: menu.entry.dir ? <LuFolderOpen /> : canPreview({ path: menu.entry.name, size: menu.entry.size }) ? <LuEye /> : <LuDownload />,
              label: menu.entry.dir ? 'Open' : canPreview({ path: menu.entry.name, size: menu.entry.size }) ? 'Preview' : 'Download',
              run: () => open(menu.entry),
            },
            { icon: <LuPencil />, label: 'Rename', run: () => setRenaming(menu.entry.name) },
            ...(menu.entry.dir || canPreview({ path: menu.entry.name, size: menu.entry.size })
              ? [{ icon: menu.entry.dir ? <LuFileArchive /> : <LuDownload />, label: menu.entry.dir ? 'Download .zip' : 'Download', run: () => download(menu.entry) }]
              : []),
            { icon: <LuCopy />, label: 'Copy path', run: () => copyPath(menu.entry) },
            { icon: <LuTrash2 />, label: 'Move to Trash', danger: true, run: () => void trash([menu.entry.name]) },
          ]}
        />
      )}
      {preview && <FilePreview file={{ path: `${root}/${preview.path}`, size: preview.size }} url={fileUrl(root, preview.path)} onClose={() => setPreview(null)} />}
    </div>
  )
}

/** A file's or folder's new name, typed in its row: Enter or ✓ keeps it, Escape or ✕ cancels. */
function RenameField({ name, dir, onDone }: { name: string; dir: boolean; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(name)
  const press = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault()
    fn()
  }
  return (
    <span className="fb__rename">
      {dir ? <LuFolder className="fb__folder" /> : <LuFile className="muted" />}
      <input
        autoFocus
        value={v}
        maxLength={200}
        // the name without its extension is selected (the usual: type the new name, keep .md)
        onFocus={(e) => {
          const dot = dir ? -1 : v.lastIndexOf('.')
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length)
        }}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone(v)
          if (e.key === 'Escape') {
            e.stopPropagation()
            onDone(null)
          }
        }}
        onBlur={() => onDone(v)}
        aria-label="New name"
      />
      <button className="icon-btn small ghost" onMouseDown={press(() => onDone(v))} aria-label="Save the name">
        <LuCheck />
      </button>
      <button className="icon-btn small ghost" onMouseDown={press(() => onDone(null))} aria-label="Cancel">
        <LuX />
      </button>
    </span>
  )
}

/** The actions of one entry (its ⋯ button, or a right-click), on the page itself so no panel clips it. */
function EntryMenu({ at, actions, onClose }: { at: Menu; actions: MenuAction[]; onClose: () => void }) {
  return <ActionMenu x={at.x} y={at.y} title={at.entry.name} actions={actions} onClose={onClose} />
}
