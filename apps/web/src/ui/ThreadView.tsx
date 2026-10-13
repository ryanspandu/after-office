import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LuArchive, LuArchiveRestore, LuAtSign, LuChevronRight, LuCornerDownRight, LuFolder, LuGitBranch, LuFileText, LuFolderOpen, LuListTodo, LuMessagesSquare, LuMinus, LuPaperclip, LuPlus, LuTrash2, LuX } from 'react-icons/lu'
import type { ChatItem, OfficeThread, WorkReport } from '@after-office/shared'
import { mentionedPaths } from '@after-office/shared'
import { useShallow } from 'zustand/react/shallow'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { liveApi, useLive } from '../state/live'
import { useMinimized } from '../state/minimized'
import { avatarStyle, useOffice, type OfficeAgent } from '../state/store'
import { openUrl, setUrl, useParam } from '../state/url'
import { MOBILE, onBackdropTap, useMediaQuery } from '../state/useMediaQuery'
import { useSheetDrag } from '../state/useSheetDrag'
import { usePresence } from '../state/usePresence'
import { ChatView, type ChatJump } from './agent/ChatTab'
import { Attachments, reportUrl, useAgentFiles } from './Attachments'
import { FileBrowser } from './FileBrowser'
import { isFrameSheet, splitAttachments } from './agent/chatAttachments'
import { api } from '../state/auth'
import { confirm } from './Confirm'
import { ago } from './FollowUps'
import { MaximizeButton, useMaximize } from './Maximize'
import { Modal } from './Modal'
import { ReportRow } from './Reports'
import { FolderSelect, StatusPill } from './taskMeta'
import { TagPicker } from './tags'
import { useThreadState } from './Threads'
import { tip } from './Tooltip'

// A thread (?thread=<id>): the chat with the manager on the left, in the thread's own session (server:
// work/threads.ts); on the right what the topic made: its tasks, the files its reports carry, its reports. Phones:
// one column, with tabs. An @ in the message box hands the message to that agent as a task (the manager hears).

type Pane = 'chat' | 'subs' | 'tasks' | 'folder' | 'files' | 'reports'

/** Agents named in a message ("@Kai …"), the manager left out. */
function mentionsIn(text: string, agents: OfficeAgent[]) {
  const lower = text.toLowerCase()
  return agents
    .filter((a) => a.kind !== 'manager')
    .filter((a) => {
      const at = `@${a.name.toLowerCase()}`
      let i = lower.indexOf(at)
      while (i !== -1) {
        const next = lower[i + at.length]
        if (next === undefined || !/[\p{L}\p{N}_]/u.test(next)) return true
        i = lower.indexOf(at, i + 1)
      }
      return false
    })
    .map((a) => a.id)
}

