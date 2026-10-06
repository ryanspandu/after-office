import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { LuCheck, LuEye, LuLoader, LuLock, LuMinus, LuPencil, LuSave } from 'react-icons/lu'
import { api } from '../state/auth'
import { useDaylight } from '../state/clock'
import { confirm } from './Confirm'
import { Markdown } from './FollowUps'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'
import { useMinimized } from '../state/minimized'
import { closeFile, fileSaved, minimizeFile, useOpenFiles } from '../state/openFiles'

// A text file of a folder opened in an editor (the Files browser): VS Code's look, its language's colours, saved in
// place (⌘S). It opens for reading (Markdown as a page, code read only); Edit turns it into the editor. A save over
// a version an agent wrote meanwhile asks first.

const CodeMirrorBox = lazy(() => import('./CodeMirrorBox'))

/** Opened in the editor when clicked (instead of a preview or a download): text and code by their name. */
const TEXT_EXT = new Set(
  'md mdx markdown txt text log env ini cfg conf properties toml json jsonc json5 yml yaml xml svg plist csv tsv js mjs cjs jsx ts mts cts tsx css scss less html htm vue svelte py rb php go rs java kt kts swift c h cpp hpp cs sh bash zsh fish sql graphql gql prisma lock gitignore dockerignore npmrc nvmrc editorconfig'.split(
    ' ',
  ),
)
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'procfile', 'license', 'readme', 'claude.md', 'agents.md'])
export function isTextFile(name: string) {
  const base = name.toLowerCase()
  if (TEXT_NAMES.has(base)) return true
  // dotfiles with no other dot (.env, .gitignore, .bashrc…) are text
  if (base.startsWith('.') && !base.slice(1).includes('.')) return true
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  return TEXT_EXT.has(ext) || base.startsWith('.env.')
}

interface Loaded {
  text: string
  updatedAt: number
  editable: boolean
}

