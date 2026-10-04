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
  LuEyeOff,
  LuFileCode,
  LuFile,
  LuFileArchive,
  LuFileImage,
  LuFileText,
  LuFolder,
  LuFolderOpen,
  LuFolderPlus,
  LuFilePlus,
  LuGitBranch,
  LuGitCommitHorizontal,
  LuArrowUpFromLine,
  LuArrowDownToLine,
  LuKeyRound,
  LuRotateCcw,
  LuChevronDown,
  LuCloud,
  LuLoader,
  LuUndo2,
  LuLink,
  LuPencil,
  LuRefreshCw,
  LuTrash2,
  LuUpload,
  LuX,
} from 'react-icons/lu'
import type { FolderEntry, FolderGit, FolderListing } from '@after-office/shared'
import { api } from '../state/auth'
import { useNow } from '../state/clock'
import { canPreview, FilePreview, formatSize, saveUrl } from './Attachments'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { SearchBox } from './SearchBox'
import { FileEditor, isTextFile } from './FileEditor'
import { ActionMenu, type MenuAction } from './ActionMenu'
import { Modal } from './Modal'
import { Select } from './Select'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'

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

type Menu = { entry: FolderEntry; x: number; y: number; above?: number }

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
  // …or a new file (any name and extension: opened in the editor once made)
  const [newKind, setNewKind] = useState<'folder' | 'file'>('folder')
  const startNew = (kind: 'folder' | 'file') => {
    setError(null)
    if (newFolder !== null && newKind === kind) return setNewFolder(null)
    setNewKind(kind)
    setNewFolder('')
  }
  // an entry being renamed (its name)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  // the git repo the folder on screen is in (branch, what's not committed), if any
  const [gitLine, setGitLine] = useState<FolderGit | null>(null)
  const loadGit = useCallback(
    (dir: string) =>
      void api(`/api/workspaces/git?${new URLSearchParams({ root, path: dir })}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((g: FolderGit | null) => (here.current === dir ? setGitLine(g) : undefined))
        .catch(() => setGitLine(null)),
    [root],
  )
  // a text file open in the editor (its path)
  const [editing, setEditing] = useState<string | null>(null)
  // opened to change it (a new file, or Edit from its menu) rather than to read it (a click)
  const [editMode, setEditMode] = useState(false)
  const openFile = (p: string, edit: boolean) => (setEditMode(edit), setEditing(p))
  // hidden files (.env, .gitignore, .claude…) shown too: remembered in this browser
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('after-office:files-hidden') === '1'
    } catch {
      return false
    }
  })
  const toggleHidden = () =>
    setHidden((v) => {
      try {
        localStorage.setItem('after-office:files-hidden', v ? '0' : '1')
      } catch {
        // not remembered
      }
      return !v
    })

  const rootName = root.split('/').filter(Boolean).pop() ?? root
  // the folder on screen, for load() (a refresh keeps the filter; going elsewhere clears it)
  const here = useRef('')
  const load = useCallback(
    async (dir: string, keepPicked = false) => {
      setLoading(true)
      setError(null)
      try {
        const r = await api(`/api/workspaces/files?${new URLSearchParams({ root, path: dir, ...(hidden ? { hidden: '1' } : {}) })}`)
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not read the folder (${r.status})`)
        setListing(await r.json())
        if (dir !== here.current) setFilter('')
        here.current = dir
        loadGit(dir)
        setPath(dir)
        if (!keepPicked) setPicked(new Set())
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [root, hidden, loadGit],
  )
  // a new folder opens at its top; showing / hiding hidden files reloads the folder on screen
  const lastRoot = useRef(root)
  useEffect(() => {
    const same = lastRoot.current === root
    lastRoot.current = root
    void load(same ? here.current : '', same)
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
      if (newKind === 'file') {
        const made = (await post('/api/workspaces/newfile', { root, path, name })) as { path: string }
        setNewFolder(null)
        await load(path)
        openFile(made.path, true)
        return
      }
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
    // text and code: straight into the editor
    if (isTextFile(e.name)) return void openFile(p, false)
    const att = { path: p, size: e.size, ...(e.image ? { image: true } : {}) }
    if (canPreview(att)) setPreview(att)
    else saveUrl(fileUrl(root, p), e.name)
  }

  const entries = useMemo(() => {
    const all = listing?.entries ?? []
    const q = filter.trim().toLowerCase()
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all
  }, [listing, filter])
  const pickable = entries.filter((e) => !e.link && !e.name.startsWith('.'))
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
        <button className="icon-btn small ghost" onClick={() => startNew('file')} data-tip="New file here (any extension)" aria-label="New file" aria-expanded={newFolder !== null && newKind === 'file'}>
          <LuFilePlus />
        </button>
        <button className="icon-btn small ghost" onClick={() => startNew('folder')} data-tip="New folder here" aria-label="New folder" aria-expanded={newFolder !== null && newKind === 'folder'}>
          <LuFolderPlus />
        </button>
        <button className="icon-btn small ghost" onClick={() => uploadInput.current?.click()} disabled={uploading > 0} data-tip={uploading ? `Adding ${uploading}…` : 'Upload files here (or drop them on the list)'} aria-label="Upload files">
          {uploading ? <LuRefreshCw className="spin" /> : <LuUpload />}
        </button>
        <button className={`icon-btn small ghost${hidden ? ' is-on' : ''}`} aria-pressed={hidden} onClick={toggleHidden} data-tip={hidden ? 'Hide hidden files' : 'Show hidden files (.env, .gitignore…)'} aria-label="Show hidden files">
          {hidden ? <LuEye /> : <LuEyeOff />}
        </button>
        <button className="icon-btn small ghost" onClick={() => void load(path, true)} disabled={loading} data-tip="Refresh" aria-label="Refresh">
          <LuRefreshCw className={loading ? 'spin' : ''} />
        </button>
      </div>
      {gitLine && (
        <GitLine
          git={gitLine}
          now={now}
          root={root}
          dir={here.current}
          // after a commit, push or discard: the bar and the list (its change marks, files back or gone)
          onChanged={() => {
            loadGit(here.current)
            void load(here.current, true)
          }}
        />
      )}
      {newFolder !== null && (
        <div className="fb__new">
          {newKind === 'file' ? <LuFile className="fb__new-icon" /> : <LuFolder className="fb__new-icon" />}
          <input
            key={newKind}
            autoFocus
            value={newFolder}
            maxLength={newKind === 'file' ? 200 : 120}
            placeholder={newKind === 'file' ? 'File name, e.g. notes.md, script.py, .env' : 'Folder name'}
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
          <button className="icon-btn small ghost" onClick={() => void makeFolder()} disabled={!newFolder.trim() || busy === 'folder'} data-tip="Create" aria-label={newKind === 'file' ? 'Create the file' : 'Create the folder'}>
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
                    className={`fb__item${picked.has(e.name) ? ' is-picked' : ''}${menu?.entry.name === e.name ? ' is-menu' : ''}${e.name.startsWith('.') ? ' is-hidden' : ''}`}
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
                      disabled={e.link || e.name.startsWith('.')}
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
                        {gitLine?.entries[e.name] && (
                          <span className={`fb__git-mark fb__git-mark--${gitLine.entries[e.name]}`} data-tip={GIT_MARK[gitLine.entries[e.name]]}>
                            {gitLine.entries[e.name]}
                          </span>
                        )}
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
                        setMenu(menu?.entry.name === e.name ? null : { entry: e, x: r.right, y: r.bottom, above: r.top })
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
            ...(!menu.entry.dir && !menu.entry.image ? [{ icon: <LuFileCode />, label: 'Edit', run: () => openFile(join(path, menu.entry.name), true) }] : []),
            // hidden ones (.env, .claude…): read and edited here, not renamed or moved
            ...(menu.entry.name.startsWith('.') ? [] : [{ icon: <LuPencil />, label: 'Rename', run: () => setRenaming(menu.entry.name) }]),
            ...(menu.entry.dir || canPreview({ path: menu.entry.name, size: menu.entry.size })
              ? [{ icon: menu.entry.dir ? <LuFileArchive /> : <LuDownload />, label: menu.entry.dir ? 'Download .zip' : 'Download', run: () => download(menu.entry) }]
              : []),
            { icon: <LuCopy />, label: 'Copy path', run: () => copyPath(menu.entry) },
            ...(menu.entry.name.startsWith('.') ? [] : [{ icon: <LuTrash2 />, label: 'Move to Trash', danger: true, run: () => void trash([menu.entry.name]) }]),
          ]}
        />
      )}
      {editing && <FileEditor key={editing} root={root} path={editing} edit={editMode} onClose={() => setEditing(null)} onSaved={() => void load(here.current, true)} />}
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
  return <ActionMenu x={at.x} y={at.y} above={at.above} title={at.entry.name} actions={actions} onClose={onClose} />
}

