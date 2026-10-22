import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import {
  LuCrown,
  LuBot,
  LuCircleAlert,
  LuCoffee,
  LuKeyboard,
  LuPowerOff,
  LuRotateCw,
  LuLocateFixed,
  LuMessageSquareText,
  LuSlidersHorizontal,
  LuTrash2,
  LuUserPlus,
  LuUsers,
  LuPin,
  LuPinOff,
  LuSearch,
  LuX,
  LuEllipsis,
  LuMoon,
  LuSun,
} from 'react-icons/lu'
import type { AgentStatus, LiveMode } from '@after-office/shared'
import { liveApi, useLive } from '../state/live'
import { isAway, unreadOf, useOffice, type OfficeAgent, avatarStyle } from '../state/store'
import { ReportsPanel } from './Reports'
import { ThreadsPanel } from './Threads'
import { idleText, waitingLabel } from './agentActivity'
import { useDashboard } from '../state/dashboard'
import { confirmWith } from './Confirm'
import { useMenuDismiss } from './ActionMenu'
import { openUrl, setUrl } from '../state/url'
import { tip } from './Tooltip'
import { MOBILE, useMediaQuery } from '../state/useMediaQuery'
import { useFlip } from '../state/useFlip'
import { AgentFace } from './AgentFace'

export const STATUS_META: Record<AgentStatus, { label: string; icon: ReactNode }> = {
  working: { label: 'Working', icon: <LuKeyboard /> },
  waiting: { label: 'Needs you', icon: <LuCircleAlert /> },
  idle: { label: 'Idle', icon: <LuCoffee /> },
  meeting: { label: 'Meeting', icon: <LuUsers /> },
  offline: { label: 'Offline', icon: <LuPowerOff /> },
  asleep: { label: 'Asleep', icon: <LuMoon /> },
}
const STAT_STATUSES: AgentStatus[] = ['working', 'waiting', 'idle', 'meeting']

export const MODE_LABEL: Record<LiveMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
}

/** Right column on desktop: reports, threads and agents. On phones the dock (MobileDock.tsx) shows these in modals. */
export function AgentsPanel() {
  return (
    <aside className="side side--right">
      <ReportsPanel />
      <ThreadsPanel />
      <AgentsCard />
    </aside>
  )
}

