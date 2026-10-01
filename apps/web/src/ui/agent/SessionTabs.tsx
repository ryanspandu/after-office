import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LuCheck, LuHistory, LuLoader, LuPlus, LuTrash2, LuX } from 'react-icons/lu'
import type { SideSessionInfo } from '@after-office/shared'
import { liveApi } from '../../state/live'
import type { OfficeAgent } from '../../state/store'
import { confirm } from '../Confirm'
import { ago } from '../FollowUps'

// An agent's chats: its main session (tasks, daily jobs and the manager's messages go there) and the side sessions the
// owner opened (each its own Claude Code process: closing one stops it and frees its memory; it can be opened again).

export const sessionName = (s: Pick<SideSessionInfo, 'key' | 'title'>) => s.title?.trim() || `Session ${s.key.slice(1)}`

function Dot({ status, waitingFor }: { status: string; waitingFor?: string }) {
  const tone = status === 'waiting' || waitingFor ? 'waiting' : status === 'working' ? 'working' : status === 'offline' ? 'offline' : 'idle'
  return <i className={`stab__dot stab__dot--${tone}`} />
}

export function SessionTabs({ agent, current, onPick }: { agent: OfficeAgent; current: string; onPick: (key: string) => void }) {
  const open = (agent.sessions ?? []).filter((s) => s.open)
  const closed = (agent.sessions ?? []).filter((s) => !s.open)
  const [menu, setMenu] = useState(false)
  // where the menu opens: under the + button, kept inside the screen (near the right edge it opens to the left)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const toggleMenu = () => {
    if (menu) return setMenu(false)
    const r = addRef.current?.getBoundingClientRect()
    if (r) {
      const width = Math.min(300, window.innerWidth - 16)
      setPos({ width, top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) })
    }
    setMenu(true)
  }
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node) && setMenu(false)
    // the screen turned or resized: its place is stale
    const shut = () => setMenu(false)
    document.addEventListener('pointerdown', away)
    window.addEventListener('resize', shut)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('resize', shut)
    }
  }, [menu])
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }
  const newSession = () =>
    act('new', async () => {
      setMenu(false)
      const { key } = await liveApi.openSession(agent.id)
      onPick(key)
    })
  const reopen = (key: string) =>
    act(key, async () => {
      setMenu(false)
      await liveApi.reopenSession(agent.id, key)
      onPick(key)
    })
  const close = async (s: SideSessionInfo) => {
    const ok = await confirm({
      title: `Close ${sessionName(s)}?`,
      message: s.status === 'working' ? 'It is working right now: that stops. Its process ends and frees its memory; the conversation stays, to open again.' : 'Its process ends and frees its memory. The conversation stays: open it again from + any time.',
      confirmLabel: 'Close',
    })
    if (!ok) return
    if (current === s.key) onPick('')
    await act(s.key, () => liveApi.closeSession(agent.id, s.key))
  }
  // renaming a side session: tap its tab again once it's open (or double-click it)
  const [editing, setEditing] = useState<string | null>(null)
  const rename = (s: SideSessionInfo, name: string | null) => {
    setEditing(null)
    if (name === null || name.trim() === (s.title ?? '').trim()) return
    void act(s.key, () => liveApi.renameSession(agent.id, s.key, name))
  }
  const mainStatus = agent.mainStatus ?? agent.status
  return (
    <div className="stabs-wrap">
      <div className="stabs" role="tablist" aria-label="Sessions">
        <button role="tab" aria-selected={current === ''} className={`stab${current === '' ? ' is-on' : ''}`} onClick={() => onPick('')} data-tip="Tasks, daily jobs and the manager's messages come here">
          <Dot status={mainStatus} waitingFor={agent.waitingFor} />
          Main
          {!!agent.unread && current !== '' && <span className="stab__badge">{agent.unread}</span>}
        </button>
        {open.map((s) =>
          editing === s.key ? (
            <NameInput key={s.key} value={sessionName(s)} onDone={(name) => rename(s, name)} />
          ) : (
          <span key={s.key} className={`stab${current === s.key ? ' is-on' : ''}`} role="presentation">
            <button
              role="tab"
              aria-selected={current === s.key}
              className="stab__pick"
              onClick={() => (current === s.key ? setEditing(s.key) : onPick(s.key))}
              onDoubleClick={() => setEditing(s.key)}
              data-tip={current === s.key ? 'Rename' : s.title ? `${s.title} · session ${s.key.slice(1)}` : undefined}
            >
              <Dot status={s.status} waitingFor={s.waitingFor} />
              <span className="truncate">{sessionName(s)}</span>
              {!!s.unread && current !== s.key && <span className="stab__badge">{s.unread}</span>}
            </button>
            <button className="stab__x" onClick={() => void close(s)} disabled={busy === s.key} aria-label={`Close ${sessionName(s)}`}>
              {busy === s.key ? <LuLoader className="spin" /> : <LuX />}
            </button>
          </span>
          ),
        )}
        <div className="stab-menu" ref={menuRef}>
          <button ref={addRef} className="stab stab--add" onClick={() => (closed.length ? toggleMenu() : void newSession())} disabled={busy === 'new' || agent.status === 'offline'} aria-label="New session" data-tip="A new session: another chat with this agent, running at the same time">
            {busy === 'new' ? <LuLoader className="spin" /> : <LuPlus />}
          </button>
          {menu &&
            // on the page itself: inside the drawer (which moves in with a transform) "fixed" would be off
            createPortal(
            <div className="stab-menu__pop" role="menu" ref={popRef} style={pos ? { left: pos.left, top: pos.top, width: pos.width } : undefined}>
              <button role="menuitem" onClick={() => void newSession()}>
                <LuPlus /> New session
              </button>
              <span className="stab-menu__head muted">Closed sessions</span>
              {closed.map((s) => (
                <span key={s.key} className="stab-menu__row">
                  <button role="menuitem" onClick={() => void reopen(s.key)} disabled={!!busy}>
                    <LuHistory />
                    <span className="truncate">{sessionName(s)}</span>
                    <span className="muted stab-menu__when">{s.closedAt ? ago(Date.now() - s.closedAt) : ''}</span>
                  </button>
                  <button className="icon-btn small ghost" aria-label={`Remove ${sessionName(s)} from the list`} data-tip="Remove from the list" onClick={() => void act(s.key, () => liveApi.forgetSession(agent.id, s.key))}>
                    <LuTrash2 />
                  </button>
                </span>
              ))}
            </div>,
            document.body,
            )}
        </div>
      </div>
      {error && <div className="chat__error">{error}</div>}
    </div>
  )
}

/** A side session's name being edited in its tab: Enter or ✓ keeps it, Escape or ✕ cancels, empty goes back to the title. */
function NameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(value)
  // the buttons act on mousedown: before the field's blur (which keeps the text)
  const press = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault()
    fn()
  }
  return (
    <span className="stab stab--edit is-on">
      <input
        autoFocus
        value={v}
        maxLength={60}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone(v)
          if (e.key === 'Escape') {
            e.stopPropagation()
            onDone(null)
          }
        }}
        onBlur={() => onDone(v)}
        aria-label="Session name"
      />
      <button className="stab__x" onMouseDown={press(() => onDone(v))} aria-label="Save the name">
        <LuCheck />
      </button>
      <button className="stab__x" onMouseDown={press(() => onDone(null))} aria-label="Cancel">
        <LuX />
      </button>
    </span>
  )
}
