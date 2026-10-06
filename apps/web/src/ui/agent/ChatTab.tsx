import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, useMemo } from 'react'
import { useClock } from '../../state/clock'
import { chatTime, dateTime, localizeResets } from '../when'
import { MicButton, ListeningBar, SpeakingChip } from '../Voice'
import { useDictation } from '../../state/dictation'
import { primeSpeech, talkedByVoice } from '../../state/speech'
import { LuCheck, LuChevronDown, LuChevronRight, LuChevronUp, LuFoldVertical, LuSquare, LuClipboardList, LuCircleHelp, LuLoader, LuPaperclip, LuSearch, LuSend, LuShieldAlert, LuSlidersHorizontal, LuTag, LuPlus, LuX, LuFileText } from 'react-icons/lu'
import { openUrl } from '../../state/url'
import { ComposerBox, type ComposerHandle } from './ComposerBox'
import { confirm } from '../Confirm'
import { MOBILE, useMediaQuery } from '../../state/useMediaQuery'
import type { ChatItem, LiveMode, WorkReport } from '@after-office/shared'
import { useDashboard } from '../../state/dashboard'
import { mentionedPaths, modelChoiceOf, MODELS } from '@after-office/shared'
import { api } from '../../state/auth'
import { liveApi, useLive } from '../../state/live'
import { useOffice, type OfficeAgent } from '../../state/store'
import { FollowUpDetail, fromLive, Markdown, toServer, toolLabel, ago, type Item } from '../FollowUps'
import { Select } from '../Select'
import { compactTokens } from '../UsagePopover'
import { MODE_LABEL } from '../AgentsPanel'
import { Attachments, useAgentFiles } from '../Attachments'
import { FileLinksProvider } from '../fileLinks'
import { OutgoingFiles, PendingTray, splitAttachments, usePendingFiles, type Pending } from './chatAttachments'
import { tip } from '../Tooltip'
import { OfflineBanner } from './OfflineBanner'
import { ChatContextBar, ContextChips, splitContext, useChatContext } from './chatContext'
import { SessionTabs } from './SessionTabs'
import { setUrl, useUrl } from '../../state/url'

// Chat with one agent. Messages come from its Claude Code transcript; what you send is typed into its tmux session.

export const MODEL_OPTIONS = MODELS.map((m) => ({ value: m.value as string, label: m.label }))
const MODE_OPTIONS: { value: LiveMode; label: string }[] = (['default', 'acceptEdits', 'plan', 'auto'] as LiveMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))

/** "claude-sonnet-5" → "sonnet" so the dropdown shows the running model. */
export const modelAlias = (id?: string) => modelChoiceOf(id)

/**
 * The agent's chats: its main session and its side sessions (tabs above the chat, ?session=s2 in the address bar).
 * A side session's chat is the same view, on that session's process and state.
 */
export function ChatTab({ agent }: { agent: OfficeAgent }) {
  const params = useUrl((s) => s.params)
  const wanted = params.session ?? ''
  const side = wanted ? agent.sessions?.find((s) => s.key === wanted && s.open) : undefined
  const session = side ? wanted : ''
  // a closed (or unknown) session in the address bar: back to the main chat
  useEffect(() => {
    if (wanted && agent.sessions && !side) setUrl({ session: null })
  }, [wanted, side, agent.sessions])
  const pick = (key: string) => setUrl({ session: key || null })
  // the chat shows the session's own state (status, mode, cost, context…), the agent's name and folder
  const view: OfficeAgent = side
    ? { ...agent, status: side.status, waitingFor: side.waitingFor, tool: side.tool, permissionMode: side.permissionMode, costUsd: side.costUsd, contextPct: side.contextPct, contextTokens: undefined, contextSize: undefined, compactingSince: side.compactingSince, lastMessage: side.lastMessage, unread: side.unread, error: undefined }
    : { ...agent, status: agent.mainStatus ?? agent.status }
  return <ChatView key={`${agent.id}:${session}`} agent={view} session={session} header={<SessionTabs agent={agent} current={session} onPick={pick} />} />
}

