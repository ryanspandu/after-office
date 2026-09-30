import { useEffect, useRef, useState } from 'react'
import { LuFile, LuFileText, LuLoader, LuTriangleAlert, LuX } from 'react-icons/lu'
import { liveApi, type StagedUpload } from '../../state/live'
import { formatSize } from '../Attachments'

// Files the owner attaches in a chat. Attaching uploads a file to the server's staging area only (no agent can see it);
// sending the message moves it into the agent's folder (uploads/<date>/) and the message ends with a block listing
// them (server: agents/uploads.ts), which the chat turns back into previews. Removed from the tray, or never sent
// (chat closed, page left): deleted on the server.

const HEADER = '[Attached files]'
export const MAX_FILES = 10
export const MAX_BYTES = 20 * 1024 * 1024

/** A sent message → the owner's text and the files attached to it. */
export function splitAttachments(text: string): { text: string; paths: string[] } {
  const at = text.lastIndexOf(HEADER)
  if (at === -1) return { text, paths: [] }
  const lines = text.slice(at + HEADER.length).trim().split('\n')
  if (!lines.length || !lines.every((l) => l.startsWith('- '))) return { text, paths: [] }
  return { text: text.slice(0, at).trim(), paths: lines.map((l) => l.slice(2).trim()).filter(Boolean) }
}

export interface Pending {
  key: string
  file: File
  /** a local picture shown while (and after) it uploads */
  thumb?: string
  state: 'uploading' | 'done' | 'error'
  error?: string
  saved?: StagedUpload
}

const isImage = (f: File) => /^image\/(png|jpe?g|gif|webp|avif)$/i.test(f.type)

/** Screenshots pasted from the clipboard are all called image.png: give them a name that says when. */
function named(f: File) {
  if (f.name && f.name !== 'image.png') return f
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  return new File([f], `pasted-${stamp}.${ext}`, { type: f.type })
}

/** The files waiting to go with the next message: add (uploads at once), remove, and clear after sending. */
export function usePendingFiles(agentId: string) {
  const [items, setItems] = useState<Pending[]>([])
  const live = useRef(items)
  live.current = items
  /** keys removed while still uploading: their upload is deleted as soon as it lands */
  const dropped = useRef(new Set<string>())
  // closing the chat (or leaving the page) with files still attached: they were never sent, delete them
  useEffect(() => {
    const discardAll = (keepalive: boolean) => {
      for (const p of live.current) {
        if (p.saved) void liveApi.discardUpload(agentId, p.saved.id, keepalive)
        else dropped.current.add(p.key)
      }
    }
    const onLeave = () => discardAll(true)
    window.addEventListener('pagehide', onLeave)
    return () => {
      window.removeEventListener('pagehide', onLeave)
      discardAll(false)
      live.current.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb))
    }
  }, [agentId])

  const patch = (key: string, p: Partial<Pending>) => setItems((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)))

  const add = (files: File[]): string | null => {
    const room = MAX_FILES - live.current.length
    if (room <= 0) return `At most ${MAX_FILES} files per message`
    let problem: string | null = files.length > room ? `At most ${MAX_FILES} files per message` : null
    const next: Pending[] = []
    for (const raw of files.slice(0, room)) {
      const file = named(raw)
      if (file.size > MAX_BYTES) {
        problem = `${file.name} is bigger than ${MAX_BYTES / 1024 / 1024} MB`
        continue
      }
      if (!file.size) {
        problem = `${file.name} is empty`
        continue
      }
      next.push({ key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, thumb: isImage(file) ? URL.createObjectURL(file) : undefined, state: 'uploading' })
    }
    setItems((list) => [...list, ...next])
    for (const p of next)
      liveApi.upload(agentId, p.file).then(
        (saved) => {
          // removed (or the chat closed) while it was uploading
          if (dropped.current.delete(p.key)) return void liveApi.discardUpload(agentId, saved.id)
          patch(p.key, { state: 'done', saved })
        },
        (e) => patch(p.key, { state: 'error', error: e instanceof Error ? e.message : 'Upload failed' }),
      )
    return problem
  }
  const remove = (key: string) => {
    const gone = live.current.find((x) => x.key === key)
    if (!gone) return
    if (gone.thumb) URL.revokeObjectURL(gone.thumb)
    if (gone.saved) void liveApi.discardUpload(agentId, gone.saved.id)
    else if (gone.state === 'uploading') dropped.current.add(key)
    setItems((list) => list.filter((x) => x.key !== key))
  }
  /** The message went out with these: hand them over (their previews stay alive) and empty the tray. */
  const take = () => {
    const sent = live.current
    live.current = []
    setItems([])
    return sent
  }
  return {
    items,
    add,
    remove,
    take,
    uploading: items.some((p) => p.state === 'uploading'),
    /** ids of the staged ones (failed ones are left out) */
    ids: items.flatMap((p) => (p.state === 'done' && p.saved ? [p.saved.id] : [])),
  }
}

/** The tray above the message box: a thumbnail per picture, a card per other file, each with a remove button. */
export function PendingTray({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  if (!items.length) return null
  return (
    <div className="chat__tray" aria-label="Attached files">
      {items.map((p) => (
        <div key={p.key} className={`tray-item${p.thumb ? ' tray-item--image' : ''}${p.state === 'error' ? ' tray-item--error' : ''}`} data-tip={p.error ?? p.file.name}>
          {p.thumb ? (
            <img src={p.thumb} alt={p.file.name} />
          ) : (
            <>
              <span className="tray-item__icon">{/\.(md|txt|csv|json|log)$/i.test(p.file.name) ? <LuFileText /> : <LuFile />}</span>
              <span className="tray-item__meta">
                <span className="tray-item__name truncate">{p.file.name}</span>
                <span className="tray-item__size">{p.state === 'error' ? 'Failed' : formatSize(p.file.size)}</span>
              </span>
            </>
          )}
          {p.state === 'uploading' && (
            <span className="tray-item__state" aria-label="Uploading">
              <LuLoader className="spin" />
            </span>
          )}
          {p.state === 'error' && p.thumb && (
            <span className="tray-item__state tray-item__state--error" aria-label="Upload failed">
              <LuTriangleAlert />
            </span>
          )}
          <button type="button" className="tray-item__remove" onClick={() => onRemove(p.key)} aria-label={`Remove ${p.file.name}`}>
            <LuX />
          </button>
        </div>
      ))}
    </div>
  )
}

/** The files of a message being sent, from the local copies (they're in the agent's folder only once it's through). */
export function OutgoingFiles({ items }: { items: Pending[] }) {
  if (!items.length) return null
  return (
    <div className="chat__tray chat__tray--sent">
      {items.map((p) => (
        <div key={p.key} className={`tray-item${p.thumb ? ' tray-item--image' : ''}`} data-tip={p.file.name}>
          {p.thumb ? (
            <img src={p.thumb} alt={p.file.name} />
          ) : (
            <>
              <span className="tray-item__icon">{/\.(md|txt|csv|json|log)$/i.test(p.file.name) ? <LuFileText /> : <LuFile />}</span>
              <span className="tray-item__meta">
                <span className="tray-item__name truncate">{p.file.name}</span>
                <span className="tray-item__size">{formatSize(p.file.size)}</span>
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