const GIT_MARK: Record<FolderGit['entries'][string], string> = {
  M: 'Changed, not committed',
  A: 'Added, not committed',
  D: 'Deleted, not committed',
  U: 'New, not in git yet',
  R: 'Renamed, not committed',
}

/** The folder's git repo in one line: branch, ahead / behind, what's not committed, the last commit. */
function GitLine({ git, now, root, dir, onChanged }: { git: FolderGit; now: number; root: string; dir: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<'discard' | 'push' | 'pull' | 'switch' | null>(null)
  const [committing, setCommitting] = useState(false)
  // the branches menu (the branch name opens it)
  // whose git identity (name, email, SSH key) this repo's commits, pulls and pushes use: the "as" button
  const [asMenu, setAsMenu] = useState<{ x: number; y: number; above: number } | null>(null)
  const agents = useOffice((st) => st.agents)
  const pickAs = async (agentId: string) => {
    try {
      const r = await api('/api/workspaces/git/as', { method: 'POST', body: JSON.stringify({ root, path: dir, agentId }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not change it (${r.status})`)
      onChanged()
    } catch (e) {
      useDashboard.setState({ syncError: e instanceof Error ? e.message : 'Could not change it' })
    }
  }
  const [branches, setBranches] = useState<{ x: number; y: number; above: number; current: string | null; local: string[]; remote: string[] } | null>(null)
  // Push: a remote, a branch, and something to push (or no upstream yet: the first push sets it)
  const canPush = !!git.hasRemote && !!git.branch && (git.ahead === undefined || git.ahead > 0)
  const call = async (action: 'discard' | 'push' | 'pull' | 'switch', body: Record<string, unknown> = {}) => {
    setBusy(action)
    try {
      const r = await api(`/api/workspaces/git/${action}`, { method: 'POST', body: JSON.stringify({ root, path: dir, ...body }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not ${action} (${r.status})`)
      onChanged()
    } catch (e) {
      useDashboard.setState({ syncError: e instanceof Error ? e.message : `Could not ${action}` })
    } finally {
      setBusy(null)
    }
  }
  const openBranches = async (el: HTMLElement) => {
    if (busy) return
    const box = el.getBoundingClientRect()
    try {
      const r = await api(`/api/workspaces/git/branches?${new URLSearchParams({ root, path: dir })}`)
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not list the branches (${r.status})`)
      setBranches({ x: box.left, y: box.bottom + 4, above: box.top - 4, ...(await r.json()) })
    } catch (e) {
      useDashboard.setState({ syncError: e instanceof Error ? e.message : 'Could not list the branches' })
    }
  }
  const run = async (action: 'discard' | 'push') => {
    if (busy) return
    if (action === 'discard') {
      const ok = await confirm({
        title: `Discard ${git.dirty} change${git.dirty === 1 ? '' : 's'}?`,
        message: (
          <>
            Every file of <b>{git.repo}</b> goes back to how it was last committed, and new files are deleted (ignored files, like .env or
            node_modules, stay). This can't be undone.
          </>
        ),
        confirmLabel: 'Discard all',
      })
      if (!ok) return
    }
    await call(action)
  }
  return (
    <div className="fb__git">
      <button className="fb__git-branch" onClick={(e) => void openBranches(e.currentTarget)} disabled={!!busy} aria-haspopup="menu" data-tip={`Git repo: ${git.repo}. Switch branch`}>
        {busy === 'switch' ? <LuLoader className="spin" /> : <LuGitBranch />} {git.branch ?? 'detached HEAD'} <LuChevronDown className="fb__git-caret" />
      </button>
      {git.ahead !== undefined && (git.ahead > 0 || (git.behind ?? 0) > 0) && (
        <span className="fb__git-sync" data-tip={`${git.ahead} to push, ${git.behind ?? 0} to pull`}>
          {git.ahead > 0 && <>↑{git.ahead}</>} {(git.behind ?? 0) > 0 && <>↓{git.behind}</>}
        </span>
      )}
      {git.dirty > 0 ? (
        <span className="fb__git-dirty">
          {git.dirty} uncommitted change{git.dirty === 1 ? '' : 's'}
        </span>
      ) : (
        <span className="fb__git-clean">
          <LuCheck /> All committed
        </span>
      )}
      {git.lastCommit && (
        <span className="fb__git-last muted truncate" data-tip={`${git.lastCommit.subject}${git.lastCommit.author ? ` · ${git.lastCommit.author}` : ''}`}>
          Last commit: {git.lastCommit.subject} · {ago(now - git.lastCommit.at)}
        </span>
      )}
      <span className="fb__git-actions">
        {git.committer && (
          <button
            className="small ghost fb__git-as"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect()
              setAsMenu({ x: box.left, y: box.bottom + 4, above: box.top - 4 })
            }}
            disabled={!!busy}
            aria-haspopup="menu"
            data-tip={`Commits, pulls and pushes here use ${git.committer.name}'s git name, email and SSH key${git.committer.hasKey ? '' : ' (no SSH key yet: Overview → Git)'}. Change`}
          >
            <LuKeyRound /> as {git.committer.name}
            {!git.committer.hasKey && <span className="fb__git-nokey">no key</span>}
          </button>
        )}
        {git.hasRemote && git.branch && (
          <button className="small" onClick={() => void call('pull')} disabled={!!busy} data-tip={`Fetch and catch up with the remote${git.committer ? `, with ${git.committer.name}'s key` : ''}`}>
            {busy === 'pull' ? <LuLoader className="spin" /> : <LuArrowDownToLine />} Pull{git.behind ? ` ↓${git.behind}` : ''}
          </button>
        )}
        {git.dirty > 0 && (
          <>
            <button className="small ghost danger-text" onClick={() => void run('discard')} disabled={!!busy} data-tip="Throw away every change not committed">
              {busy === 'discard' ? <LuLoader className="spin" /> : <LuUndo2 />} Discard
            </button>
            <button className="small" onClick={() => setCommitting(true)} disabled={!!busy} data-tip={git.committer ? `Commit everything, as ${git.committer.name}` : 'Commit everything'}>
              <LuGitCommitHorizontal /> Commit
            </button>
          </>
        )}
        {canPush && (
          <button
            className="small primary"
            onClick={() => void run('push')}
            disabled={!!busy}
            data-tip={git.ahead === undefined ? 'First push: sets where this branch goes (origin)' : `Push ${git.ahead} commit${git.ahead === 1 ? '' : 's'}${git.committer ? `, with ${git.committer.name}'s key` : ''}`}
          >
            {busy === 'push' ? <LuLoader className="spin" /> : <LuArrowUpFromLine />} Push{git.ahead ? ` ↑${git.ahead}` : ''}
          </button>
        )}
      </span>
      {committing && <CommitModal git={git} root={root} dir={dir} onClose={() => setCommitting(false)} onDone={onChanged} />}
      {asMenu && (
        <ActionMenu
          className="fb-menu--branches"
          x={asMenu.x}
          y={asMenu.y}
          above={asMenu.above}
          title="Commit, pull and push as"
          onClose={() => setAsMenu(null)}
          actions={[
            ...agents.map((a) => ({ icon: a.id === git.committer?.agentId ? <LuCheck /> : <LuKeyRound />, label: a.name, run: () => (a.id === git.committer?.agentId && git.committer.picked ? undefined : void pickAs(a.id)) })),
            ...(git.committer?.picked ? [{ icon: <LuRotateCcw />, label: 'Automatic (the agent working here)', run: () => void pickAs('') }] : []),
          ]}
        />
      )}
      {branches && (
        <ActionMenu
          className="fb-menu--branches"
          x={branches.x}
          y={branches.y}
          above={branches.above}
          title={`Switch branch · ${git.repo}`}
          onClose={() => setBranches(null)}
          actions={[
            ...branches.local.map((b) => ({ icon: b === branches.current ? <LuCheck /> : <LuGitBranch />, label: b, run: () => (b === branches.current ? undefined : void call('switch', { branch: b })) })),
            ...branches.remote.map((b) => ({ icon: <LuCloud />, label: b, run: () => void call('switch', { branch: b }) })),
          ]}
        />
      )}
    </div>
  )
}

/** Commit everything not committed yet (a message, and whose identity: the folder's agent by default); can push too. */
function CommitModal({ git, root, dir, onClose, onDone }: { git: FolderGit; root: string; dir: string; onClose: () => void; onDone: () => void }) {
  const agents = useOffice((s) => s.agents)
  const [message, setMessage] = useState('')
  const [as, setAs] = useState(git.committer?.agentId ?? '')
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [error, setError] = useState('')
  const post = async (action: 'commit' | 'push') => {
    const r = await api(`/api/workspaces/git/${action}`, { method: 'POST', body: JSON.stringify({ root, path: dir, message, agentId: as || undefined }) })
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not ${action} (${r.status})`)
  }
  const submit = async (andPush: boolean) => {
    if (!message.trim() || busy) return
    setError('')
    setBusy('commit')
    try {
      await post('commit')
      if (andPush) {
        setBusy('push')
        try {
          await post('push')
        } catch (e) {
          // committed all the same: say why the push didn't go
          onDone()
          setBusy(null)
          return setError(`Committed, but not pushed: ${e instanceof Error ? e.message : 'the push failed'}`)
        }
      }
      onDone()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not commit')
    } finally {
      setBusy(null)
    }
  }
  const canPush = !!git.hasRemote && !!git.branch
  return (
    <Modal open onClose={onClose} title={`Commit to ${git.branch ?? 'HEAD'}`} description={`${git.dirty} change${git.dirty === 1 ? '' : 's'} in ${git.repo}, all of them`} width={480}>
      <div className="modal__body git-commit">
        <label className="field">
          <span className="field__label">Message</span>
          <textarea
            className="git-commit__msg"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What changed, e.g. fix: login redirect"
            rows={3}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void submit(false)}
          />
        </label>
        <label className="field">
          <span className="field__label">As</span>
          <Select
            ariaLabel="Whose git identity"
            value={as}
            options={[...agents.map((a) => ({ value: a.id, label: a.name })), ...(as ? [] : [{ value: '', label: 'The server’s git settings' }])]}
            onChange={setAs}
          />
          <span className="field__hint">Their git name, email and SSH key (Overview → Git) sign the commit and push it.</span>
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button onClick={onClose}>Cancel</button>
          {canPush && (
            <button onClick={() => void submit(true)} disabled={!message.trim() || !!busy}>
              {busy === 'push' ? <LuLoader className="spin" /> : <LuArrowUpFromLine />} Commit & push
            </button>
          )}
          <button className="primary" onClick={() => void submit(false)} disabled={!message.trim() || !!busy} data-tip="⌘↵ / Ctrl+↵">
            {busy === 'commit' ? <LuLoader className="spin" /> : <LuGitCommitHorizontal />} Commit
          </button>
        </footer>
      </div>
    </Modal>
  )
}