function ChatView({ agent, session, header }: { agent: OfficeAgent; session: string; header: ReactNode }) {
  // message times, in the office's timezone
  const timezone = useClock((s) => s.timezone)
  // the reports a message is, or names: links under it
  const links = useReportLinks()
  const sk = session || undefined
  const [items, setItems] = useState<ChatItem[]>([])
  const [loaded, setLoaded] = useState(false)
  // the message box holds its own text (ComposerBox: typing renders only it, and keeps a draft); here only whether
  // there is any
  const composer = useRef<ComposerHandle>(null)
  const [hasText, setHasText] = useState(false)
  // talking instead of typing: what was said lands in the message box to check and send, or goes out right away
  // (held to talk, or hands-free)
  // a message (partly) said rather than typed: its answer is read out (state/speech.ts)
  const spoken = useRef(false)
  const dict = useDictation(({ text: said, send: now }) => {
    const cur = composer.current?.get() ?? ''
    const body = cur.trim() ? `${cur.trimEnd()} ${said}` : said
    spoken.current = true
    if (now) return void sendRef.current?.(body)
    composer.current?.set(body)
    requestAnimationFrame(() => composer.current?.focus())
  })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Stop pressed partway through a task: it's back in To do (Resume, in the task, continues it)
  const [stoppedTask, setStoppedTask] = useState<{ id: string; title: string } | null>(null)
  const stop = () =>
    run('stop', async () => {
      const r = (await liveApi.interrupt(agent.id, sk)) as { task?: { id: string; title: string } }
      if (r?.task) setStoppedTask(r.task)
    })
  const [busy, setBusy] = useState('')
  // /compact running (the server says so: it shows on every device and survives a reload): nothing can be sent meanwhile
  const compacting = !!agent.compactingSince
  const compact = async () => {
    const used = agent.contextPct != null ? ` (${Math.round(agent.contextPct)}% used)` : ''
    if (!(await confirm({ title: `Compact ${agent.name}'s conversation?`, message: `It's summarized to free the context window${used}. ${agent.name} keeps the gist of what was said, but the details of earlier messages are gone.`, confirmLabel: 'Compact', danger: false }))) return
    await run('compact', async () => {
      await liveApi.compact(agent.id, sk)
    })
  }
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const followUps = useLive((s) => s.followUps).filter((f) => f.agentId === agent.id && (f.sessionKey ?? '') === session)
  const [detail, setDetail] = useState<Item | null>(null)
  const offline = agent.status === 'offline'
  // time of our last prompt: show the typing bubble right away, before the agent's first hook arrives
  const [sentAt, setSentAt] = useState<number | null>(null)
  // messages already on screen when the tab opened don't animate in
  const mobile = useMediaQuery(MOBILE)
  const [infoOpen, setInfoOpen] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const lastBody = useRef('')
  const active = agent.status === 'working' || agent.status === 'waiting'
  // search in the chat: a find bar over the log; while it's open the chat loads a longer history
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const limit = findOpen ? 500 : 150

  const load = useCallback(async () => {
    const res = await api(`/api/agents/${agent.id}/chat?limit=${limit}${session ? `&session=${session}` : ''}`)
    if (res.ok) {
      const text = await res.text()
      // polling: nothing new means nothing to re-render (no flicker, scroll and selection stay put)
      if (text !== lastBody.current) {
        lastBody.current = text
        const next: ChatItem[] = JSON.parse(text)
        if (!seen.current) seen.current = new Set(next.map((i) => i.id))
        setItems(next)
      }
    }
    setLoaded(true)
  }, [agent.id, limit, session])

  // refresh on every status change. Claude Code writes the reply to its transcript a moment *after* the Stop hook
  // (seen live: the read right on "idle" still misses it), so look again shortly after, too.
  useEffect(() => {
    load()
    const later = [700, 1800, 3500].map((ms) => setTimeout(load, ms))
    return () => later.forEach(clearTimeout)
  }, [load, agent.status, agent.tool, agent.lastMessage])
  // keep polling: quickly while it works or while we wait for the answer to our message, slowly otherwise
  const waitingForReply = sentAt !== null
  useEffect(() => {
    const id = setInterval(load, active || waitingForReply ? 1000 : 6000)
    return () => clearInterval(id)
  }, [load, active, waitingForReply])

  // the chat is on screen: its replies are seen (clears the badge on the agent's chat button)
  useEffect(() => {
    if (agent.unread && document.visibilityState === 'visible') void liveApi.markChatRead(agent.id, sk).catch(() => {})
  }, [agent.id, agent.unread, sk])
  useEffect(() => {
    const unread = () => {
      const a = useOffice.getState().agents.find((x) => x.id === agent.id)
      return sk ? a?.sessions?.find((s) => s.key === sk)?.unread : a?.unread
    }
    const onVisible = () => document.visibilityState === 'visible' && unread() && void liveApi.markChatRead(agent.id, sk).catch(() => {})
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [agent.id, sk])

  // the reply arrived (or the agent is done / needs us): stop the "typing" bubble we started on send
  useEffect(() => {
    if (!sentAt) return
    const last = items[items.length - 1]
    if ((last?.kind === 'assistant' && last.at >= sentAt - 1000) || agent.status === 'waiting' || offline) setSentAt(null)
    const t = setTimeout(() => setSentAt(null), 30_000)
    return () => clearTimeout(t)
  }, [items, sentAt, agent.status, offline])
  useEffect(() => {
    if (agent.status === 'idle' && sentAt && Date.now() - sentAt > 3000) setSentAt(null)
  }, [agent.status, sentAt])
  const typing = !offline && agent.status !== 'waiting' && (agent.status === 'working' || sentAt !== null)
  const isNew = (id: string) => (seen.current && !seen.current.has(id) ? ' msg--new' : '')

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, followUps.length, typing])
  // content that grows after it's shown (attachment cards, pictures loading, markdown) keeps the chat at the bottom,
  // unless the owner scrolled up
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const toBottom = () => {
      if (stick.current) el.scrollTop = el.scrollHeight
    }
    const sizes = new ResizeObserver(toBottom)
    const watch = () => {
      sizes.disconnect()
      sizes.observe(el)
      for (const child of el.children) sizes.observe(child)
    }
    watch()
    const added = new MutationObserver(() => {
      watch()
      toBottom()
    })
    added.observe(el, { childList: true })
    el.addEventListener('load', toBottom, true) // <img> inside a message
    return () => {
      sizes.disconnect()
      added.disconnect()
      el.removeEventListener('load', toBottom, true)
    }
  }, [])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy('')
    }
  }

  const pending = usePendingFiles(agent.id)
  // the folder and tags sent with each message (optional, kept per agent): the row shows while open or set
  // each session keeps its own folder and tags
  const context = useChatContext(agent.id, session)
  const [contextOpen, setContextOpen] = useState(false)
  // phones: the row only while opened (the + button shows a dot when something is picked); elsewhere also while set
  const ctxShown = contextOpen || (context.active && !mobile)
  const fileInput = useRef<HTMLInputElement>(null)
  // opening the chat puts the cursor in the message box (not on phones: that would pop the keyboard up over it)
  useEffect(() => {
    if (!mobile && !offline) composer.current?.focus({ preventScroll: true })
  }, [agent.id, mobile, offline])
  const [dragging, setDragging] = useState(false)
  const attach = (files: File[]) => {
    if (!files.length || offline) return
    const problem = pending.add(files)
    setError(problem ?? '')
  }
  const canSend = !offline && !compacting && !sending && !pending.uploading && (hasText || pending.ids.length > 0)

  // the message just sent, shown right away (below the chat, above the typing bubble) until the transcript has it
  const sendRef = useRef<((said?: string) => Promise<void>) | null>(null)
  const [outgoing, setOutgoing] = useState<{ text: string; files: Pending[]; at: number } | null>(null)
  // …and swapped for the real one in the same render: no gap, no second fade-in
  const delivered = outgoing ? items.find((i) => i.kind === 'user' && i.at >= outgoing.at - 1000) : undefined
  if (delivered) seen.current?.add(delivered.id)
  useEffect(() => {
    if (!delivered) return
    // the real message shows the files from the agent's folder now: free the local previews
    setOutgoing((o) => (o?.files.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb)), null))
  }, [delivered])

  // a follow-up sent within a minute of the last message (while that one is still being answered): one answer for both
  const lastSent = useRef(0)
  const [joinedNote, setJoinedNote] = useState(false)
  const send = async (said?: string) => {
    const body = (said ?? composer.current?.get() ?? '').trim()
    if (offline || compacting || sending || pending.uploading || (!body && !pending.ids.length)) return
    setSending(true)
    setError('')
    const at = Date.now()
    setOutgoing({ text: body, files: pending.items.filter((p) => p.state === 'done'), at })
    // the box empties right away (typing a long message into the agent takes a moment); back if it couldn't be sent
    composer.current?.set('')
    stick.current = true
    try {
      const r = await liveApi.prompt(agent.id, body, pending.ids, context.value, sk, at - lastSent.current < 60_000)
      lastSent.current = at
      if (r?.joined) {
        setJoinedNote(true)
        setTimeout(() => setJoinedNote(false), 6000)
      }
      // the main session's answer is read out when this was said (side sessions aren't watched)
      if (spoken.current && !sk) talkedByVoice(agent.id)
      spoken.current = false
      setSentAt(at)
      pending.take()
      stick.current = true
      setTimeout(load, 600)
    } catch (e) {
      setOutgoing(null)
      if (!(composer.current?.get() ?? '').trim()) composer.current?.set(body)
      setError(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setSending(false)
    }
  }
  sendRef.current = send


  // attachments: under each reply, the files written since the previous reply (Write/Edit) and the files it names
  const attachmentPaths = useMemo(() => {
    const byReply = new Map<string, string[]>()
    let written: string[] = []
    for (const i of items) {
      if (i.kind === 'user') written = []
      else if (i.kind === 'tool' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(i.tool)) {
        const input = (i.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
        const p = input.file_path ?? input.notebook_path
        if (typeof p === 'string') written.push(p)
      } else if (i.kind === 'assistant') {
        byReply.set(i.id, [...new Set([...written, ...mentionedPaths(i.text)])])
        written = []
      }
    }
    return byReply
  }, [items])
  const allPaths = useMemo(() => [...attachmentPaths.values()].flat(), [attachmentPaths])
  const agentFiles = useAgentFiles(agent.id, allPaths)
  // files the owner attached (shown as gone once checked, e.g. deleted from the agent's folder since)
  const ownerPaths = useMemo(() => items.flatMap((i) => (i.kind === 'user' ? splitAttachments(i.text).paths : [])), [items])
  const ownerFiles = useAgentFiles(agent.id, ownerPaths, true)

  // pair tool calls with their results
  const results = new Map(items.filter((i): i is Extract<ChatItem, { kind: 'tool-result' }> => i.kind === 'tool-result').map((r) => [r.toolUseId, r]))

  // messages matching the search (oldest first); the newest match is where a new search starts
  const q = query.trim().toLowerCase()
  const hits = useMemo(
    () => (q ? items.filter((i) => (i.kind === 'user' || i.kind === 'assistant') && i.text.toLowerCase().includes(q)).map((i) => i.id) : []),
    [items, q],
  )
  // a new search starts at the match nearest to where the chat is scrolled (not always the newest one)
  useEffect(() => {
    const root = scroller.current
    if (!hits.length || !root) return setHit(0)
    const view = root.getBoundingClientRect()
    const middle = view.top + view.height / 2
    let best = hits.length - 1
    let bestDistance = Infinity
    hits.forEach((id, n) => {
      const el = root.querySelector(`[data-mid="${CSS.escape(id)}"]`)
      if (!el) return
      const r = el.getBoundingClientRect()
      // 0 when the message is on screen across the middle; else how far its nearest edge is
      const distance = r.top <= middle && r.bottom >= middle ? 0 : Math.min(Math.abs(r.top - middle), Math.abs(r.bottom - middle))
      if (distance < bestDistance) {
        best = n
        bestDistance = distance
      }
    })
    setHit(best)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = hits.length ? hits[Math.min(hit, hits.length - 1)] : null
  // highlight every occurrence (CSS Custom Highlight API; older browsers just get the current message outlined)
  useEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!reg || !HighlightCtor) return
    reg.delete('ao-find')
    reg.delete('ao-find-current')
    const root = scroller.current
    if (!root || !q) return
    const all: Range[] = []
    const cur: Range[] = []
    root.querySelectorAll<HTMLElement>('[data-mid]').forEach((msg) => {
      const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent?.toLowerCase() ?? ''
        for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
          const r = document.createRange()
          r.setStart(n, at)
          r.setEnd(n, at + q.length)
          ;(msg.dataset.mid === current ? cur : all).push(r)
        }
      }
    })
    reg.set('ao-find', new HighlightCtor(...all))
    reg.set('ao-find-current', new HighlightCtor(...cur))
    return () => {
      reg.delete('ao-find')
      reg.delete('ao-find-current')
    }
  }, [q, current, items])
  // bring the current match into view
  useEffect(() => {
    if (!current) return
    stick.current = false
    scroller.current?.querySelector(`[data-mid="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current])
  const step = (d: number) => hits.length && setHit((h) => (h + d + hits.length) % hits.length)
  const closeFind = () => {
    setFindOpen(false)
    setQuery('')
  }
  // Ctrl/Cmd+F inside the chat opens its own search (elsewhere the browser's find still works)
  const chatRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return
      if (!chatRef.current?.contains(document.activeElement) && !chatRef.current?.matches(':hover')) return
      e.preventDefault()
      setFindOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const findButton = (
    // phones: the same round floating button as the info one next to it
    <button className={`icon-btn${mobile ? ' chat__info' : ' small ghost'}${findOpen ? ' is-on' : ''}`} onClick={() => (findOpen ? closeFind() : setFindOpen(true))} aria-label="Search the chat" aria-pressed={findOpen} data-tip="Search the chat (Ctrl/⌘ F)">
      <LuSearch />
    </button>
  )

  const findBar = (
  <div className={`chat__find${mobile ? ' chat__find--float' : ''}`} role="search">
            <LuSearch className="muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? 1 : -1)
                } else if (e.key === 'Escape') {
                  e.stopPropagation()
                  closeFind()
                }
              }}
              placeholder="Search this chat"
              aria-label="Search this chat"
            />
            <span className="chat__find-count muted">{q ? (hits.length ? `${Math.min(hit, hits.length - 1) + 1} / ${hits.length}` : 'No matches') : ''}</span>
            <button className="icon-btn small ghost" onClick={() => step(-1)} disabled={hits.length < 2} aria-label="Older match" data-tip="Older (Enter)">
              <LuChevronUp />
            </button>
            <button className="icon-btn small ghost" onClick={() => step(1)} disabled={hits.length < 2} aria-label="Newer match" data-tip="Newer (Shift+Enter)">
              <LuChevronDown />
            </button>
            {!mobile && (
              <button className="icon-btn small ghost" onClick={closeFind} aria-label="Close search" data-tip="Close (Esc)">
                <LuX />
              </button>
            )}
          </div>
  )

  // phones: the model / mode / status bar folds away behind an info button, so the chat gets the whole height
  const bar = (
      <div className={`chat__bar${mobile ? ' chat__bar--sheet' : ''}`}>
        {/* the model is the agent's (changing it restarts the main session); a side session starts with it */}
        {!session && (
          <Select
            ariaLabel="Model"
            size="sm"
            value={modelAlias(agent.model)}
            options={MODEL_OPTIONS}
            disabled={offline || !!busy || active}
            onChange={(m) => run('model', () => liveApi.setModel(agent.id, m))}
          />
        )}
        <Select
          ariaLabel="Permission mode"
          size="sm"
          value={agent.permissionMode ?? 'default'}
          options={MODE_OPTIONS}
          disabled={offline || !!busy}
          onChange={(m) =>
            run('mode', async () => {
              const r = await liveApi.setMode(agent.id, m, sk)
              if (r.deferred) setNotice(`Switches to ${MODE_LABEL[m]} when you answer the current prompt.`)
            })
          }
        />
        <span className="chat__stat muted">
          {busy === 'model' ? 'Restarting with the new model…' : busy === 'mode' ? 'Switching mode…' : statusText(agent)}
        </span>
        {agent.contextPct != null && (
          <span className="chat__ctx" data-tip={agent.contextTokens != null && agent.contextSize ? `Context window: ${compactTokens(agent.contextTokens)} / ${compactTokens(agent.contextSize)} tokens` : 'Context window used'}>
            <span className="meter">
              <span style={{ width: `${Math.min(100, agent.contextPct)}%` }} />
            </span>
            {Math.round(agent.contextPct)}%
          </span>
        )}
        {agent.contextPct != null && !offline && (
          <button
            className="small ghost chat__compact"
            onClick={() => void compact()}
            disabled={active || !!busy || !!compacting}
            aria-label="Compact the conversation"
            data-tip={active ? 'Compact when it is idle (or stop it first)' : compacting ? 'Compacting…' : 'Compact: summarize the conversation to free the context window'}
          >
            {compacting || busy === 'compact' ? <LuLoader className="spin" /> : <LuFoldVertical />}
            <span className="chat__compact-label">Compact</span>
          </button>
        )}
        {!mobile && findButton}
      </div>
  )

  return (
    <div
      ref={chatRef}
      className={`chat${mobile ? ' chat--mobile' : ''}${dragging ? ' chat--drop' : ''}`}
      // drop files anywhere on the chat to attach them
      onDragOver={(e) => {
        if (offline || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        attach([...e.dataTransfer.files])
      }}
    >
      {header}
      {mobile ? (
        <>
          <div className={`chat__float${findOpen ? ' chat__float--find' : ''}`}>
            {findOpen ? (
              // searching: the search button has become the box, with a round ✕ beside it
              <>
                {findBar}
                <button className="icon-btn chat__info" onClick={closeFind} aria-label="Close search">
                  <LuX />
                </button>
              </>
            ) : (
              <>
                {findButton}
                <button
                  className={`icon-btn chat__info${infoOpen ? ' is-on' : ''}`}
                  aria-label="Model, mode and status"
                  aria-expanded={infoOpen}
                  onClick={() => setInfoOpen((v) => !v)}
                >
                  <LuSlidersHorizontal />
                </button>
              </>
            )}
          </div>
          {infoOpen && bar}
        </>
      ) : (
        bar
      )}

      {findOpen && !mobile && findBar}
      <div
        className="chat__log"
        onPointerDown={() => infoOpen && setInfoOpen(false)}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!loaded && <div className="empty"><LuLoader className="spin" /></div>}
        {loaded && !items.length && <div className="empty">No messages yet. Say hi, or give {agent.name} a task.</div>}
        {items.map((i) => {
          if (i.kind === 'user') {
            // files the owner attached: previews under the bubble, like the agent's own files
            const { text: withCtx, paths } = splitAttachments(i.text)
            const { text: said, folder, tags } = splitContext(withCtx)
            const files = paths.map((p) => ownerFiles.get(p)).filter((f) => !!f)
            return (
              <div key={i.id} data-mid={i.id} className={`msg-user${isNew(i.id)}`}>
                {files.length > 0 && (
                  <div className="msg-user__files">
                    <Attachments agentId={agent.id} files={files} />
                  </div>
                )}
                {said && <div className={`msg msg--user${i.id === current ? ' msg--hit' : ''}`}>{said}</div>}
                <ContextChips folder={folder} tags={tags} />
                {/* the manager's chat: a forwarded report names its task (whose report has the same title) */}
                {agent.kind === 'manager' && <ReportLinks reports={links.forText(null, said)} />}
                <time className="msg__time" dateTime={new Date(i.at).toISOString()} data-tip={dateTime(i.at, timezone)}>
                  {chatTime(i.at, timezone)}
                </time>
              </div>
            )
          }
          if (i.kind === 'assistant') {
            const files = (attachmentPaths.get(i.id) ?? []).map((p) => agentFiles.get(p)).filter((f) => !!f)
            return (
              <Fragment key={i.id}>
                <div data-mid={i.id} className={`msg msg--agent${isNew(i.id)}${i.id === current ? ' msg--hit' : ''}`}>
                  <FileLinksProvider agentId={agent.id} files={files}>
                    {/* a plan-limit notice's reset time in the office's timezone, not the server's */}
                    <Markdown text={localizeResets(i.text, timezone, i.at)} />
                  </FileLinksProvider>
                  <Attachments agentId={agent.id} files={files} />
                </div>
                <ReportLinks reports={links.forText(agent.id, i.text)} agent />
                {/* when it said this, small under the bubble */}
                <time className="msg__time msg__time--agent" dateTime={new Date(i.at).toISOString()} data-tip={dateTime(i.at, timezone)}>
                  {chatTime(i.at, timezone)}
                </time>
              </Fragment>
            )
          }
          if (i.kind === 'tool') return <ToolRow key={i.id} item={i} result={results.get(i.id)} report={links.forTool(agent.id, i)} />
          return null
        })}
        {outgoing && !delivered && (
          <div className="msg-user msg--new">
            <OutgoingFiles items={outgoing.files} />
            {outgoing.text && <div className="msg msg--user">{outgoing.text}</div>}
          </div>
        )}
        {typing && (
          <div className="typing" role="status" aria-label={`${agent.name} is typing`}>
            <span className="typing__bubble">
              <i />
              <i />
              <i />
            </span>
            <span className="typing__label">{agent.tool ? `Using ${agent.tool}…` : `${agent.name} is thinking…`}</span>
          </div>
        )}
        {followUps.map((f) => (
          <InlineRequest key={f.id} item={fromLive(f)} onOpen={setDetail} onError={setError} />
        ))}
      </div>

      {offline && (session ? <div className="chat__notice">Starting the session…</div> : <OfflineBanner agent={agent} />)}
      {error && <div className="chat__error">{error}</div>}
      {!error && notice && agent.status === 'waiting' && <div className="chat__notice">{notice}</div>}
      {compacting && (
        <div className="chat__notice">
          <LuLoader className="spin" /> Compacting {agent.name}'s conversation… the context window drops when it's done.
        </div>
      )}
      {joinedNote && <div className="chat__notice">Added to the answer in progress: {agent.name} answers both messages together.</div>}
      {stoppedTask && (
        <div className="chat__notice chat__notice--stopped">
          <span>
            “{stoppedTask.title}” is back in To do (stopped).
          </span>
          <button className="small" onClick={() => (openUrl({ task: stoppedTask.id }), setStoppedTask(null))}>
            Open to Resume
          </button>
          <button className="icon-btn small ghost" aria-label="Dismiss" onClick={() => setStoppedTask(null)}>
            <LuX />
          </button>
        </div>
      )}
      <PendingTray items={pending.items} onRemove={pending.remove} />
      {/* always there, folded away when closed: it slides open and shut (CSS grid rows) */}
      <div className={`chat-ctx-wrap${ctxShown ? ' is-open' : ''}`} inert={!ctxShown}>
        <div className="chat-ctx-wrap__inner">
          <ChatContextBar value={context.value} onChange={context.set} manager={agent.kind === 'manager'} />
        </div>
      </div>
      {(dict.listening || dict.error) && <ListeningBar dict={dict} />}
      {/* an answer being read out: stop it from here too (phones have no navbar chip) */}
      <div className="chat__speaking">
        <SpeakingChip />
      </div>
      <div className="chat__composer">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        {mobile ? (
          // phones: one + button, its menu has both (the message box keeps the width)
          <ComposerMenu
            disabled={offline}
            contextActive={context.active}
            contextOpen={contextOpen}
            onAttach={() => fileInput.current?.click()}
            onContext={() => setContextOpen((v) => !v)}
          />
        ) : (
          <>
            <button className="icon-btn ghost chat__attach" onClick={() => fileInput.current?.click()} disabled={offline || sending} {...tip('Attach files or pictures (or paste / drop them here)')}>
              <LuPaperclip />
            </button>
            <button
              className={`icon-btn ghost chat__attach chat__ctx-toggle${context.active ? ' is-on' : ''}`}
              onClick={() => setContextOpen((v) => !v)}
              disabled={offline}
              aria-expanded={contextOpen || context.active}
              {...tip(context.active ? 'Folder and tags for this chat' : 'Pick a folder or tags (optional)')}
            >
              <LuTag />
            </button>
          </>
        )}
        <ComposerBox
          ref={composer}
          draftKey={`${agent.id}:${session}`}
          placeholder={offline ? (session ? 'The session is starting…' : 'The agent is offline') : compacting ? `${agent.name} is compacting the conversation… you can write, and send when it's done` : mobile ? `Message ${agent.name}…` : `Message ${agent.name}…  (Enter to send, Shift+Enter for a new line)`}
          disabled={offline}
          onSubmit={() => void send()}
          onFiles={attach}
          onHasText={setHasText}
        />
        {dict.supported && <MicButton dict={dict} disabled={offline} />}
        {/* the agent is at work and nothing is typed: this button stops it (Esc in its session); typing something turns it back into Send (a follow-up joins the answer) */}
        {active && !offline && !compacting && !hasText && pending.ids.length === 0 ? (
          <button className="icon-btn chat__stop" onClick={stop} disabled={busy === 'stop'} data-tip={`Stop ${agent.name} (Esc in the session)`} aria-label="Stop the agent">
            {busy === 'stop' ? <LuLoader className="spin" /> : <LuSquare />}
          </button>
        ) : (
          <button className="icon-btn primary" onClick={() => (primeSpeech(), void send())} disabled={!canSend} data-tip={pending.uploading ? 'Waiting for the upload…' : 'Send'} aria-label="Send">
            {sending ? <LuLoader className="spin" /> : <LuSend />}
          </button>
        )}
      </div>

      {detail && (
        <FollowUpDetail
          item={detail}
          agentName={agent.name}
          agentColor={agent.look.shirt}
          age={ago(Date.now() - detail.createdAt)}
          onResolve={(d) => liveApi.decide(detail.id, toServer(detail, d)).then(() => setDetail(null), (e) => setError(e.message))}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

/** Phones: attach and folder / tags behind one + button, its menu opening upwards. */
function ComposerMenu({ disabled, contextActive, contextOpen, onAttach, onContext }: { disabled: boolean; contextActive: boolean; contextOpen: boolean; onAttach: () => void; onContext: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="composer-menu" ref={ref}>
      <button
        className={`icon-btn ghost chat__attach composer-menu__btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-label="Attach, folder and tags"
      >
        <LuPlus />
        {contextActive && <i className="composer-menu__dot" />}
      </button>
      <div className={`composer-menu__pop${open ? ' is-open' : ''}`} role="menu" inert={!open}>
        <button role="menuitem" onClick={pick(onAttach)}>
          <LuPaperclip /> Attach files
        </button>
        <button role="menuitem" className={contextActive ? 'is-on' : ''} onClick={pick(onContext)}>
          <LuTag /> {contextOpen ? 'Hide folder & tags' : contextActive ? 'Folder & tags (set)' : 'Folder & tags'}
        </button>
      </div>
    </div>
  )
}

function statusText(a: OfficeAgent) {
  if (a.status === 'offline') return 'Offline'
  if (a.status === 'waiting') return a.waitingFor === 'plan' ? 'Plan ready for review' : a.waitingFor === 'question' ? 'Asking you a question' : 'Waiting for permission'
  if (a.status === 'working') return a.tool ? `Working · ${a.tool}` : 'Working'
  return a.costUsd != null ? `Idle · $${a.costUsd.toFixed(2)} this session` : 'Idle'
}

function ToolRow({ item, result, report }: { item: Extract<ChatItem, { kind: 'tool' }>; result?: Extract<ChatItem, { kind: 'tool-result' }>; report?: WorkReport }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tool${result && !result.ok ? ' tool--err' : ''}`}>
      <div className="tool__row">
        <button className="tool__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <LuChevronRight className={`tool__chev${open ? ' open' : ''}`} />
          <b data-tip={item.tool !== toolLabel(item.tool) ? item.tool : undefined}>{toolLabel(item.tool)}</b>
          <span className="truncate mono">{item.summary}</span>
          {!result && <LuLoader className="spin muted" />}
        </button>
        {/* the note it posted to Reports (notify_user): open it */}
        {report && (
          <button className="small tool__report" onClick={() => openUrl({ report: report.id })} data-tip={report.title}>
            <LuFileText /> Open report
          </button>
        )}
      </div>
      {open && (
        <div className="tool__body ui-drop">
          <pre className="md-code">{JSON.stringify(item.input, null, 2)}</pre>
          {result && <pre className={`md-code${result.ok ? '' : ' md-code--err'}`}>{result.text || '(no output)'}</pre>}
        </div>
      )}
    </div>
  )
}

/** A pending permission / plan / question for this agent, answerable right in the chat. */
function InlineRequest({ item, onOpen, onError }: { item: Item; onOpen: (i: Item) => void; onError: (m: string) => void }) {
  const [sending, setSending] = useState(false)
  const decide = async (d: Parameters<typeof toServer>[1]) => {
    setSending(true)
    try {
      await liveApi.decide(item.id, toServer(item, d))
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not answer')
      setSending(false)
    }
  }
  const icon = item.kind === 'plan' ? <LuClipboardList /> : item.kind === 'question' ? <LuCircleHelp /> : <LuShieldAlert />
  return (
    <div className={`req req--${item.kind}`}>
      <div className="req__head">
        {icon}
        <b>{item.kind === 'plan' ? 'Plan ready' : item.kind === 'question' ? 'Question' : `${item.tool} needs permission`}</b>
      </div>
      <div className="req__msg">{item.kind === 'permission' ? <code>{item.command ?? item.message}</code> : item.message}</div>
      <div className="req__actions">
        {item.kind === 'permission' ? (
          <>
            <button className="small primary" disabled={sending} onClick={() => decide({ type: 'approve' })}>
              <LuCheck /> Allow
            </button>
            <button className="small" disabled={sending} onClick={() => decide({ type: 'approve', mode: 'always' })}>
              Always
            </button>
            <button className="small" disabled={sending} onClick={() => decide({ type: 'reject' })}>
              <LuX /> Deny
            </button>
          </>
        ) : (
          <button className="small primary" onClick={() => onOpen(item)}>
            {item.kind === 'plan' ? 'Review plan' : 'Answer'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── links to reports ──

/** too plain to tell one report from another when a message names it */
const PLAIN_TITLES = new Set(['note from the manager', 'report', 'summary', 'update'])

/**
 * The reports a chat message is about: the one it is (an agent's last answer, filed as its task's report; a note the
 * manager posted with notify_user), and the ones it names by their title.
 */
function useReportLinks() {
  const reports = useDashboard((s) => s.reports)
  return useMemo(() => {
    const byText = new Map(reports.map((r) => [r.text?.trim(), r]))
    const titled = reports.filter((r) => (r.title?.trim().length ?? 0) >= 8 && !PLAIN_TITLES.has(r.title.trim().toLowerCase()))
    const forText = (agentId: string | null, text: string): WorkReport[] => {
      const out: WorkReport[] = []
      const own = byText.get(text.trim())
      if (own && (!agentId || own.agentId === agentId)) out.push(own)
      const low = text.toLowerCase()
      for (const r of titled) {
        if (out.length >= 4) break
        if (!out.some((o) => o.id === r.id) && low.includes(r.title.trim().toLowerCase())) out.push(r)
      }
      return out
    }
    const forTool = (agentId: string, item: Extract<ChatItem, { kind: 'tool' }>) => {
      if (!/notify_user$/.test(item.tool)) return undefined
      const title = String((item.input as { title?: unknown })?.title ?? '').trim()
      return title ? reports.find((r) => r.agentId === agentId && r.kind === 'note' && r.title.trim() === title) : undefined
    }
    return { forText, forTool }
  }, [reports])
}

/** Links under a message to the reports it is or names. */
function ReportLinks({ reports, agent }: { reports: WorkReport[]; agent?: boolean }) {
  if (!reports.length) return null
  return (
    <div className={`msg__reports${agent ? ' msg__reports--agent' : ''}`}>
      {reports.map((r) => (
        <button key={r.id} type="button" className="msg__report" onClick={() => openUrl({ report: r.id })} data-tip="Open the report">
          <LuFileText />
          <span className="truncate">{r.title}</span>
        </button>
      ))}
    </div>
  )
}