export function FileEditor({
  root,
  path,
  onClose,
  onSaved,
  edit = false,
  onMinimize,
  hidden,
}: {
  root: string
  path: string
  onClose: () => void
  onSaved?: () => void
  edit?: boolean
  /** put it aside as a chip (it stays open, hidden, with what's typed) */
  onMinimize?: () => void
  /** minimized */
  hidden?: boolean
}) {
  const name = path.split('/').pop() ?? path
  const dark = useDaylight() < 0.5
  const max = useModalMaximize(980, 'after-office:file-editor-full')
  const [file, setFile] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const markdown = /\.(md|mdx|markdown)$/i.test(name)
  // reading (the default) or editing (Edit; a new file, or Edit from its menu, opens editing)
  const [editing, setEditing] = useState(edit)
  // while editing Markdown: how it reads
  const [preview, setPreview] = useState(false)
  const dirty = !!file && text !== file.text

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await api(`/api/workspaces/text?${new URLSearchParams({ root, path })}`)
      const data = await r.json().catch(() => null)
      if (!r.ok) throw new Error(data?.error ?? `Could not open it (${r.status})`)
      setFile(data)
      setText(data.text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open it')
    }
  }, [root, path])
  useEffect(() => void load(), [load])

  const save = async (force = false) => {
    if (!file || !file.editable || saving || (!dirty && !force)) return
    setSaving(true)
    setError('')
    try {
      const r = await api('/api/workspaces/text', { method: 'PUT', body: JSON.stringify({ root, path, text, since: file.updatedAt, force }) })
      const data = await r.json().catch(() => null)
      if (r.status === 409) {
        setSaving(false)
        const overwrite = await confirm({ title: 'It changed since you opened it', message: 'Someone (an agent?) saved this file after you opened it. Save yours over it, or keep theirs and reload?', confirmLabel: 'Save mine anyway' })
        if (overwrite) return void save(true)
        if (await confirm({ title: 'Reload the file?', message: 'Your changes here are dropped and the newer version is opened.', confirmLabel: 'Reload' })) void load()
        return
      }
      if (!r.ok) throw new Error(data?.error ?? `Could not save (${r.status})`)
      setFile({ ...file, text, updatedAt: data.updatedAt })
      setSavedAt(Date.now())
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }
  // ⌘S in the editor: always the latest text
  const saveRef = useRef(save)
  saveRef.current = save

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Close without saving?', message: `Your changes to ${name} are lost.`, confirmLabel: 'Discard changes' }))) return
    onClose()
  }

  return (
    <Modal
      open
      onClose={() => void close()}
      // a click beside it puts it aside when it can be (nothing is lost); else it asks, as closing does
      onBackdrop={onMinimize ?? (() => void close())}
      hidden={hidden}
      title={name}
      description={path}
      {...max.modalProps}
      className={`code-editor${max.modalProps.className ? ` ${max.modalProps.className}` : ''}`}
      actions={
        <>
          {file && !file.editable && (
            <span className="code-editor__ro" data-tip="The office manages this file (or git does): read only">
              <LuLock /> Read only
            </span>
          )}
          {file?.editable && editing && <span className="code-editor__state muted">{saving ? 'Saving…' : dirty ? 'Unsaved' : savedAt ? 'Saved' : ''}</span>}
          {markdown && file && editing && (
            <button className="icon-btn small ghost" aria-pressed={preview} onClick={() => setPreview((v) => !v)} data-tip={preview ? 'Back to the text' : 'Preview'} aria-label={preview ? 'Back to the text' : 'Preview'}>
              {preview ? <LuPencil /> : <LuEye />}
            </button>
          )}
          {file?.editable && !editing && (
            <button className="small" onClick={() => (setEditing(true), setPreview(false))} data-tip="Change this file">
              <LuPencil /> Edit
            </button>
          )}
          {file?.editable && editing && (
            // back to reading, what was typed since the last save thrown away
            <button
              className="small"
              onClick={async () => {
                if (dirty && !(await confirm({ title: 'Discard your changes?', message: `What you changed in ${name} since it was last saved is thrown away.`, confirmLabel: 'Discard changes' }))) return
                setText(file.text)
                setPreview(false)
                setEditing(false)
              }}
              disabled={saving}
              data-tip={dirty ? 'Throw away your changes and stop editing' : 'Stop editing'}
            >
              Cancel
            </button>
          )}
          {file?.editable && editing && (
            <button className="small primary" onClick={() => void save()} disabled={!dirty || saving} data-tip="Save (⌘S / Ctrl+S)">
              {savedAt && !dirty ? <LuCheck /> : <LuSave />} Save
            </button>
          )}
          {onMinimize && (
            <button className="icon-btn small ghost" onClick={onMinimize} data-tip="Minimize (it stays open, with your changes)" aria-label="Minimize">
              <LuMinus />
            </button>
          )}
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body code-editor__body" ref={max.bodyRef}>
        {error && <p className="danger-text code-editor__error">{error}</p>}
        {!file ? (
          !error && (
            <div className="empty">
              <LuLoader className="spin" />
            </div>
          )
        ) : (markdown && !editing) || (editing && preview) ? (
          <div className="code-editor__preview">
            <Markdown text={text} />
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="empty">
                <LuLoader className="spin" />
              </div>
            }
          >
            <CodeMirrorBox name={name} value={text} onChange={setText} onSave={() => void saveRef.current()} readOnly={!file.editable || !editing} dark={dark} focus={editing} />
          </Suspense>
        )}
      </div>
    </Modal>
  )
}

/** Every open file's window (state/openFiles.ts): minimized ones stay mounted, hidden, so what's typed is kept. */
export function FileEditors() {
  const files = useOpenFiles((st) => st.files)
  const minimized = useMinimized((st) => st.folders)
  return (
    <>
      {files.map((f) => (
        <FileEditor
          key={f.key}
          root={f.root}
          path={f.path}
          edit={f.edit}
          hidden={minimized.some((m) => m.path === f.key)}
          onMinimize={() => minimizeFile(f.key, f.path.split('/').pop() ?? f.path)}
          onClose={() => closeFile(f.key)}
          onSaved={() => fileSaved(f.root)}
        />
      ))}
    </>
  )
}
