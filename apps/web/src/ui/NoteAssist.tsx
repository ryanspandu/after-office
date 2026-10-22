import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { LuLightbulb, LuLoader, LuPaperclip, LuPencilLine, LuSend, LuSparkles, LuX } from 'react-icons/lu'
import { liveApi, useLive } from '../state/live'
import { avatarStyle, useOffice, type OfficeAgent } from '../state/store'
import { ChatView } from './agent/ChatTab'
import { ComposerBox, type ComposerHandle } from './agent/ComposerBox'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { confirm } from './Confirm'
import type { RichNotesApi } from './FolderNotes'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'
import { NoteBlockContext, type NoteBlockActions } from './noteBlocks'
import { tip } from './Tooltip'
import { AgentFace } from './AgentFace'

// "Ask Marcus" while writing a note: a chat with the manager in the note's own hidden thread (server:
// work/noteAssist.ts). Desktop: a panel on the right of the note's window; phones: a bottom sheet over it (?nai=1).
// His ```note blocks come with Insert / Replace note (ui/noteBlocks.tsx); his ```note-edit blocks go into the note at
// once, with Undo.

const SUGGESTIONS = ['Summarize this note', 'Fix grammar', 'Make it a checklist', 'Continue writing']
/** Edit mode's one-tap jobs (a writing assistant): each changes the note itself */
const QUICK = ['Fix grammar & typos', 'Improve the writing', 'Make it shorter', 'Make it a checklist', 'Continue writing']

/** How Marcus helps (remembered): 'edit' changes the note itself (Undo after), 'suggest' gives text to insert. */
type AssistMode = 'edit' | 'suggest'
const MODE_KEY = 'after-office:note-assist-mode'
function useAssistMode() {
  const [mode, setMode] = useState<AssistMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'suggest' ? 'suggest' : 'edit'
    } catch {
      return 'edit'
    }
  })
  const pick = (m: AssistMode) => {
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* this visit only */
    }
  }
  return [mode, pick] as const
}

