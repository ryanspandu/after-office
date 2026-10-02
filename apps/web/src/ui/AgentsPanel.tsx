import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  LuCrown,
  LuBot,
  LuCircleAlert,
  LuCoffee,
  LuKeyboard,
  LuPowerOff,
  LuRotateCw,
  LuMessageSquareText,
  LuSlidersHorizontal,
  LuTrash2,
  LuUserPlus,
  LuUsers,
  LuPin,
  LuPinOff,
  LuSearch,
  LuX,
} from 'react-icons/lu'
import type { AgentStatus, LiveMode } from '@after-office/shared'
import { liveApi, useLive } from '../state/live'
import { useOffice, type OfficeAgent, avatarStyle } from '../state/store'
import { ReportsPanel } from './Reports'
import { confirmWith } from './Confirm'
import { openUrl } from '../state/url'
import { tip } from './Tooltip'

export const STATUS_META: Record<AgentStatus, { label: string; icon: ReactNode }> = {
  working: { label: 'Working', icon: <LuKeyboard /> },
  waiting: { label: 'Needs you', icon: <LuCircleAlert /> },
  idle: { label: 'Idle', icon: <LuCoffee /> },
  meeting: { label: 'Meeting', icon: <LuUsers /> },
  offline: { label: 'Offline', icon: <LuPowerOff /> },
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

/** Right column on desktop: reports + agents. On phones the dock (MobileDock.tsx) shows these in modals. */
export function AgentsPanel() {
  return (
    <aside className="side side--right">
      <ReportsPanel />
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
  const shown = [...agents]
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(b.kind === 'manager') - Number(a.kind === 'manager'))
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

        <ul className="list">
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

  return (
    <li className={`row agent${selected ? ' row--selected' : ''}${a.status === 'offline' ? ' row--off' : ''}`} onClick={onSelect}>
      <button
        className="avatar avatar--btn"
        style={avatarStyle(a.look.shirt)}
        data-tip="Open profile"
        aria-label={`Open ${a.name} profile`}
        onClick={(e) => {
          e.stopPropagation()
          onProfile()
        }}
      >
        {a.name[0]}
      </button>
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
          {/* collapsed: unread replies show here (expanded, they're on the chat button) */}
          {live && !selected && !!a.unread && (
            <button
              className="row__unread"
              {...tip(`${a.unread} new ${a.unread === 1 ? 'reply' : 'replies'} · open chat`)}
              onClick={(e) => {
                e.stopPropagation()
                onProfile()
              }}
            >
              <LuMessageSquareText /> {a.unread > 9 ? '9+' : a.unread}
            </button>
          )}
          <span className={`status status--${a.status}`}>{a.status === 'waiting' && a.waitingFor ? waitingLabel(a.waitingFor) : STATUS_META[a.status].label}</span>
        </div>
        <div className="row__meta truncate">
          {a.tool && a.status !== 'idle' && <code>{a.tool}</code>}
          {a.status === 'idle' ? (live ? a.lastMessage ?? idleText(a.spotId) : idleText(a.spotId)) : (a.task ?? '—')}
        </div>
        {live && liveMeta && <div className="row__mono truncate">{liveMeta}</div>}
        {/* always rendered; opens with a height + fade transition instead of popping in */}
        <div className={`row__expand${selected ? ' row__expand--open' : ''}`} inert={!selected}>
          <div className="row__expand-inner">
              <div className="row__actions" onClick={(e) => e.stopPropagation()}>
                {!live && (
                  <div className="seg">
                    {STAT_STATUSES.map((status) => (
                      <button
                        key={status}
                        data-tip={STATUS_META[status].label}
                        aria-label={STATUS_META[status].label}
                        className={a.status === status ? 'active' : ''}
                        onClick={() => onStatus(status)}
                      >
                        {STATUS_META[status].icon}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="icon-btn small icon-btn--badge"
                  data-tip={live ? (a.unread ? `${a.unread} new ${a.unread === 1 ? 'reply' : 'replies'} · open chat` : 'Chat & profile') : 'Profile'}
                  aria-label={live ? `Open chat${a.unread ? `, ${a.unread} unread` : ''}` : 'Open profile'}
                  onClick={onProfile}
                >
                  {live ? <LuMessageSquareText /> : <LuSlidersHorizontal />}
                  {live && !!a.unread && <span className="icon-btn__count">{a.unread > 9 ? '9+' : a.unread}</span>}
                </button>
                {live && (
                  <button className="icon-btn small" data-tip="Restart session (keeps the conversation)" aria-label="Restart session" disabled={!!busy} onClick={() => act('restart', () => liveApi.restart(a.id))}>
                    <LuRotateCw className={busy === 'restart' ? 'spin' : ''} />
                  </button>
                )}
                <button
                  className="icon-btn small icon-btn--toggle pin-btn"
                  aria-pressed={!!a.pinned}
                  data-tip={a.pinned ? 'Unpin' : 'Pin to the top'}
                  aria-label={a.pinned ? `Unpin ${a.name}` : `Pin ${a.name}`}
                  onClick={onPin}
                >
                  {a.pinned ? <LuPinOff /> : <LuPin />}
                </button>
                <button
                  className="icon-btn small ghost"
                  data-tip="Remove agent"
                  aria-label="Remove agent"
                  disabled={!!busy}
                  onClick={async () => {
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
                  }}
                >
                  <LuTrash2 />
                </button>
              </div>
          </div>
        </div>
        {error && <div className="row__error">{error}</div>}
        <div className="row__mono truncate" data-tip={a.cwd}>
          {a.tmuxSession}
          {a.cwd && <> · {a.cwd.replace(/^\/(Users|home)\/[^/]+/, '~')}</>}
        </div>
      </div>
    </li>
  )
}

function waitingLabel(k: NonNullable<OfficeAgent['waitingFor']>) {
  return k === 'plan' ? 'Plan ready' : k === 'question' ? 'Question' : 'Needs you'
}

function idleText(spotId: string) {
  if (spotId.startsWith('cat')) return 'Playing with the cat'
  if (spotId.startsWith('pool')) return 'Shooting pool'
  if (spotId.startsWith('sofa')) return 'Watching TV'
  if (spotId.startsWith('pantry')) return 'Snack break in the pantry'
  if (spotId.startsWith('desk')) return 'Chilling at the desk'
  return 'Idle'
}