/** The agents card: source switch, status counts, list and actions. `onNavigate` closes the mobile modal. */
export function AgentsCard({ onNavigate }: { onNavigate?: () => void }) {
  const { agents, selectedId, simOn, source, setSource, setStatus, removeAgent, startMeeting, select, toggleSim, openProfile } = useOffice(useShallow((s) => ({ agents: s.agents, selectedId: s.selectedId, simOn: s.simOn, source: s.source, setSource: s.setSource, setStatus: s.setStatus, removeAgent: s.removeAgent, startMeeting: s.startMeeting, select: s.select, toggleSim: s.toggleSim, openProfile: s.openProfile })))
  const connected = useLive((s) => s.connected)
  const live = source === 'live'
  // search (name, role, status, folder) and pins: pinned agents stay on top, the manager leads each group
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  // the live ones first, the asleep / offline ones under them (pinned or not); then pinned ones first; then, among
  // the pinned and among the rest, the busy ones on top (waiting on the owner, then working); the manager leads what's left
  const away = (a: OfficeAgent) => Number(a.status === 'asleep' || a.status === 'offline')
  const busyRank = (a: OfficeAgent) => (a.status === 'waiting' ? 2 : a.status === 'working' ? 1 : 0)
  // re-ordered (one starts or stops working): the rows slide to their new places
  const listRef = useRef<HTMLUListElement>(null)
  const shown = [...agents]
    .sort((a, b) => away(a) - away(b) || Number(!!b.pinned) - Number(!!a.pinned) || busyRank(b) - busyRank(a) || Number(b.kind === 'manager') - Number(a.kind === 'manager'))
    .filter(
      (a) =>
        !needle ||
        [a.name, a.role, a.profile.role, STATUS_META[a.status].label, a.cwd, a.tmuxSession].some((v) => v?.toLowerCase().includes(needle)),
    )
  const togglePin = (a: OfficeAgent) => {
    const pinned = !a.pinned
    // shown right away; live, the server keeps it (the same on every device)
    useOffice.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? { ...x, pinned } : x)) }))
    if (live) void liveApi.setPinned(a.id, pinned).catch(() => useOffice.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? { ...x, pinned: !pinned } : x)) })))
  }
  useFlip(listRef, shown.map((a) => a.id).join(','))

  return (
    <>
      <section className="card card--grow agents-card">
        <header className="card__head">
          <h2>
            <LuBot /> Agents
          </h2>
          <span className="muted">{agents.length}</span>
          <div className="seg source-seg" role="tablist" aria-label="Data source">
            <button className={live ? 'active' : ''} onClick={() => setSource('live')} data-tip="Real Claude Code sessions on the server">
              <span className={`live-dot${live && connected ? ' live-dot--on' : ''}`} /> Live
            </button>
            <button className={!live ? 'active' : ''} onClick={() => setSource('demo')} data-tip="Built-in simulation">
              Demo
            </button>
          </div>
          {!live && (
            <label className="toggle" data-tip="Simulate agent activity">
              <input type="checkbox" checked={simOn} onChange={toggleSim} />
              <span />
            </label>
          )}
        </header>

        <div className="stats">
          {STAT_STATUSES.map((status) => (
            <div key={status} className={`stat stat--${status}`} data-tip={STATUS_META[status].label}>
              {STATUS_META[status].icon}
              <b>{agents.filter((a) => a.status === status).length}</b>
            </div>
          ))}
        </div>

        {agents.length > 0 && (
          <label className="search-box agents-search">
            <LuSearch />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents" aria-label="Search agents" />
            {q && (
              <button className="icon-btn small ghost" onClick={() => setQ('')} aria-label="Clear search" data-tip="Clear">
                <LuX />
              </button>
            )}
          </label>
        )}

        <ul className="list" ref={listRef}>
          {shown.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              onPin={() => togglePin(a)}
              live={live}
              selected={selectedId === a.id}
              onSelect={() => select(selectedId === a.id ? null : a.id)}
              onProfile={() => {
                onNavigate?.()
                openProfile(a.id)
              }}
              onStatus={(status) => setStatus(a.id, status, status === 'idle' ? { task: undefined, tool: undefined } : {})}
              onRemove={() => (live ? liveApi.deleteAgent(a.id) : removeAgent(a.id))}
            />
          ))}
          {agents.length > 0 && !shown.length && <li className="empty">No agents match “{q.trim()}”.</li>}
          {!agents.length && (
            <li className="empty">{live ? (connected ? 'No agents yet. Add one to start a Claude Code session.' : 'Connecting to the server…') : 'No agents.'}</li>
          )}
        </ul>

        <footer className="card__foot">
          <button onClick={() => openUrl({ addagent: '1' })}>
            <LuUserPlus /> Add agent
          </button>
          {live && !agents.some((a) => a.kind === 'manager') && (
            <button onClick={() => openUrl({ addagent: 'manager' })} {...tip('A manager hands work to your agents and reports back to you')}>
              <LuCrown /> Hire manager
            </button>
          )}
          {!live && (
            <button
              disabled={agents.length < 2}
              onClick={() =>
                startMeeting(
                  [...agents]
                    .sort(() => Math.random() - 0.5)
                    .slice(0, 3 + Math.floor(Math.random() * 4))
                    .map((a) => a.id),
                )
              }
            >
              <LuUsers /> Meeting
            </button>
          )}
        </footer>
      </section>
    </>
  )
}