/** The panel's top: Edit or Suggest, and (Edit) a few one-tap jobs for the note. */
function ModeBar({ mode, onMode, onQuick, busy }: { mode: AssistMode; onMode: (m: AssistMode) => void; onQuick?: (job: string) => void; busy?: boolean }) {
  return (
    <div className="note-assist__mode">
      <div className="note-assist__seg" role="tablist" aria-label="How Marcus helps">
        <button role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => onMode('edit')} {...tip('He changes the note himself (Undo after)')}>
          <LuPencilLine /> Edit
        </button>
        <button role="tab" aria-selected={mode === 'suggest'} className={mode === 'suggest' ? 'active' : ''} onClick={() => onMode('suggest')} {...tip('He suggests text; you insert it')}>
          <LuLightbulb /> Suggest
        </button>
      </div>
      {mode === 'edit' && onQuick && (
        <div className="note-assist__quick">
          {QUICK.map((q) => (
            <button key={q} type="button" className="small" disabled={busy} onClick={() => onQuick(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The header's ✨ (desktop): a note not saved yet has no helper. */
export function NoteAssistButton({ saved, on, onToggle }: { saved: boolean; on: boolean; onToggle: () => void }) {
  return (
    <button
      className={`icon-btn small ghost note-assist-btn${on ? ' is-on' : ''}`}
      onClick={onToggle}
      disabled={!saved}
      aria-pressed={on}
      {...tip(saved ? 'Ask Marcus' : 'Ask Marcus: write something first (the note is saved then)')}
    >
      <LuSparkles />
    </button>
  )
}

/** Phones: the round ✨ at the bottom right of the editor. */
export function NoteAssistFab({ saved, onOpen }: { saved: boolean; onOpen: () => void }) {
  return (
    <button className="note-assist-fab" onClick={onOpen} disabled={!saved} {...tip(saved ? 'Ask Marcus' : 'Ask Marcus: write something first')}>
      <LuSparkles />
    </button>
  )
}

// Marcus's edits already put in a note (ui/noteBlocks.tsx NoteEdit), by a short hash of their text: reopening the chat
// doesn't put them in again
const FRESH_AFTER_MS = 3000
const EDITS_KEY = (noteId: string) => `after-office:note-edits:${noteId}`
const hashOf = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const editsOf = (noteId: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(EDITS_KEY(noteId)) ?? '[]') as string[]
  } catch {
    return []
  }
}
const rememberEdit = (noteId: string, md: string, prefix = '') => {
  try {
    localStorage.setItem(EDITS_KEY(noteId), JSON.stringify([...editsOf(noteId), `${prefix}${hashOf(md)}`].slice(-50)))
  } catch {
    /* this visit only */
  }
}

/** The chat itself: Marcus's side of it once the note has a helper, else a short intro with a few ways to start. */
export function NoteAssistChat({ noteId, editor }: { noteId: string; editor: RefObject<RichNotesApi | null> }) {
  const openedAt = useRef(Date.now())
  const [mode, setMode] = useAssistMode()
  const [quickBusy, setQuickBusy] = useState(false)
  const quick = (job: string) => {
    setQuickBusy(true)
    void liveApi
      .askNote(noteId, { text: job, mode: 'edit' })
      .catch(() => {})
      .finally(() => setQuickBusy(false))
  }
  const manager = useOffice((s) => s.agents.find((a) => a.kind === 'manager'))
  const t = useLive((s) => s.noteThreads.find((x) => x.noteId === noteId))
  const actions = useMemo<NoteBlockActions>(
    () => ({
      insert: (md) => editor.current?.insert(md),
      replace: async (md) => {
        if (!editor.current) return false
        if (!(await confirm({ title: 'Replace the whole note?', message: "Its text becomes Marcus's suggestion (Undo in the editor brings it back).", confirmLabel: 'Replace note' }))) return false
        editor.current.replace(md)
        return true
      },
      apply: (md) => {
        const ed = editor.current
        if (!ed) return null
        const before = ed.html()
        ed.replace(md)
        rememberEdit(noteId, md)
        return () => ed.setHtml(before)
      },
      applied: (md) => editsOf(noteId).includes(hashOf(md)),
      used: (md) => (editsOf(noteId).includes(`i:${hashOf(md)}`) ? 'insert' : editsOf(noteId).includes(`r:${hashOf(md)}`) ? 'replace' : null),
      markUsed: (md, how) => rememberEdit(noteId, md, how === 'insert' ? 'i:' : 'r:'),
      // the history shows within moments of opening; what comes after is new
      fresh: () => Date.now() - openedAt.current > FRESH_AFTER_MS,
    }),
    [editor, noteId],
  )
  // seen: its replies are read
  useEffect(() => {
    if (!t?.unread) return
    const tm = setTimeout(() => void liveApi.readThread(t.id).catch(() => {}), 800)
    return () => clearTimeout(tm)
  }, [t?.id, t?.unread])
  if (!manager) return <div className="note-assist__empty muted">Ask Marcus needs the manager: add one to the office first.</div>
  if (!t) return <NoteAssistIntro noteId={noteId} manager={manager} mode={mode} onMode={setMode} />
  const side = manager.sessions?.find((s) => s.key === t.sessionKey && s.open)
  // its session's own state, like a thread's; resting (closed) reads as ready: a message opens it again
  const view: OfficeAgent = side
    ? { ...manager, status: side.status, waitingFor: side.waitingFor, tool: side.tool, permissionMode: side.permissionMode, costUsd: side.costUsd, contextPct: side.contextPct, contextTokens: undefined, contextSize: undefined, compactingSince: side.compactingSince, lastMessage: side.lastMessage, unread: side.unread, error: undefined }
    : { ...manager, status: 'idle', waitingFor: undefined, tool: undefined, contextPct: t.contextPct ?? null, contextTokens: undefined, contextSize: undefined, compactingSince: undefined, unread: 0, error: undefined }
  // what the session bar would say, in one line: only while he's at it
  const doing = view.status === 'working' ? `${manager.name} is writing…` : view.status === 'waiting' ? `${manager.name} needs you` : view.compactingSince ? 'Compacting…' : null
  return (
    <NoteBlockContext.Provider value={actions}>
      <ModeBar mode={mode} onMode={setMode} onQuick={quick} busy={quickBusy || view.status === 'working'} />
      {doing && (
        <div className="note-assist__doing muted" role="status">
          <LuLoader className="spin" /> {doing}
        </div>
      )}
      <ChatView
        key={`${t.id}:${t.sessionKey}`}
        agent={view}
        session={t.sessionKey}
        header={null}
        thread={{
          placeholder: `Ask ${manager.name}…`,
          bare: true,
          send: (text, uploads) => liveApi.askNote(noteId, { text, uploads, mode }),
          mention: () => null,
          names: [],
          compact: () => liveApi.compactThread(t.id).then(() => undefined),
          queued: t.queued,
          queue: {
            hold: (qid, held) => liveApi.holdQueued(t.id, qid, held),
            edit: (qid, text) => liveApi.editQueued(t.id, qid, text),
            unsend: (qid) => liveApi.unsendQueued(t.id, qid),
          },
        }}
      />
    </NoteBlockContext.Provider>
  )
}

/** Before the first message: what Marcus can do here, and a few ways to start. */
function NoteAssistIntro({ noteId, manager, mode, onMode }: { noteId: string; manager: OfficeAgent; mode: AssistMode; onMode: (m: AssistMode) => void }) {
  // the same message box, in the same place, as once the chat is there (ChatView's, bare)
  const composer = useRef<ComposerHandle>(null)
  const [hasText, setHasText] = useState(false)
  const mobile = useMediaQuery(MOBILE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ask = async (words: string) => {
    if (!words.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      // the helper's thread is made now; its chat takes over once the dashboard hears of it
      await liveApi.askNote(noteId, { text: words.trim(), mode })
      composer.current?.set('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send')
      setBusy(false)
    }
  }
  return (
    <div className={`chat chat--bare note-assist__start${mobile ? ' chat--mobile' : ''}`}>
      <ModeBar mode={mode} onMode={onMode} />
      <div className="note-assist__empty">
        <LuSparkles className="note-assist__spark" aria-hidden />
        <p>
          {mode === 'edit' ? (
            <>
              {manager.name} works on this note with you: fix, improve, shorten or continue it. He <b>changes the note himself</b>, and every edit
              can be undone.
            </>
          ) : (
            <>
              {manager.name} suggests text for this note; each suggestion comes with an <b>Insert</b> button, and nothing changes until you press
              it.
            </>
          )}
        </p>
        <div className="note-assist__chips">
          {(mode === 'edit' ? QUICK : SUGGESTIONS).map((s) => (
            <button key={s} type="button" className="small" disabled={busy} onClick={() => void ask(s)}>
              {s}
            </button>
          ))}
        </div>
        {busy && (
          <span className="muted note-assist__starting">
            <LuLoader className="spin" /> Starting {manager.name}… (about 15 s)
          </span>
        )}
      </div>
      {error && <div className="chat__error">{error}</div>}
      <div className="chat__composer">
        {/* files go in once the chat has started (they're kept with its session) */}
        <button className="icon-btn ghost chat__attach" disabled {...tip('Attach files once the chat has started')}>
          <LuPaperclip />
        </button>
        <ComposerBox
          ref={composer}
          draftKey={`${manager.id}:note-${noteId}`}
          placeholder={`Ask ${manager.name}…`}
          disabled={busy}
          enterSends={!mobile}
          onSubmit={() => void ask(composer.current?.get() ?? '')}
          onFiles={() => setError('Attach files once the chat has started')}
          onHasText={setHasText}
        />
        <button className="icon-btn primary" onClick={() => void ask(composer.current?.get() ?? '')} disabled={busy || !hasText} aria-label="Send" data-tip="Send">
          {busy ? <LuLoader className="spin" /> : <LuSend />}
        </button>
      </div>
    </div>
  )
}

/** Who helps: the manager's avatar, name and "Writing help" (the panel's header, the sheet's title). */
function AssistHeading({ manager }: { manager?: OfficeAgent }) {
  return (
    <span className="note-assist__who">
      {manager && (
        <span className="avatar avatar--xs" style={avatarStyle(manager.look.shirt)}>
          <AgentFace look={manager.look} />
        </span>
      )}
      <b className="truncate">{manager?.name ?? 'Marcus'}</b>
      <span className="muted">Writing help</span>
    </span>
  )
}

/** Desktop: the panel on the right of the note's window. */
export function NoteAssistPanel({ noteId, editor, closing, onClose }: { noteId: string; editor: RefObject<RichNotesApi | null>; closing?: boolean; onClose: () => void }) {
  const manager = useOffice((s) => s.agents.find((a) => a.kind === 'manager'))
  return (
    // its column grows from nothing as the window widens: the inside keeps its own width meanwhile (no reflow)
    <aside className={`note-assist${closing ? ' note-assist--closing' : ''}`} aria-label="Writing help" inert={closing}>
      <div className="note-assist__inner">
        <header className="note-assist__head">
          <AssistHeading manager={manager} />
          <button className="icon-btn small ghost" onClick={onClose} {...tip('Close')}>
            <LuX />
          </button>
        </header>
        <div className="note-assist__body">
          <NoteAssistChat noteId={noteId} editor={editor} />
        </div>
      </div>
    </aside>
  )
}

/** Phones (and a folder's inline note): a sheet over the note, with the panel's header. */
export function NoteAssistSheet({ noteId, editor, onClose }: { noteId: string; editor: RefObject<RichNotesApi | null>; onClose: () => void }) {
  const manager = useOffice((s) => s.agents.find((a) => a.kind === 'manager'))
  // full size: the whole screen, and the chat the room of its Edit / Suggest bar (styles/phones-chat.css)
  const max = useModalMaximize(480, 'after-office:note-assist-full')
  const { className, ...modal } = max.modalProps
  return (
    <Modal open onClose={onClose} title={`${manager?.name ?? 'Marcus'} · Writing help`} heading={<AssistHeading manager={manager} />} {...modal} className={`note-assist-sheet${className ? ` ${className}` : ''}`}>
      <div ref={max.bodyRef} className="modal__body note-assist__body">
        <NoteAssistChat noteId={noteId} editor={editor} />
      </div>
    </Modal>
  )
}