/** The @ button: the agents to hand the message to (picking one writes "@Name " in the message box). */
function MentionButton({ onPick }: { onPick: (name: string) => void }) {
  const agents = useOffice(useShallow((s) => s.agents.filter((a) => a.kind !== 'manager')))
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const presence = usePresence(open, 140)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="mention" ref={ref}>
      <button className={`icon-btn ghost chat__attach${open ? ' is-on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} {...tip('Hand this message to an agent (@): it becomes their task; the manager hears')}>
        <LuAtSign />
      </button>
      {presence.mounted && (
        <div className={`popover mention__menu${presence.closing ? ' popover--closing' : ''}`} role="menu">
          <span className="mention__title">Hand it to</span>
          {agents.map((a) => (
            <button key={a.id} role="menuitem" className="mention__item" onClick={() => (onPick(`@${a.name} `), setOpen(false))}>
              <span className="avatar avatar--xs" style={avatarStyle(a.look.shirt)}>
                {a.name[0]}
              </span>
              <span className="truncate">{a.name}</span>
              <span className="muted truncate">{a.role || a.profile.role}</span>
            </button>
          ))}
          {!agents.length && <span className="muted mention__empty">No other agents yet.</span>}
        </div>
      )}
    </div>
  )
}

/** A thread and its sub-threads (a sub-thread: just itself): what its Tasks, Files and Reports gather. */
interface Family {
  ids: string[]
  /** a sub-thread's title, for items that come from one (null: the thread itself) */
  subOf: (threadId?: string) => string | null
}
function useFamily(t: OfficeThread): Family {
  const kids = useLive(useShallow((s) => (t.parentId ? [] : s.threads.filter((x) => x.parentId === t.id))))
  return {
    ids: [t.id, ...kids.map((k) => k.id)],
    subOf: (id) => (id && id !== t.id ? (kids.find((k) => k.id === id)?.title ?? null) : null),
  }
}

/** The sub-threads of a thread: each a part of the topic, in a session of its own. */
function SubThreadsPane({ t, startNew }: { t: OfficeThread; startNew?: boolean }) {
  const kids = useLive(useShallow((s) => s.threads.filter((x) => x.parentId === t.id))).slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const now = useNow(60_000).getTime()
  // a new one is made right here (the thread stays open), then the drawer moves on to it
  const [creating, setCreating] = useState(!!startNew)
  return (
    <div className="thread-pane">
      {creating ? (
        <NewSubThread parent={t} onCancel={() => setCreating(false)} />
      ) : (
        <button className="small thread-pane__add" onClick={() => setCreating(true)}>
          <LuPlus /> New sub-thread
        </button>
      )}
      <ul className="list thread-tasks">
        {kids.map((k) => (
          <li key={k.id}>
            <button className="thread-task" onClick={() => openUrl({ thread: k.id })}>
              <span className="thread-task__title truncate">
                {k.title}
                {k.archivedAt && <span className="muted"> · archived</span>}
              </span>
              <span className="thread-task__meta muted">
                <span className="truncate">{k.lastMessage ?? 'No reply yet'}</span>
                <span className="thread-sub__when">{ago(now - k.lastActivityAt)}</span>
                {!!k.unread && <span className="thread-row__count">{k.unread}</span>}
              </span>
            </button>
          </li>
        ))}
        {!kids.length && <li className="empty">When a topic grows into parts, give each part a sub-thread: its own session, its own tasks. The manager can open them too.</li>}
      </ul>
    </div>
  )
}

/** The form for a sub-thread, inside its parent's drawer: a part's name, and optionally the first message. Its folder and
 *  tags are the parent's (changed later in its head). */
function NewSubThread({ parent, onCancel }: { parent: OfficeThread; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const sub = await liveApi.createThread({ title: title.trim(), parentId: parent.id, ...(text.trim() ? { text: text.trim() } : {}) })
      // on to the new sub-thread, in the same drawer (Back comes back here)
      openUrl({ thread: sub.id, tparent: null })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start it')
      setBusy(false)
    }
  }
  return (
    <form
      className="thread-new-sub"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <span className="thread-new-sub__title">New sub-thread of “{parent.title}”</span>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The part, e.g. QR code page" maxLength={80} autoFocus />
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="First message (optional): what to do first. The manager starts with a summary of this thread." />
      {error && <p className="danger-text">{error}</p>}
      <span className="thread-new-sub__actions">
        <span className="muted">Same folder and tags as this thread.</span>
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
        <button className="small primary" disabled={busy || !title.trim()}>
          {busy ? (text.trim() ? 'Starting… (about 15 s)' : 'Starting…') : 'Start'}
        </button>
      </span>
    </form>
  )
}

function ThreadHead({ t, state }: { t: OfficeThread; state: ReturnType<typeof useThreadState> }) {
  const [title, setTitle] = useState(t.title)
  const [error, setError] = useState('')
  useEffect(() => setTitle(t.title), [t.title])
  const save = (patch: Parameters<typeof liveApi.updateThread>[1]) => void liveApi.updateThread(t.id, patch).catch((e) => setError(e.message))
  const parent = useLive((s) => (t.parentId ? s.threads.find((x) => x.id === t.parentId) : undefined))
  return (
    <div className="thread-head">
      {parent && (
        // where it is: its thread, then itself
        <nav className="thread-crumbs" aria-label="Where this is">
          <button className="thread-crumbs__link" onClick={() => openUrl({ thread: parent.id })} {...tip('The thread this is a part of')}>
            <LuMessagesSquare /> <span className="truncate">{parent.title}</span>
          </button>
          <LuChevronRight className="thread-crumbs__sep" aria-hidden />
          <span className="thread-crumbs__here truncate" aria-current="page">
            <LuGitBranch /> {t.title}
          </span>
        </nav>
      )}
      <input
        className="thread-head__title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title.trim() !== t.title ? save({ title: title.trim() }) : setTitle(t.title)}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        aria-label="Thread title"
        maxLength={80}
      />
      <div className="thread-head__meta">
        <FolderSelect size="sm" value={t.folder} onChange={(folder) => save({ folder: folder ?? null })} none="No folder" />
        <TagPicker size="sm" value={t.tags ?? []} onChange={(tags) => save({ tags })} />
        <span className={`thread-head__state thread-head__state--${state}`}>
          {state === 'working' ? 'The manager is on it…' : state === 'waiting' ? 'Waiting for you' : state === 'resting' ? 'Resting: your message opens it again (about 15 s)' : 'Ready'}
        </span>
      </div>
      {error && <span className="danger-text">{error}</span>}
    </div>
  )
}

function TasksPane({ t, family }: { t: OfficeThread; family: Family }) {
  const tasks = useDashboard(useShallow((s) => s.tasks.filter((x) => !!x.threadId && family.ids.includes(x.threadId)))).slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const agents = useOffice((s) => s.agents)
  return (
    <div className="thread-pane">
      <button className="small thread-pane__add" onClick={() => openUrl({ newtask: '1', nt_thread: t.id, ...(t.folder ? { nt_folder: t.folder } : {}), ...(t.tags?.length ? { nt_tag: t.tags.join(',') } : {}) })}>
        <LuPlus /> New task here
      </button>
      <ul className="list thread-tasks">
        {tasks.map((task) => {
          const agent = agents.find((a) => a.id === task.agentId)
          return (
            <li key={task.id}>
              <button className="thread-task" onClick={() => openUrl({ task: task.id })}>
                <span className="thread-task__title truncate">{task.title}</span>
                <span className="thread-task__meta">
                  <StatusPill task={task} />
                  <span className="muted truncate">{task.forOwner ? 'You' : (agent?.name ?? 'Nobody yet')}</span>
                  {family.subOf(task.threadId) && (
                    <span className="report-row__job truncate">
                      <LuCornerDownRight /> {family.subOf(task.threadId)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
        {!tasks.length && <li className="empty">Tasks the manager starts here (or you, with @) show up here.</li>}
      </ul>
    </div>
  )
}

/** The thread's folder: the same file manager as an agent's Folder tab (with its git bar when it's a repo). */
function FolderPane({ t }: { t: OfficeThread }) {
  const [error, setError] = useState('')
  if (!t.folder)
    return (
      <div className="thread-pane thread-folder--none">
        <p className="muted">This thread has no folder yet. Pick the one its work goes into: tasks started here work there, and it shows up here with its files and git.</p>
        <FolderSelect value={undefined} onChange={(folder) => folder && void liveApi.updateThread(t.id, { folder }).catch((e) => setError(e.message))} none="Pick a folder" />
        {error && <p className="danger-text">{error}</p>}
      </div>
    )
  return (
    <div className="agent-folder thread-folder">
      <code className="agent-folder__path truncate" data-tip={t.folder}>
        {t.folder.replace(/^\/(Users|home)\/[^/]+/, '~')}
      </code>
      <FileBrowser key={t.folder} root={t.folder} />
    </div>
  )
}

/** Files in the chat: what the owner attached, and what the manager wrote or pointed to in its replies. */
function ChatFiles({ t }: { t: OfficeThread }) {
  const [items, setItems] = useState<ChatItem[] | null>(null)
  useEffect(() => {
    let gone = false
    void api(`/api/agents/${t.managerId}/chat?limit=500&session=${t.sessionKey}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: ChatItem[]) => !gone && setItems(list))
      .catch(() => !gone && setItems([]))
    return () => void (gone = true)
  }, [t.managerId, t.sessionKey, t.lastActivityAt])
  const owner = useMemo(() => (items ?? []).flatMap((i) => (i.kind === 'user' ? splitAttachments(i.text).paths.filter((p) => !isFrameSheet(p)) : [])), [items])
  const made = useMemo(() => {
    const out: string[] = []
    for (const i of items ?? []) {
      if (i.kind === 'tool' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(i.tool)) {
        const input = (i.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
        const p = input.file_path ?? input.notebook_path
        if (typeof p === 'string') out.push(p)
      } else if (i.kind === 'assistant') out.push(...mentionedPaths(i.text))
    }
    return [...new Set(out)]
  }, [items])
  const ownerFiles = useAgentFiles(t.managerId, owner, true)
  const madeFiles = useAgentFiles(t.managerId, made)
  const sent = [...ownerFiles.values()].reverse()
  const replies = [...madeFiles.values()].reverse()
  if (items === null) return <p className="muted thread-files__note">Loading…</p>
  return (
    <>
      {sent.length > 0 && (
        <section className="thread-files">
          <span className="thread-files__head">You sent</span>
          <Attachments agentId={t.managerId} files={sent} />
        </section>
      )}
      {replies.length > 0 && (
        <section className="thread-files">
          <span className="thread-files__head">In the replies</span>
          <Attachments agentId={t.managerId} files={replies} />
        </section>
      )}
      {!sent.length && !replies.length && <p className="empty muted">Files attached in this chat (yours, and the ones the manager writes or points to) show up here.</p>}
    </>
  )
}