function AgentRow({
  agent: a,
  live,
  selected,
  onSelect,
  onProfile,
  onStatus,
  onRemove,
  onPin,
}: {
  agent: OfficeAgent
  live: boolean
  selected: boolean
  onSelect: () => void
  onProfile: () => void
  onStatus: (s: AgentStatus) => void
  onRemove: () => Promise<unknown> | void
  onPin: () => void
}) {
  const queued = useLive((s) => (live ? (s.queued[a.id] ?? 0) : 0))
  // its last prompt is kept in memory only (gone after a server restart): else the task it's running
  const running = useDashboard((s) =>
    s.tasks.filter((t) => t.agentId === a.id && t.status === 'in_progress').sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0]?.title,
  )
  const phone = useMediaQuery(MOBILE)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const act = async (label: string, fn: () => Promise<unknown> | void) => {
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

  const liveMeta = [
    a.modelName ?? a.model,
    a.permissionMode && MODE_LABEL[a.permissionMode],
    a.contextPct != null && `${Math.round(a.contextPct)}% ctx`,
    queued > 0 && `${queued} queued`,
  ]
    .filter(Boolean)
    .join(' · ')

  const removeAgent = async () => {
    const tilde = (a.cwd ?? '').replace(/^\/(Users|home)\/[^/]+/, '~')
    const folder = live ? await liveApi.agentFolder(a.id) : null
    const items = folder?.entries ?? 0
    const { ok, option } = await confirmWith({
      title: `Remove ${a.name}?`,
      message: live ? (
        <>
          Its session stops and it leaves the office; its tasks stay, without an agent.{' '}
          {folder?.deletable ? 'Its folder stays unless you tick the box below.' : <>Its folder <code>{tilde}</code> and the files in it stay.</>}
        </>
      ) : (
        'It leaves the demo office.'
      ),
      confirmLabel: 'Remove',
      option: folder?.deletable
        ? {
            label: (
              <>
                Also delete its folder <code>{tilde}</code>
              </>
            ),
            hint: (
              <span className="danger-text">
                {items ? `${items >= 10_000 ? '10,000+' : items} item${items === 1 ? '' : 's'} (its CLAUDE.md, skills and everything it made)` : 'It is empty.'}{' '}
                are deleted for good. Back up or download anything you still need first (Folders tab → its folder → Files).
              </span>
            ),
          }
        : undefined,
    })
    if (ok) act('remove', () => (live ? liveApi.deleteAgent(a.id, { folder: option }) : onRemove()))
  }

  // one click on the card opens its chat (its profile in the demo); the rest is in its menu: right click (or a long
  // press on a phone), like the folders. Phones: a tap on the card does nothing (it's easy to hit while scrolling); the
  // chat button under the status opens it.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  const longPress = useLongPress(setMenuAt)
  return (
    <li
      data-flip={a.id}
      className={`row agent${selected ? ' row--selected' : ''}${isAway(a.status) ? ' row--off' : ''}${menuAt ? ' row--menu' : ''}`}
      onClick={phone ? undefined : onProfile}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuAt({ x: e.clientX, y: e.clientY })
      }}
      {...longPress}
    >
      <div className="agent__side">
        <span className="avatar" style={avatarStyle(a.look.shirt)} aria-hidden>
          {busy ? <LuRotateCw className="spin" /> : <AgentFace look={a.look} />}
        </span>
        <AgentMenu
          at={menuAt}
          onClose={closeMenu}
          items={[
            ...(!live
              ? STAT_STATUSES.map((status) => ({ key: status, icon: STATUS_META[status].icon, label: STATUS_META[status].label, on: a.status === status, run: () => onStatus(status) }))
              : []),
            {
              key: 'chat',
              icon: live ? <LuMessageSquareText /> : <LuSlidersHorizontal />,
              label: live ? (unreadOf(a) ? `Open chat · ${unreadOf(a)} new` : 'Open chat') : 'Open profile',
              run: onProfile,
            },
            // the camera goes to it in the office and follows it (a phone's Agents sheet makes way)
            ...(!isAway(a.status)
              ? [{ key: 'map', icon: <LuLocateFixed />, label: 'Show on map', run: () => (useOffice.getState().select(a.id), setUrl({ sheet: null })) }]
              : []),
            ...(live && a.status === 'asleep'
              ? [{ key: 'wake', icon: <LuSun />, label: 'Wake up', hint: 'ready in about 15 s', run: () => act('wake', () => liveApi.wake(a.id)) }]
              : live
                ? [{ key: 'restart', icon: <LuRotateCw />, label: 'Restart session', hint: 'keeps the conversation', run: () => act('restart', () => liveApi.restart(a.id)) }]
                : []),
            // its session stops so its memory comes back; work for it wakes it up again. Not the manager.
            ...(live && a.kind !== 'manager' && !isAway(a.status)
              ? [{ key: 'sleep', icon: <LuMoon />, label: 'Put to sleep', hint: 'frees its memory; work wakes it', run: () => act('sleep', () => liveApi.sleep(a.id)) }]
              : []),
            { key: 'pin', icon: a.pinned ? <LuPinOff /> : <LuPin />, label: a.pinned ? 'Unpin' : 'Pin to the top', run: onPin },
            { key: 'remove', icon: <LuTrash2 />, label: 'Remove agent', danger: true, run: () => void removeAgent() },
          ]}
        />
      </div>
      <div className="row__body">
        <div className="row__title">
          {a.name}
          {a.pinned && (
            <span className="pin-badge" {...tip('Pinned')}>
              <LuPin />
            </span>
          )}
          {a.kind === 'manager' && (
            <span className="manager-badge" {...tip('Manager: delegates to the other agents')}>
              <LuCrown />
            </span>
          )}
          <span className="muted role">{a.role || a.profile.role}</span>
          {live && unreadOf(a) > 0 && (
            <span className="row__unread" {...tip(`${unreadOf(a)} new ${unreadOf(a) === 1 ? 'reply' : 'replies'}`)}>
              <LuMessageSquareText /> {unreadOf(a) > 9 ? '9+' : unreadOf(a)}
            </span>
          )}
          <span className={`status status--${a.status}`}>{a.status === 'waiting' && a.waitingFor ? waitingLabel(a.waitingFor) : STATUS_META[a.status].label}</span>
        </div>
        {phone && (
          <button type="button" className="icon-btn small agent__chat" onClick={onProfile} aria-label={live ? `Chat with ${a.name}` : `${a.name}'s profile`}>
            {live ? <LuMessageSquareText /> : <LuSlidersHorizontal />}
            {live && unreadOf(a) > 0 && <span className="agent__chat-count">{unreadOf(a) > 9 ? '9+' : unreadOf(a)}</span>}
          </button>
        )}
        <div className="row__meta truncate">
          {a.tool && a.status !== 'idle' && <code>{a.tool}</code>}
          {a.status === 'asleep'
            ? 'Asleep to save memory · work for it wakes it up'
            : a.status === 'idle'
              ? live
                ? (a.lastMessage ?? idleText(a.spotId))
                : idleText(a.spotId)
              : (a.task ?? running ?? '—')}
        </div>
        {live && liveMeta && <div className="row__mono truncate">{liveMeta}</div>}
        {error && <div className="row__error">{error}</div>}
        <div className="row__mono truncate" data-tip={a.cwd}>
          {a.tmuxSession}
          {a.cwd && <> · {a.cwd.replace(/^\/(Users|home)\/[^/]+/, '~')}</>}
        </div>
      </div>
    </li>
  )
}

