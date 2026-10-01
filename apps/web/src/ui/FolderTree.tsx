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

/** What's inside `rel` of the folder `root`, read when shown. */
export function FolderTree({ root, rel = '', depth, projectAt }: { root: string; rel?: string; depth: number; projectAt?: ProjectAt }) {
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
  if (!listing.entries.length) return <div className="tree__note muted" style={pad}>Empty folder</div>
  return (
    <ul className="tree">
      {listing.entries.map((e) => {
        const path = join(rel, e.name)
        if (e.dir && !e.link) return <TreeDir key={e.name} root={root} rel={path} name={e.name} depth={depth} projectAt={projectAt} />
        const previewable = !e.dir && canPreview({ path: e.name, size: e.size })
        return (
          <li key={e.name}>
            <button
              className={`tree__row tree__file${e.link ? ' is-link' : ''}`}
              style={pad}
              disabled={e.link}
              data-tip={e.link ? 'A link to somewhere else: not opened here' : previewable ? 'Preview' : 'Download'}
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

function TreeDir({ root, rel, name, depth, projectAt }: { root: string; rel: string; name: string; depth: number; projectAt?: ProjectAt }) {
  const tree = useContext(TreeContext)
  const key = `${root}/${rel}`
  const open = tree.isOpen(key)
  const project = projectAt?.(`${root}/${rel}`)
  return (
    <li>
      <div className="tree__row tree__dir" style={{ ['--depth' as string]: depth }}>
        <Chevron open={open} onClick={() => tree.toggle(key)} label={name} />
        <button className="tree__open" onClick={() => (project ? project.open() : tree.toggle(key))} data-tip={project ? 'Details' : undefined}>
          <LuFolder className="tree__icon tree__icon--dir" />
          <span className="tree__name-wrap">
            <span className="tree__name-line">
              <span className="tree__name truncate">{name}</span>
              {project?.tag}
            </span>
            {project?.sub}
          </span>
        </button>
      </div>
      {open && <FolderTree root={root} rel={rel} depth={depth + 1} projectAt={projectAt} />}
    </li>
  )
}