/** A report in its thread's chat: a task's by its task id (the office's "Report from …" line), a note by its time. */
const jumpToReport = (r: WorkReport) => openUrl({ thread: r.threadId!, tjump: r.kind === 'task' ? `task:${r.refId}` : `at:${r.finishedAt}` })

/** Files of the thread's reports (its tasks', and its sub-threads' on a thread). */
function ReportFiles({ family }: { family: Family }) {
  const reports = useDashboard(useShallow((s) => s.reports.filter((r) => !!r.threadId && family.ids.includes(r.threadId) && r.files?.length)))
  return (
    <>
      {reports.map((r) => (
        <section key={r.id} className="thread-files">
          <span className="thread-files__row">
            {/* to where it came up in the chat (its thread's, or a sub-thread's) */}
            <button className="thread-files__head link" onClick={() => jumpToReport(r)} {...tip('Go to it in the chat')}>
              {r.title}
              {family.subOf(r.threadId) && <span className="muted"> · {family.subOf(r.threadId)}</span>}
            </button>
            <button className="icon-btn small ghost" onClick={() => openUrl({ report: r.id })} {...tip('Open the report')}>
              <LuFileText />
            </button>
          </span>
          <Attachments agentId={r.agentId} files={r.files!} urlFor={reportUrl(r.id)} />
        </section>
      ))}
      {!reports.length && <p className="empty muted">Files the tasks here produce (attached to their reports) show up here.</p>}
    </>
  )
}