interface MenuItem {
  key: string
  icon: ReactNode
  label: string
  hint?: string
  on?: boolean
  danger?: boolean
  run: () => void
}

/** The card's ⋯ button and its menu (chat, restart, pin, remove; the demo's statuses). */
function AgentMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null)
  // a tap elsewhere only closes it; phones: Back too (ActionMenu.tsx)
  const release = useMenuDismiss(pop, !!at, onClose)
  useEffect(() => {
    if (!at) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [at, onClose])
  if (!at) return null
  // where it was asked for, kept inside the screen (above the point when there's no room below)
  const width = 220
  const height = items.length * 38 + 12
  const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8))
  const top = at.y + height + 8 < window.innerHeight ? at.y : Math.max(8, at.y - height)
  return createPortal(
    <div className="stab-menu__pop agent-menu" role="menu" ref={pop} style={{ left, top, width }} onClick={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button
          key={it.key}
          role="menuitem"
          className={`${it.danger ? 'danger-text' : ''}${it.on ? ' is-on' : ''}`}
          onClick={() => {
            release()
            onClose()
            it.run()
          }}
        >
          {it.icon}
          <span className="agent-menu__label">
            {it.label}
            {it.hint && <span className="muted agent-menu__hint">{it.hint}</span>}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

/** A finger held still on it for a moment: its menu (phones have no right click). Moving (scrolling) cancels. */
function useLongPress(onPress: (at: { x: number; y: number }) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        // the phone may have started selecting a word under the finger: the menu, not a selection
        window.getSelection()?.removeAllRanges()
        if (start.current) onPress(start.current)
      }, 500)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 8) cancel()
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  }
}

