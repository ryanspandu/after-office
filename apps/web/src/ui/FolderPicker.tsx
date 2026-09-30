import { useEffect, useState } from 'react'
import { LuChevronRight, LuFolder, LuFolderOpen, LuFolderRoot, LuHouse, LuLoader } from 'react-icons/lu'
import type { DirListing } from '@after-office/shared'
import { api } from '../state/auth'

// Browse the server's folders (only under the allowed roots) or type a path. Starts in the After Office folder.

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export function FolderPicker({ value, onChange, start }: { value: string; onChange: (path: string) => void; start?: string }) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /** `path`: absolute, "~/…", relative to the default folder, or '' for the default folder. */
  const load = async (path: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await api(`/api/fs?path=${encodeURIComponent(path)}`)
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? res.statusText)
      setListing(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load folders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(start ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openTyped = () => value.trim() && load(value.trim())
  const crumbs = listing?.relative ? listing.relative.split('/') : []
  const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')

  return (
    <div className="picker">
      <div className="picker__path">
        <LuFolderOpen className="muted" />
        <input
          className="mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              openTyped()
            }
          }}
          placeholder={listing?.defaultDir ?? '/home/you/projects/my-app'}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
        <button type="button" className="small" onClick={openTyped} disabled={!value.trim()}>
          Open
        </button>
      </div>
      <div className="picker__crumbs">
        {listing?.roots.map((r) => (
          <button
            key={r}
            type="button"
            className={`crumb crumb--root${listing.root === r && !listing.relative ? ' active' : ''}`}
            onClick={() => load(r)}
            data-tip={r}
          >
            {r === listing.roots[listing.roots.length - 1] && /\/(home|Users)\//.test(r) ? <LuHouse /> : <LuFolderRoot />}
            <span>{baseName(r)}</span>
          </button>
        ))}
        {listing && listing.defaultDir !== listing.path && (
          <button type="button" className="crumb" onClick={() => load('')} data-tip={`Back to ${listing.defaultDir}`}>
            {baseName(listing.defaultDir)}
          </button>
        )}
        {loading && <LuLoader className="spin muted" />}
      </div>
      {crumbs.length > 0 && listing && (
        <div className="picker__crumbs picker__crumbs--path">
          <span className="muted mono">{baseName(listing.root)}</span>
          {crumbs.map((c, i) => (
            <span key={i} className="crumb-wrap">
              <LuChevronRight className="muted" />
              <button type="button" className="crumb" onClick={() => load(join(listing.root, ...crumbs.slice(0, i + 1)))}>
                {c}
              </button>
            </span>
          ))}
        </div>
      )}
      <ul className="picker__list">
        {error && <li className="empty">{error === 'not readable' ? 'Folder not found. It can still be used: it will be created on the server.' : error}</li>}
        {!error && listing && !listing.dirs.length && <li className="empty">No sub-folders</li>}
        {listing?.dirs.map((d) => (
          <li key={d}>
            <button type="button" onClick={() => load(join(listing.path, d))}>
              <LuFolder /> {d}
            </button>
          </li>
        ))}
      </ul>
      <div className="picker__foot">
        <span className="mono truncate muted" data-tip={listing?.path}>
          {listing?.path ?? '…'}
        </span>
        <button type="button" className="small primary" disabled={!listing || listing.path === value} onClick={() => listing && onChange(listing.path)}>
          Use this folder
        </button>
      </div>
    </div>
  )
}
