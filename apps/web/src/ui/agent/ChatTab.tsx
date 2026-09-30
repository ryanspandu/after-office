import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, useMemo } from 'react'
import { LuCheck, LuChevronDown, LuChevronRight, LuChevronUp, LuCircleStop, LuClipboardList, LuCircleHelp, LuLoader, LuPaperclip, LuSearch, LuSend, LuShieldAlert, LuSlidersHorizontal, LuX } from 'react-icons/lu'
import { MOBILE, useMediaQuery } from '../../state/useMediaQuery'
import type { ChatItem, LiveMode } from '@after-office/shared'
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

// Chat with one agent. Messages come from its Claude Code transcript; what you send is typed into its tmux session.

export const MODEL_OPTIONS = MODELS.map((m) => ({ value: m.value as string, label: m.label }))
const MODE_OPTIONS: { value: LiveMode; label: string }[] = (['default', 'acceptEdits', 'plan', 'auto'] as LiveMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))

/** "claude-sonnet-5" → "sonnet" so the dropdown shows the running model. */
export const modelAlias = (id?: string) => modelChoiceOf(id)

export function ChatTab({ agent }: { agent: OfficeAgent }) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const followUps = useLive((s) => s.followUps).filter((f) => f.agentId === agent.id)
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
    const res = await api(`/api/agents/${agent.id}/chat?limit=${limit}`)
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
  }, [agent.id, limit])

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
    if (agent.unread && document.visibilityState === 'visible') void liveApi.markChatRead(agent.id).catch(() => {})
  }, [agent.id, agent.unread])
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && useOffice.getState().agents.find((a) => a.id === agent.id)?.unread && void liveApi.markChatRead(agent.id).catch(() => {})
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [agent.id])

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
  const fileInput = useRef<HTMLInputElement>(null)
  // the message box grows with what's typed, up to its max-height (CSS), then scrolls
  const box = useRef<HTMLTextAreaElement>(null)
  // opening the chat puts the cursor in the message box (not on phones: that would pop the keyboard up over it)
  useEffect(() => {
    if (!mobile && !offline) box.current?.focus({ preventScroll: true })
  }, [agent.id, mobile, offline])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
    // a scrollbar only once it's at its max-height and there's more
    el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden'
  }, [text])
  const [dragging, setDragging] = useState(false)
  const attach = (files: File[]) => {
    if (!files.length || offline) return
    const problem = pending.add(files)
    setError(problem ?? '')
  }
  const canSend = !offline && !sending && !pending.uploading && (!!text.trim() || pending.ids.length > 0)

  // the message just sent, shown right away (below the chat, above the typing bubble) until the transcript has it
  const [outgoing, setOutgoing] = useState<{ text: string; files: Pending[]; at: number } | null>(null)
  // …and swapped for the real one in the same render: no gap, no second fade-in
  const delivered = outgoing ? items.find((i) => i.kind === 'user' && i.at >= outgoing.at - 1000) : undefined
  if (delivered) seen.current?.add(delivered.id)
  useEffect(() => {
    if (!delivered) return
    // the real message shows the files from the agent's folder now: free the local previews
    setOutgoing((o) => (o?.files.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb)), null))
  }, [delivered])

  const send = async () => {
    const body = text.trim()
    if (!canSend) return
    setSending(true)
    setError('')
    const at = Date.now()
    setOutgoing({ text: body, files: pending.items.filter((p) => p.state === 'done'), at })
    stick.current = true
    try {
      await liveApi.prompt(agent.id, body, pending.ids)
      setSentAt(at)
      setText('')
      pending.take()
      stick.current = true
      setTimeout(load, 600)
    } catch (e) {
      setOutgoing(null)
      setError(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

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
        <Select
          ariaLabel="Model"
          size="sm"
          value={modelAlias(agent.model)}
          options={MODEL_OPTIONS}
          disabled={offline || !!busy || active}
          onChange={(m) => run('model', () => liveApi.setModel(agent.id, m))}
        />
        <Select
          ariaLabel="Permission mode"
          size="sm"
          value={agent.permissionMode ?? 'default'}
          options={MODE_OPTIONS}
          disabled={offline || !!busy}
          onChange={(m) =>
            run('mode', async () => {
              const r = await liveApi.setMode(agent.id, m)
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
        {active && !mobile && (
          <button className="small" onClick={() => run('stop', () => liveApi.interrupt(agent.id))} data-tip="Press Esc in the session">
            <LuCircleStop /> Stop
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
      {mobile ? (
        <>
          <div className={`chat__float${findOpen ? ' chat__float--find' : ''}`}>
            {active && !findOpen && (
              <button className="small" onClick={() => run('stop', () => liveApi.interrupt(agent.id))} aria-label="Stop the agent">
                <LuCircleStop /> Stop
              </button>
            )}
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
            const { text: said, paths } = splitAttachments(i.text)
            const files = paths.map((p) => ownerFiles.get(p)).filter((f) => !!f)
            return (
              <div key={i.id} data-mid={i.id} className={`msg-user${isNew(i.id)}`}>
                {files.length > 0 && (
                  <div className="msg-user__files">
                    <Attachments agentId={agent.id} files={files} />
                  </div>
                )}
                {said && <div className={`msg msg--user${i.id === current ? ' msg--hit' : ''}`}>{said}</div>}
              </div>
            )
          }
          if (i.kind === 'assistant') {
            const files = (attachmentPaths.get(i.id) ?? []).map((p) => agentFiles.get(p)).filter((f) => !!f)
            return (
              <div key={i.id} data-mid={i.id} className={`msg msg--agent${isNew(i.id)}${i.id === current ? ' msg--hit' : ''}`}>
                <FileLinksProvider agentId={agent.id} files={files}>
                  <Markdown text={i.text} />
                </FileLinksProvider>
                <Attachments agentId={agent.id} files={files} />
              </div>
            )
          }
          if (i.kind === 'tool') return <ToolRow key={i.id} item={i} result={results.get(i.id)} />
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

      {offline && <OfflineBanner agent={agent} />}
      {error && <div className="chat__error">{error}</div>}
      {!error && notice && agent.status === 'waiting' && <div className="chat__notice">{notice}</div>}
      <PendingTray items={pending.items} onRemove={pending.remove} />
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
        <button className="icon-btn ghost chat__attach" onClick={() => fileInput.current?.click()} disabled={offline || sending} {...tip('Attach files or pictures (or paste / drop them here)')}>
          <LuPaperclip />
        </button>
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            // pasted pictures / files become attachments; pasted text stays text
            const files = [...e.clipboardData.files]
            if (!files.length) return
            e.preventDefault()
            attach(files)
          }}
          rows={1}
          placeholder={offline ? 'The agent is offline' : `Message ${agent.name}…  (Enter to send, Shift+Enter for a new line)`}
          disabled={offline}
        />
        <button className="icon-btn primary" onClick={send} disabled={!canSend} data-tip={pending.uploading ? 'Waiting for the upload…' : 'Send'} aria-label="Send">
          {sending ? <LuLoader className="spin" /> : <LuSend />}
        </button>
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

function statusText(a: OfficeAgent) {
  if (a.status === 'offline') return 'Offline'
  if (a.status === 'waiting') return a.waitingFor === 'plan' ? 'Plan ready for review' : a.waitingFor === 'question' ? 'Asking you a question' : 'Waiting for permission'
  if (a.status === 'working') return a.tool ? `Working · ${a.tool}` : 'Working'
  return a.costUsd != null ? `Idle · $${a.costUsd.toFixed(2)} this session` : 'Idle'
}

function ToolRow({ item, result }: { item: Extract<ChatItem, { kind: 'tool' }>; result?: Extract<ChatItem, { kind: 'tool-result' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tool${result && !result.ok ? ' tool--err' : ''}`}>
      <button className="tool__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <LuChevronRight className={`tool__chev${open ? ' open' : ''}`} />
        <b data-tip={item.tool !== toolLabel(item.tool) ? item.tool : undefined}>{toolLabel(item.tool)}</b>
        <span className="truncate mono">{item.summary}</span>
        {!result && <LuLoader className="spin muted" />}
      </button>
      {open && (
        <div className="tool__body">
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