/** Files, by where they came from: the chat, or the reports. */
function FilesPane({ t, family }: { t: OfficeThread; family: Family }) {
  const [from, setFrom] = useState<'chat' | 'reports'>('chat')
  return (
    <div className="thread-pane">
      <div className="seg thread-files__tabs" role="tablist" aria-label="Files from">
        <button role="tab" aria-selected={from === 'chat'} className={from === 'chat' ? 'active' : ''} onClick={() => setFrom('chat')}>
          <LuMessagesSquare /> Chat
        </button>
        <button role="tab" aria-selected={from === 'reports'} className={from === 'reports' ? 'active' : ''} onClick={() => setFrom('reports')}>
          <LuFileText /> Reports
        </button>
      </div>
      {from === 'chat' ? <ChatFiles t={t} /> : <ReportFiles family={family} />}
    </div>
  )
}

function ReportsPane({ family }: { family: Family }) {
  const reports = useDashboard(useShallow((s) => s.reports.filter((r) => !!r.threadId && family.ids.includes(r.threadId))))
  const now = useNow(60_000).getTime()
  // a thread with sub-threads: each report says which one it's from
  return (
    <div className={`thread-pane${family.ids.length > 1 ? ' thread-pane--family' : ''}`}>
      <ul className="list reports-panel__list">
        {reports.map((r) => (
          <ReportRow key={r.id} r={r} now={now} onOpen={() => openUrl({ report: r.id })} />
        ))}
        {!reports.length && <li className="empty">Reports of the tasks here, and the manager's notes about this topic.</li>}
      </ul>
    </div>
  )
}

export function ThreadModal({ id, newSub, onClose: close, onMinimize: minimize }: { id: string; newSub?: boolean; onClose: () => void; onMinimize: (title: string) => void }) {
  // play the slide-out before it goes (as the agents' chat drawer)
  const [closing, setClosing] = useState(false)
  const leave = useCallback(
    (then: () => void) => {
      setClosing(true)
      setTimeout(then, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220)
    },
    [],
  )
  const onClose = useCallback(() => leave(close), [leave, close])
  const t = useLive((s) => s.threads.find((x) => x.id === id))
  const onMinimize = () => t && leave(() => minimize(t.title))
  const ready = useLive((s) => s.ready)
  const manager = useOffice((s) => s.agents.find((a) => a.id === t?.managerId))
  const agents = useOffice((s) => s.agents)
  const mobile = useMediaQuery(MOBILE)
  const max = useMaximize('ao-max-thread')
  const { dragProps } = useSheetDrag(onClose, max.ref)
  // ?thread=new&tparent=<id>: the thread opens on its Sub-threads with a new one's form
  const [pane, setPane] = useState<Pane>(newSub ? 'subs' : 'chat')
  // ?tjump=…: its chat, at a report's message (from Files)
  const tjump = useParam('tjump')
  const [jump, setJump] = useState<ChatJump | undefined>()
  useEffect(() => {
    if (!tjump) return
    setPane('chat')
    setJump({ key: tjump, n: Date.now() })
    setUrl({ tjump: null }, 'replace')
  }, [tjump])
  const family = useFamily(t ?? ({ id } as OfficeThread))
  const counts = useDashboard(
    useShallow((s) => ({
      tasks: s.tasks.filter((x) => !!x.threadId && family.ids.includes(x.threadId) && x.status !== 'done').length,
      reports: s.reports.filter((r) => !!r.threadId && family.ids.includes(r.threadId)).length,
    })),
  )
  const subCount = family.ids.length - 1
  const state = useThreadState(t ?? ({ managerId: '', sessionKey: '' } as OfficeThread))
  // its chip goes once it's open again
  useEffect(() => useMinimized.getState().remove(`thread:${id}`), [id])
  // seen: its replies are read (after a moment on screen, as in the chats)
  useEffect(() => {
    if (!t?.unread) return
    const tm = setTimeout(() => void liveApi.readThread(id).catch(() => {}), 800)
    return () => clearTimeout(tm)
  }, [id, t?.unread])
  // Esc closes (a window opened over it, a task or a report, takes its own Esc first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-backdrop:not(.modal-backdrop--closing)')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!t) return ready ? <ThreadGone onClose={close} /> : null
  if (!manager) return null
  const side = manager.sessions?.find((s) => s.key === t.sessionKey && s.open)
  // the chat shows the thread session's own state; resting (closed) reads as ready: a message opens it again
  const view: OfficeAgent = side
    ? { ...manager, status: side.status, waitingFor: side.waitingFor, tool: side.tool, permissionMode: side.permissionMode, costUsd: side.costUsd, contextPct: side.contextPct, contextTokens: undefined, contextSize: undefined, compactingSince: side.compactingSince, lastMessage: side.lastMessage, unread: side.unread, error: undefined }
    : { ...manager, status: 'idle', waitingFor: undefined, tool: undefined, contextPct: t.contextPct ?? null, contextTokens: undefined, contextSize: undefined, compactingSince: undefined, unread: 0, error: undefined }
  const archive = () => void liveApi.archiveThread(t.id, !t.archivedAt).then(() => !t.archivedAt && onClose())
  const remove = async () => {
    if (!(await confirm({ title: `Delete the thread “${t.title}”?`, message: 'Its conversation with the manager is forgotten. Its tasks and reports stay (in Tasks and Reports).', confirmLabel: 'Delete thread' }))) return
    await liveApi.deleteThread(t.id)
    onClose()
  }
  const tabs: { id: Pane; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'chat', label: 'Chat', icon: <LuMessagesSquare /> },
    // sub-threads: a thread's own parts (one level: a sub-thread has none)
    ...(t.parentId ? [] : [{ id: 'subs' as const, label: 'Sub-threads', icon: <LuGitBranch />, count: subCount }]),
    { id: 'tasks', label: 'Tasks', icon: <LuListTodo />, count: counts.tasks },
    { id: 'folder', label: 'Folder', icon: <LuFolder /> },
    { id: 'files', label: 'Files', icon: <LuPaperclip /> },
    { id: 'reports', label: 'Reports', icon: <LuFileText />, count: counts.reports },
  ]
  return createPortal(
    <div className={`drawer-backdrop${closing ? ' drawer-backdrop--closing' : ''}`} onMouseDown={onBackdropTap(onClose)}>
      <aside ref={max.ref} className={`drawer drawer--wide thread-drawer${max.full ? ' drawer--full' : ''}`} role="dialog" aria-modal="true" aria-label={t.title}>
        <div className="drawer__grab" aria-hidden="true" {...dragProps} />
        <header className="drawer__head thread-drawer__head" {...dragProps}>
          <span className={`avatar avatar--lg thread-drawer__icon thread-row__icon--${state}`}>
            <LuMessagesSquare />
          </span>
          <ThreadHead t={t} state={state} />
          <span className="thread-drawer__actions">
            <button className="icon-btn small ghost" onClick={archive} {...tip(t.archivedAt ? 'Back to the active threads' : 'Archive: its session closes; it stays under Archived')}>
              {t.archivedAt ? <LuArchiveRestore /> : <LuArchive />}
            </button>
            <button className="icon-btn small ghost" onClick={() => void remove()} {...tip('Delete the thread')}>
              <LuTrash2 />
            </button>
            <button className="icon-btn small ghost" data-tip="Minimize" aria-label="Minimize" onClick={onMinimize}>
              <LuMinus />
            </button>
            {!mobile && <MaximizeButton full={max.full} onToggle={max.toggle} />}
            <button className="icon-btn small ghost" data-tip="Close" aria-label="Close" onClick={onClose}>
              <LuX />
            </button>
          </span>
        </header>
        <nav className="drawer__tabs seg">
          {tabs.map((x) => (
            <button key={x.id} className={pane === x.id ? 'active' : ''} onClick={() => setPane(x.id)}>
              {x.icon} {x.label}
              {!!x.count && <span className="seg__count">{x.count}</span>}
            </button>
          ))}
        </nav>
        <div key={pane} className={`drawer__body ui-switch${pane === 'chat' ? ' drawer__body--flush' : ''}`}>
          {pane === 'chat' && (
            <ChatView
              key={`${t.id}:${t.sessionKey}`}
              agent={view}
              session={t.sessionKey}
              header={null}
              jump={jump}
              thread={{
                placeholder: mobile ? `Message ${manager.name}… (@ hands it to an agent)` : `Message ${manager.name} in this thread…  (@Name hands it to an agent · Enter to send)`,
                send: (text, uploads) => liveApi.threadMessage(t.id, { text, uploads, mentions: mentionsIn(text, agents) }),
                mention: (insert) => <MentionButton onPick={insert} />,
                compact: () => liveApi.compactThread(t.id).then(() => undefined),
                queued: t.queued,
                names: agents.filter((a) => a.kind !== 'manager').map((a) => ({ name: a.name, role: a.role || a.profile.role, color: a.look.shirt })),
              }}
            />
          )}
          {pane === 'subs' && <SubThreadsPane t={t} startNew={newSub} />}
          {pane === 'tasks' && <TasksPane t={t} family={family} />}
          {pane === 'folder' && <FolderPane t={t} />}
          {pane === 'files' && <FilesPane t={t} family={family} />}
          {pane === 'reports' && <ReportsPane family={family} />}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function ThreadGone({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Thread" width={420}>
      <div className="modal__body">
        <p>This thread doesn't exist any more.</p>
        <footer className="modal__foot">
          <button onClick={onClose}>Close</button>
        </footer>
      </div>
    </Modal>
  )
}
