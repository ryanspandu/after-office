import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { LuChevronRight, LuFile, LuFileImage, LuFileText, LuFolder, LuLink, LuLoader } from 'react-icons/lu'
import type { FolderListing } from '@after-office/shared'
import { api } from '../state/auth'
import { canPreview, FilePreview, formatSize, saveUrl } from './Attachments'
import { fileUrl } from './FileBrowser'

// The Projects tab's folders as a tree: a chevron opens a folder in place (its subfolders and files, read when opened),
// subfolders open the same way, a file opens its preview (or downloads). Read through the same checked route as the
// file manager: inside the folder only, no links followed, nothing hidden.

/** Which folders are open (kept by the Projects tab, remembered in this browser). */
interface TreeState {
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
}
export const TreeContext = createContext<TreeState>({ isOpen: () => false, toggle: () => undefined })

/** A subfolder that is a project of the office: its tag and git line beside its name, and its name opens its details. */
export type ProjectAt = (absolutePath: string) => { tag: ReactNode; sub: ReactNode; open: () => void } | undefined

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** The chevron that opens a folder in place. */
export function Chevron({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button className="ws__fold" aria-expanded={open} aria-label={open ? `Fold ${label}` : `Open ${label}`} onClick={onClick}>
      <LuChevronRight />
    </button>
  )
}

/** Choosing a folder (the folder picker): only folders are listed, each with a "Use" button. */
export type PickDir = (absolutePath: string, name: string) => void

/** What's inside `rel` of the folder `root`, read when shown. */
/** `onOpenDir`: a subfolder's name opens its details (like a top-level folder's); unset, it opens / folds in place. */
export function FolderTree({ root, rel = '', depth, projectAt, pick, onOpenDir }: { root: string; rel?: string; depth: number; projectAt?: ProjectAt; pick?: PickDir; onOpenDir?: (path: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; size: number } | null>(null)
  useEffect(() => {
    let gone = false
    api(`/api/workspaces/files?${new URLSearchParams({ root, path: rel })}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not read the folder (${r.status})`)
        return (await r.json()) as FolderListing
      })
      .then((l) => !gone && setListing(l))
      .catch((e: Error) => !gone && setError(e.message))
    return () => void (gone = true)
  }, [root, rel])
  const pad = { ['--depth' as string]: depth }
  if (error) return <div className="tree__note row__error" style={pad}>{error}</div>
  if (!listing)
    return (
      <div className="tree__note muted" style={pad}>
        <LuLoader className="spin" />
      </div>
    )
  const entries = pick ? listing.entries.filter((e) => e.dir && !e.link) : listing.entries
  if (!entries.length) return <div className="tree__note muted" style={pad}>{pick ? 'No folders inside' : 'Empty folder'}</div>
  return (
    <ul className="tree">
      {entries.map((e) => {
        const path = join(rel, e.name)
        if (e.dir && !e.link) return <TreeDir key={e.name} root={root} rel={path} name={e.name} depth={depth} projectAt={projectAt} pick={pick} onOpenDir={onOpenDir} />
        const previewable = !e.dir && canPreview({ path: e.name, size: e.size })
        return (
          <li key={e.name}>
            <button
              className={`tree__row tree__file${e.link ? ' is-link' : ''}`}
              style={pad}
              disabled={e.link}
              onClick={() => (previewable ? setPreview({ path, size: e.size }) : saveUrl(fileUrl(root, path), e.name))}
            >
              <span className="tree__spacer" />
              {e.link ? <LuLink className="tree__icon" /> : e.image ? <LuFileImage className="tree__icon" /> : previewable ? <LuFileText className="tree__icon" /> : <LuFile className="tree__icon" />}
              <span className="tree__name truncate">{e.name}</span>
              {!e.dir && <span className="tree__size muted">{formatSize(e.size)}</span>}
            </button>
          </li>
        )
      })}
      {listing.more > 0 && (
        <li className="tree__note muted" style={pad}>
          …and {listing.more} more (open the folder for all)
        </li>
      )}
      {preview && <FilePreview file={{ path: `${root}/${preview.path}`, size: preview.size }} url={fileUrl(root, preview.path)} onClose={() => setPreview(null)} />}
    </ul>
  )
}

function TreeDir({ root, rel, name, depth, projectAt, pick, onOpenDir }: { root: string; rel: string; name: string; depth: number; projectAt?: ProjectAt; pick?: PickDir; onOpenDir?: (path: string) => void }) {
  const tree = useContext(TreeContext)
  const key = `${root}/${rel}`
  const open = tree.isOpen(key)
  const project = pick ? undefined : projectAt?.(`${root}/${rel}`)
  return (
    <li>
      <div className="tree__row tree__dir" style={{ ['--depth' as string]: depth }}>
        <Chevron open={open} onClick={() => tree.toggle(key)} label={name} />
        <button className="tree__open" onClick={() => (project ? project.open() : onOpenDir ? onOpenDir(`${root}/${rel}`) : tree.toggle(key))}>
          <LuFolder className="tree__icon tree__icon--dir" />
          <span className="tree__name-wrap">
            <span className="tree__name-line">
              <span className="tree__name truncate">{name}</span>
              {project?.tag}
            </span>
            {project?.sub}
          </span>
        </button>
        {pick && <UseButton onClick={() => pick(`${root}/${rel}`, name)} />}
      </div>
      {open && <FolderTree root={root} rel={rel} depth={depth + 1} projectAt={projectAt} pick={pick} onOpenDir={onOpenDir} />}
    </li>
  )
}

/** The folder picker's "Use this folder". */
export function UseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="small tree__use" onClick={onClick}>
      Use
    </button>
  )
}
