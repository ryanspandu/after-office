import { useState } from 'react'
import { LuFolderOpen, LuPencil, LuTrash2 } from 'react-icons/lu'
import { create } from 'zustand'
import { api } from '../state/auth'
import { openUrl } from '../state/url'
import { useWorkspaces } from '../state/workspaces'
import { ActionMenu } from './ActionMenu'
import { confirm } from './Confirm'
import { Modal } from './Modal'

// A folder in the Folders list (or its tree): right-click (or long-press) for Open, Rename and Move to trash. The
// server refuses an agent's own folder (or one holding it) and anything outside the office's folders.

interface Target {
  /** the office folder it's in (what the server checks it against), and its path inside it */
  root: string
  rel: string
  name: string
  x: number
  y: number
}

const useFolderMenu = create<{ target: Target | null; renaming: Target | null }>(() => ({ target: null, renaming: null }))

/** Open the menu for a folder at the pointer (an onContextMenu handler). */
export function folderMenuHandler(root: string, rel: string, name: string) {
  return (e: React.MouseEvent) => {
    if (!rel) return
    e.preventDefault()
    e.stopPropagation()
    useFolderMenu.setState({ target: { root, rel, name, x: e.clientX, y: e.clientY } })
  }
}

const post = async (path: string, body: unknown) => {
  const r = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Failed (${r.status})`)
  return r.json()
}
const refresh = () => void useWorkspaces.getState().load(true)

/** The menu and the rename window; mounted once where the folders are listed. */
export function FolderMenuLayer() {
  const target = useFolderMenu((s) => s.target)
  const renaming = useFolderMenu((s) => s.renaming)
  const close = () => useFolderMenu.setState({ target: null })
  const trash = async (t: Target) => {
    if (!(await confirm({ title: `Move “${t.name}” to the trash?`, message: 'Everything in it goes too. You can restore it from the trash (the trash button above the folders).', confirmLabel: 'Move to trash' }))) return
    try {
      await post('/api/workspaces/trash', { root: t.root, paths: [t.rel] })
      refresh()
    } catch (e) {
      await confirm({ title: 'Could not move it to the trash', message: (e as Error).message, confirmLabel: 'OK', danger: false })
    }
  }
  return (
    <>
      {target && (
        <ActionMenu
          x={target.x}
          y={target.y}
          title={target.name}
          onClose={close}
          actions={[
            { icon: <LuFolderOpen />, label: 'Open', run: () => (close(), openUrl({ folder: `${target.root}/${target.rel}` })) },
            { icon: <LuPencil />, label: 'Rename', run: () => useFolderMenu.setState({ target: null, renaming: target }) },
            { icon: <LuTrash2 />, label: 'Move to trash', danger: true, run: () => (close(), void trash(target)) },
          ]}
        />
      )}
      {renaming && <RenameFolder target={renaming} onClose={() => useFolderMenu.setState({ renaming: null })} />}
    </>
  )
}

function RenameFolder({ target, onClose }: { target: Target; onClose: () => void }) {
  const [name, setName] = useState(target.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const next = name.trim()
    if (!next || next === target.name) return onClose()
    setBusy(true)
    setError(null)
    try {
      await post('/api/workspaces/entry/rename', { root: target.root, path: target.rel, name: next })
      refresh()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Rename folder" width={400}>
      <form
        className="modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="field">
          <span className="field__label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} onFocus={(e) => e.target.select()} />
        </label>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
