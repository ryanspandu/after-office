import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Attachment } from '@after-office/shared'
import { baseName, canPreview, fileUrl, FilePreview, sameFile, saveUrl, type UrlFor } from './Attachments'
export { FILE_HREF, remarkFileLinks } from './remarkFileLinks'

// File paths in an agent's text ("File: ~/after-office/sari/keywords.md", `keywords.md`) become buttons: a text file
// opens in the preview, a picture in a new tab, anything else downloads. Only paths the server already checked (the
// message's or report's attachments) are linked; the rest stays plain text.

interface FileLinks {
  find: (path: string) => Attachment | undefined
  open: (file: Attachment) => void
}

const Ctx = createContext<FileLinks | null>(null)
export const useFileLinks = () => useContext(Ctx)

export function FileLinksProvider({ agentId, files, urlFor, children }: { agentId: string; files: Attachment[]; urlFor?: UrlFor; children: ReactNode }) {
  const [preview, setPreview] = useState<Attachment | null>(null)
  const url = useCallback<UrlFor>((path, inline) => (urlFor ? urlFor(path, inline) : fileUrl(agentId, path, inline)), [agentId, urlFor])
  const find = useCallback((path: string) => files.find((f) => sameFile(path, f.path)), [files])
  const open = useCallback(
    (f: Attachment) => {
      if (f.missing) return
      if (canPreview(f)) setPreview(f)
      else if (f.image) window.open(url(f.path, true), '_blank', 'noopener,noreferrer')
      else saveUrl(url(f.path), baseName(f.path))
    },
    [url],
  )
  const value = useMemo(() => (files.length ? { find, open } : null), [files.length, find, open])
  return (
    <Ctx.Provider value={value}>
      {children}
      {preview && <FilePreview file={preview} url={url(preview.path)} onClose={() => setPreview(null)} />}
    </Ctx.Provider>
  )
}

/** The button a linked path renders as (Markdown's `a` for #ao-file: links). */
export function FileLinkButton({ path, children }: { path: string; children: ReactNode }) {
  const links = useFileLinks()
  const file = links?.find(path)
  if (!links || !file) return <>{children}</>
  if (file.missing)
    return (
      <span className="md-file md-file--gone" data-tip="This file no longer exists">
        {children}
      </span>
    )
  const what = canPreview(file) ? 'Preview' : file.image ? 'Open' : 'Download'
  return (
    <button type="button" className="md-file" onClick={() => links.open(file)} data-tip={`${what} ${baseName(file.path)}`}>
      {children}
    </button>
  )
}
