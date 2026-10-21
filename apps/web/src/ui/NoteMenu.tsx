import { useState } from 'react'
import { LuBookOpen, LuCheck, LuExternalLink, LuFolder, LuFolderX, LuPin, LuPinOff, LuTags, LuTrash2, LuUsers, LuUserX } from 'react-icons/lu'
import type { OwnerNoteSummary } from '@after-office/shared'
import { api } from '../state/auth'
import { useLive } from '../state/live'
import { openUrl } from '../state/url'
import { ActionMenu, type MenuAction } from './ActionMenu'
import { confirm } from './Confirm'
import { Field, Modal } from './Modal'
import { NotePageSelect } from './NotePages'
import { ProjectFolderPicker } from './ProjectFolderPicker'
import { TagPicker } from './tags'

// A note's right-click menu (its row in a list): open it, pin it, share it, put it on a page, its tags and folder, or
// delete it, without opening the note. Changes show at once (the live list) and are stored on the server.

export type NotePatch = { pinned?: boolean; shared?: boolean; pageId?: string | null; folder?: string | null; tags?: string[] }

export async function patchNote(n: OwnerNoteSummary, patch: NotePatch) {
  // shown right away; the server's version follows on the live stream
  const local: Partial<OwnerNoteSummary> = {}
  if (patch.pinned !== undefined) local.pinned = patch.pinned || undefined
  if (patch.shared !== undefined) local.shared = patch.shared || undefined
  if (patch.pageId !== undefined) local.pageId = patch.pageId ?? undefined
  if (patch.folder !== undefined) local.folder = patch.folder ?? undefined
  if (patch.tags !== undefined) local.tags = patch.tags.length ? patch.tags : undefined
  const before = useLive.getState().notes
  useLive.setState({ notes: before.map((x) => (x.id === n.id ? { ...x, ...local } : x)) })
  const r = await api(`/api/notes/${encodeURIComponent(n.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!r.ok) {
    useLive.setState({ notes: before })
    throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save')
  }
}

async function deleteNote(n: OwnerNoteSummary) {
  if (!(await confirm({ title: 'Delete this note?', message: <>“{n.title || 'Untitled'}” is deleted for good.</>, confirmLabel: 'Delete note' }))) return
  const r = await api(`/api/notes/${encodeURIComponent(n.id)}`, { method: 'DELETE' })
  if (r.ok) useLive.setState((s) => ({ notes: s.notes.filter((x) => x.id !== n.id) }))
}

/** The menu at a point (a right click on the note's row), and the small windows its items open. */
export function NoteMenu({ n, at, onClose, onOpen }: { n: OwnerNoteSummary; at: { x: number; y: number } | null; onClose: () => void; onOpen: () => void }) {
  const [edit, setEdit] = useState<'page' | 'tags' | 'folder' | null>(null)
  const run = (p: NotePatch) => void patchNote(n, p).catch(() => {})
  const actions: MenuAction[] = [
    { icon: <LuExternalLink />, label: 'Open', run: onOpen },
    n.pinned ? { icon: <LuPinOff />, label: 'Unpin', run: () => run({ pinned: false }) } : { icon: <LuPin />, label: 'Pin to top', run: () => run({ pinned: true }) },
    n.shared
      ? { icon: <LuUserX />, label: 'Stop sharing with agents', run: () => run({ shared: false }) }
      : { icon: <LuUsers />, label: 'Share with agents', run: () => run({ shared: true }) },
    { icon: <LuBookOpen />, label: 'Move to page…', run: () => setEdit('page') },
    { icon: <LuTags />, label: 'Tags…', run: () => setEdit('tags') },
    { icon: <LuFolder />, label: n.folder ? 'Change folder…' : 'Set folder…', run: () => setEdit('folder') },
    ...(n.folder ? [{ icon: <LuFolderX />, label: 'Remove folder', run: () => run({ folder: null }) }] : []),
    { icon: <LuTrash2 />, label: 'Delete', danger: true, run: () => void deleteNote(n) },
  ]
  return (
    <>
      {at && <ActionMenu x={at.x} y={at.y} title={n.title || 'Untitled'} actions={actions} onClose={onClose} />}
      {edit === 'page' && <PageModal n={n} onClose={() => setEdit(null)} />}
      {edit === 'tags' && <TagsModal n={n} onClose={() => setEdit(null)} />}
      {edit === 'folder' && <ProjectFolderPicker onPick={(folder) => run({ folder })} onClose={() => setEdit(null)} />}
    </>
  )
}

function PageModal({ n, onClose }: { n: OwnerNoteSummary; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Move to page" description={n.title || 'Untitled'} width={380}>
      <div className="modal__body">
        <Field label="Page">
          <NotePageSelect value={n.pageId} onChange={(pageId) => void patchNote(n, { pageId }).then(onClose, () => {})} />
        </Field>
      </div>
    </Modal>
  )
}

function TagsModal({ n, onClose }: { n: OwnerNoteSummary; onClose: () => void }) {
  const [tags, setTags] = useState<string[]>(n.tags ?? [])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  return (
    <Modal open onClose={onClose} title="Tags" description={n.title || 'Untitled'} width={420}>
      <form
        className="modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          setSaving(true)
          patchNote(n, { tags }).then(onClose, (err: Error) => (setError(err.message), setSaving(false)))
        }}
      >
        <Field label="Tags">
          <TagPicker value={tags} onChange={setTags} />
        </Field>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <button type="submit" className="primary" disabled={saving}>
            <LuCheck /> Save
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/** Opens the menu of a note at the pointer. */
export const noteMenuAt = (e: React.MouseEvent) => {
  e.preventDefault()
  return { x: e.clientX, y: e.clientY }
}
