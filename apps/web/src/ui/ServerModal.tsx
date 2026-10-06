import { useCallback, useEffect, useState } from 'react'
import { LuCheck, LuCircleAlert, LuCopy, LuExternalLink, LuKeyRound, LuLoader, LuMinus, LuRefreshCw, LuSquare, LuSquareTerminal, LuX } from 'react-icons/lu'
import { api } from '../state/auth'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { openUrl, setUrl } from '../state/url'
import { ActionMenu } from './ActionMenu'
import { confirm } from './Confirm'
import { Modal } from './Modal'
import { useModalMaximize } from './Maximize'
import { FolderTerminal } from './FolderTerminal'
import { TerminalLock } from './TerminalLock'
import { matchesSearch, SearchBox } from './SearchBox'

// The server, as the office uses it (opened from the navbar's CPU / RAM, or the phone menu): how loaded it is, what
// runs on it (the agents' sessions, the folder terminals, the programs listening on a port: stoppable), and the
// command-line tools the agents' user has with their logins (server-wide, plus which agents carry a token of their own).

type Tab = 'overview' | 'running' | 'tools' | 'terminal'
export const SERVER_TABS: Tab[] = ['overview', 'running', 'tools', 'terminal']
/** the agents' user's home, as the server's shells name it (work/shells.ts HOME_SHELL) */
const HOME = '~'

interface ToolStatus {
  id: string
  name: string
  installed: boolean
  version?: string
  path?: string
  auth: 'ok' | 'none' | 'unknown' | 'na'
  account?: string
  note?: string
  install: string
  login?: string
  tokens: string[]
  agentTokens: { agentId: string; agent: string; name: string }[]
}
interface ToolsReport {
  tools: ToolStatus[]
  others: { name: string; path: string }[]
  checkedAt: number
}
interface RunningReport {
  sessions: { agentId: string; agent: string; session: string; status: string; alive: boolean; compacting: boolean }[]
  terminals: { name: string; folder: string | null }[]
  services: { port: number; pid: number; command: string; args: string; cwd: string | null; upSec: number | null; inOffice: boolean }[]
  disk: { totalGb: number; freeGb: number; path: string } | null
  checkedAt: number
}

const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')
const up = (s: number | null) => (s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`)
const fail = (e: unknown, what: string) => useDashboard.setState({ syncError: e instanceof Error ? e.message : what })

/** The lock ran out meanwhile (the server says "locked"): back to the code. */
class Locked extends Error {}

async function getJson<T>(path: string): Promise<T> {
  const r = await api(path)
  const d = r.ok ? null : await r.json().catch(() => null)
  if (r.status === 403 && d?.locked) throw new Locked(d.error)
  if (!r.ok) throw new Error(d?.error ?? `Could not load (${r.status})`)
  return r.json()
}

export function ServerModal({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const max = useModalMaximize(860)
  return (
    <Modal open onClose={onClose} title="Server" description="What runs on it for the office, and the tools the agents have" {...max.modalProps} className={`server-modal${max.modalProps.className ? ` ${max.modalProps.className}` : ''}`}>
      <div className="modal__body server-modal__body" ref={max.bodyRef}>
        {/* it can stop processes and open a shell: the terminals' lock (the authenticator code, then a while on this
            device without it) */}
        <TerminalLock title="Server locked" action="Unlock" hint="What runs on the server, its tools and its terminal.">
          {(onRefused) => <ServerPanel tab={tab} onLocked={onRefused} />}
        </TerminalLock>
      </div>
    </Modal>
  )
}

/** What's inside, once unlocked. `onLocked`: the lock ran out meanwhile (back to the code). */
function ServerPanel({ tab, onLocked }: { tab: Tab; onLocked: () => void }) {
  const [running, setRunning] = useState<RunningReport | null>(null)
  const [tools, setTools] = useState<ToolsReport | null>(null)
  const [loading, setLoading] = useState<'running' | 'tools' | null>(null)
  const loadRunning = useCallback(async () => {
    setLoading('running')
    try {
      setRunning(await getJson<RunningReport>('/api/system/running'))
    } catch (e) {
      if (e instanceof Locked) return onLocked()
      fail(e, 'Could not load what is running')
    } finally {
      setLoading(null)
    }
  }, [onLocked])
  const loadTools = useCallback(async (fresh = false) => {
    setLoading('tools')
    try {
      setTools(await getJson<ToolsReport>(`/api/system/tools${fresh ? '?fresh=1' : ''}`))
    } catch (e) {
      if (e instanceof Locked) return onLocked()
      fail(e, 'Could not check the tools')
    } finally {
      setLoading(null)
    }
  }, [onLocked])
  // what's running: on opening and every 10 s while it's on screen; the tools when their tab opens (a slow check)
  useEffect(() => {
    if (tab === 'tools') return void (tools || loadTools())
    // its own terminal: nothing to load
    if (tab === 'terminal') return
    void loadRunning()
    const t = setInterval(() => void loadRunning(), 10_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
  const pick = (t: Tab) => setUrl({ server: t })
  return (
    <>
        <div className="seg server-modal__tabs" role="tablist">
          {SERVER_TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => pick(t)}>
              {t === 'overview' ? 'Overview' : t === 'running' ? 'Running' : t === 'tools' ? 'Tools' : 'Terminal'}
            </button>
          ))}
          <span className="grow" />
          {tab !== 'terminal' && (
          <button
            className="icon-btn small ghost"
            onClick={() => void (tab === 'tools' ? loadTools(true) : loadRunning())}
            disabled={!!loading}
            data-tip={tab === 'tools' ? 'Check every tool again (logins too)' : 'Refresh'}
            aria-label="Refresh"
          >
            {loading ? <LuLoader className="spin" /> : <LuRefreshCw />}
          </button>
          )}
        </div>
        {tab === 'overview' && <Overview running={running} />}
        {tab === 'running' && (running ? <Running r={running} onChanged={() => void loadRunning()} /> : <Loading />)}
        {tab === 'tools' && (tools ? <Tools r={tools} /> : <Loading what="Checking each tool and its login… (up to a minute)" />)}
        {/* a shell in the agents' user's home (logins, tools, anything outside a project), with the same code as every
            terminal; it keeps running when the window closes, until it's ended */}
        {tab === 'terminal' && (
          <div className="server-terminal">
            <FolderTerminal root={HOME} where="the agents’ home (~)" />
          </div>
        )}
    </>
  )
}

const Loading = ({ what = 'Loading…' }: { what?: string }) => (
  <div className="empty server-modal__loading">
    <LuLoader className="spin" /> {what}
  </div>
)

function Overview({ running }: { running: RunningReport | null }) {
  const metrics = useDashboard((s) => s.metrics)
  const measured = metrics.memTotalGb > 0
  const memPct = metrics.memTotalGb ? (metrics.memUsedGb / metrics.memTotalGb) * 100 : 0
  const disk = running?.disk
  const diskPct = disk ? ((disk.totalGb - disk.freeGb) / disk.totalGb) * 100 : 0
  const online = running?.sessions.filter((s) => s.alive).length ?? 0
  const services = running?.services.filter((s) => s.inOffice).length ?? 0
  return (
    <div className="server-overview">
      {/* the first reading comes a few seconds after the page opens: "–" until then, not 0 */}
      <Stat label="CPU" value={measured ? `${metrics.cpu.toFixed(0)}%` : '–'} pct={measured ? metrics.cpu : 0} />
      <Stat label="Memory" value={measured ? `${metrics.memUsedGb.toFixed(1)} / ${metrics.memTotalGb} GB` : '–'} pct={memPct} />
      <Stat label="Disk" value={disk ? `${(disk.totalGb - disk.freeGb).toFixed(1)} / ${disk.totalGb} GB` : '–'} pct={diskPct} hint={disk ? tilde(disk.path) : undefined} />
      <div className="server-stat server-stat--row">
        <button className="server-stat__link" onClick={() => setUrl({ server: 'running' })}>
          <b>{online}</b> sessions up · <b>{running?.terminals.length ?? 0}</b> terminals · <b>{services}</b> services on a port
        </button>
      </div>
    </div>
  )
}

function Stat({ label, value, pct, hint }: { label: string; value: string; pct: number; hint?: string }) {
  const level = pct > 85 ? 'hot' : pct > 65 ? 'warm' : 'ok'
  return (
    <div className="server-stat" data-tip={hint}>
      <span className="server-stat__label muted">{label}</span>
      <span className="server-stat__value">{value}</span>
      <span className={`meter meter--${level}`}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
    </div>
  )
}

function Running({ r, onChanged }: { r: RunningReport; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  // a search through all of it: agent, session, status, folder, port, command
  const [q, setQ] = useState('')
  // the sessions, the terminals, the services: one tab each
  const [view, setView] = useState<'sessions' | 'terminals' | 'services'>('sessions')
  const stopService = async (s: RunningReport['services'][number]) => {
    if (!(await confirm({ title: `Stop what runs on port ${s.port}?`, message: <>“{s.args.slice(0, 120)}” is stopped. If an agent started it for its work, that work loses it (it can start it again).</>, confirmLabel: 'Stop it' }))) return
    setBusy(`svc:${s.port}`)
    try {
      const res = await api(`/api/system/services/${s.port}/stop`, { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error ?? `Could not stop it (${res.status})`)
      if (d && d.stopped === false) throw new Error(`Port ${s.port} is still in use`)
      onChanged()
    } catch (e) {
      fail(e, 'Could not stop it')
    } finally {
      setBusy(null)
    }
  }
  const endTerm = async (t: RunningReport['terminals'][number]) => {
    if (!(await confirm({ title: 'End this terminal?', message: 'The shell stops, with anything still running in it (a dev server started here, for example).', confirmLabel: 'End terminal' }))) return
    setBusy(`term:${t.name}`)
    try {
      const res = await api(`/api/system/terminals/${t.name}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Could not end it (${res.status})`)
      onChanged()
    } catch (e) {
      fail(e, 'Could not end it')
    } finally {
      setBusy(null)
    }
  }
  const sessions = r.sessions.filter((s) => matchesSearch(q, s.agent, s.session, s.alive ? s.status : 'not running', s.compacting ? 'compacting' : ''))
  const terminals = r.terminals.filter((t) => matchesSearch(q, t.folder, t.name))
  const svc = r.services.filter((s) => matchesSearch(q, String(s.port), `:${s.port}`, s.command, s.args, s.cwd))
  const office = svc.filter((s) => s.inOffice)
  const others = svc.filter((s) => !s.inOffice)
  const service = (s: RunningReport['services'][number]) => (
    <li key={s.port} className="server-row">
      <span className="server-row__port">:{s.port}</span>
      <span className="server-row__main">
        <span className="server-row__title truncate" data-tip={s.args}>
          {s.command}
        </span>
        <span className="server-row__sub muted truncate">
          {s.cwd ? tilde(s.cwd) : 'folder unknown'}
          {s.upSec != null && ` · up ${up(s.upSec)}`}
        </span>
      </span>
      <a className="icon-btn small ghost" href={`http://${location.hostname}:${s.port}`} target="_blank" rel="noreferrer" data-tip="Open (when the port is reachable from here)" aria-label="Open">
        <LuExternalLink />
      </a>
      <button className="small ghost danger-text" onClick={() => void stopService(s)} disabled={!!busy}>
        {busy === `svc:${s.port}` ? <LuLoader className="spin" /> : <LuSquare />} Stop
      </button>
    </li>
  )
  return (
    <div className="server-running">
      <SearchBox value={q} onChange={setQ} placeholder="Search agents, folders, ports or commands" className="server-tools__search" />
      {/* the counts follow the search, so a match on another tab shows */}
      <div className="seg server-tools__tabs" role="tablist" aria-label="What runs">
        {(
          [
            ['sessions', 'Agents’ sessions', sessions.length],
            ['terminals', 'Terminals', terminals.length],
            ['services', 'Services', office.length + (q ? others.length : 0)],
          ] as const
        ).map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
            {label} <span className="server-tools__count">{n}</span>
          </button>
        ))}
      </div>
      {view === 'sessions' && (
      <section>
        <ul className="server-list">
          {sessions.map((s) => (
            <li key={`${s.agentId}:${s.session}`} className="server-row">
              <span className={`server-dot server-dot--${s.alive ? (s.status === 'working' ? 'working' : 'up') : 'down'}`} />
              <span className="server-row__main">
                <span className="server-row__title truncate">
                  {s.agent} <span className="muted">· {s.session}</span>
                </span>
                <span className="server-row__sub muted">{s.alive ? (s.compacting ? 'compacting' : s.status) : 'not running'}</span>
              </span>
              <button className="small ghost" onClick={() => openUrl({ agent: s.agentId, tab: 'chat' })}>
                Open
              </button>
            </li>
          ))}
          {!sessions.length && <li className="empty">{q ? 'No session matches.' : 'No agents yet.'}</li>}
        </ul>
      </section>
      )}
      {view === 'terminals' && (
      <section>
        <ul className="server-list">
          {terminals.map((t) => (
            <li key={t.name} className="server-row">
              <LuSquareTerminal className="server-row__icon" />
              <span className="server-row__main">
                <span className="server-row__title truncate">{t.folder === HOME ? 'Home' : t.folder ? t.folder.split('/').pop() : t.name}</span>
                <span className="server-row__sub muted truncate">{t.folder === HOME ? "the agents' home (~)" : t.folder ? tilde(t.folder) : 'a folder the office no longer lists'}</span>
              </span>
              {t.folder && (
                <button className="small ghost" onClick={() => (t.folder === HOME ? setUrl({ server: 'terminal' }) : openUrl({ folder: t.folder!, fsec: 'terminal' }))}>
                  Open
                </button>
              )}
              <button className="small ghost danger-text" onClick={() => void endTerm(t)} disabled={!!busy}>
                {busy === `term:${t.name}` ? <LuLoader className="spin" /> : <LuX />} End
              </button>
            </li>
          ))}
          {!terminals.length && <li className="empty">{q ? 'No terminal matches.' : 'No terminal is open.'}</li>}
        </ul>
      </section>
      )}
      {view === 'services' && (
      <section>
        <ul className="server-list">
          {office.map(service)}
          {!office.length && <li className="empty">{q ? 'No service matches.' : 'Nothing from the office’s folders listens on a port.'}</li>}
        </ul>
        {others.length > 0 && (
          <>
            <button className="small ghost server-more" onClick={() => setShowOthers((v) => !v)}>
              {showOthers ? <LuMinus /> : '+'} {others.length} more of the same user, outside the office’s folders
            </button>
            {/* a search shows the matches there too, without opening them first */}
            {(showOthers || q) && <ul className="server-list">{others.map(service)}</ul>}
          </>
        )}
      </section>
      )}
    </div>
  )
}

function Tools({ r }: { r: ToolsReport }) {
  const agents = useOffice((s) => s.agents)
  const [copied, setCopied] = useState<string | null>(null)
  const [tokenMenu, setTokenMenu] = useState<{ x: number; y: number; above: number; tool: ToolStatus } | null>(null)
  // a search through the tools: name, version, account, the tokens that sign one in, the agents that carry one
  const [q, setQ] = useState('')
  // the installed ones, the missing ones (with how to install), the other programs: one tab each
  const [view, setView] = useState<'installed' | 'missing' | 'others'>('installed')
  const found = (t: ToolStatus) => matchesSearch(q, t.name, t.id, t.version, t.account, t.tokens.join(' '), t.agentTokens.map((a) => a.agent).join(' '))
  /** true: on the clipboard; else the command is shown to copy by hand */
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1800)
      return true
    } catch {
      fail(new Error(`Copy this by hand: ${text}`), '')
      return false
    }
  }
  // sign in in a terminal: the command copied (or shown), this window's Terminal (the agents' home): paste it there
  const loginInTerminal = async (t: ToolStatus) => {
    if (!t.login) return
    await copy(t.login)
    setUrl({ server: 'terminal' })
  }
  const installed = r.tools.filter((t) => t.installed && found(t))
  const missing = r.tools.filter((t) => !t.installed && found(t))
  const others = r.others.filter((o) => matchesSearch(q, o.name, o.path))
  const row = (t: ToolStatus) => (
    <li key={t.id} className={`tool-row${t.installed ? '' : ' tool-row--missing'}`}>
      <span className="tool-row__main">
        <span className="tool-row__name">
          {t.name}
          {t.installed && t.version && <span className="muted tool-row__ver">{t.version}</span>}
        </span>
        {t.installed ? (
          <span className="tool-row__auth">
            {t.auth === 'ok' && (
              <span className="tool-auth tool-auth--ok">
                <LuCheck /> Signed in{t.account ? ` as ${t.account}` : ''}
              </span>
            )}
            {t.auth === 'none' && (
              <span className="tool-auth tool-auth--none" data-tip={t.note}>
                <LuCircleAlert /> Not signed in
              </span>
            )}
            {t.auth === 'unknown' && <span className="tool-auth muted" data-tip={t.note}>Login can’t be checked{t.note ? `: ${t.note}` : ''}</span>}
            {t.agentTokens.length > 0 && (
              <span className="tool-tokens" data-tip="Agents with a token of their own in their Secrets: they're signed in whatever the server's login is">
                <LuKeyRound /> {t.agentTokens.map((a) => `${a.agent} (${a.name})`).join(', ')}
              </span>
            )}
          </span>
        ) : (
          <span className="tool-row__install">
            <code>{t.install}</code>
            <button className="icon-btn small ghost" onClick={() => void copy(t.install)} data-tip="Copy the install command (run it in a terminal)" aria-label="Copy">
              {copied === t.install ? <LuCheck /> : <LuCopy />}
            </button>
          </span>
        )}
      </span>
      {t.installed && (t.login || t.tokens.length > 0) && (
        <span className="tool-row__actions">
          {t.login && (
            <button className="small" onClick={() => void loginInTerminal(t)} data-tip={`Copies “${t.login}” and opens a terminal: paste it there`}>
              {copied === t.login ? <LuCheck /> : <LuSquareTerminal />} {t.auth === 'ok' ? 'Log in again' : 'Log in'}
            </button>
          )}
          {t.tokens.length > 0 && (
            <button
              className="small ghost"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect()
                setTokenMenu({ x: box.right, y: box.bottom + 4, above: box.top - 4, tool: t })
              }}
              data-tip={`Recommended: a token (${t.tokens[0]}) in an agent's Secrets, no login needed`}
            >
              <LuKeyRound /> Token
            </button>
          )}
        </span>
      )}
    </li>
  )
  return (
    <div className="server-tools">
      <p className="muted server-tools__hint">
        Logins here are the server’s (the agents’ user): every agent uses them. A token in an agent’s Secrets signs in just that agent, without a login. Checked{' '}
        {new Date(r.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
      </p>
      <SearchBox value={q} onChange={setQ} placeholder="Search tools, accounts, tokens or agents" className="server-tools__search" />
      {/* the counts follow the search, so a match on another tab shows */}
      <div className="seg server-tools__tabs" role="tablist" aria-label="Installed or not">
        {(
          [
            ['installed', 'Installed', installed.length],
            ['missing', 'Not installed', missing.length],
            ['others', 'Other programs', others.length],
          ] as const
        )
          .filter(([id, , n]) => id !== 'others' || n > 0 || r.others.length > 0)
          .map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
              {label} <span className="server-tools__count">{n}</span>
            </button>
          ))}
      </div>
      {view === 'installed' && (
        <>
          <ul className="server-list">{installed.map(row)}</ul>
          {!installed.length && <p className="empty">{q ? `No installed tool matches “${q}”.` : 'None of the tools is installed.'}</p>}
        </>
      )}
      {view === 'missing' && (
        <>
          <p className="muted server-tools__hint">Nothing is installed from here: copy the command and run it in a terminal (or ask an agent).</p>
          <ul className="server-list">{missing.map(row)}</ul>
          {!missing.length && <p className="empty">{q ? `No missing tool matches “${q}”.` : 'Every tool on the list is installed.'}</p>}
        </>
      )}
      {view === 'others' && (
        <>
          <p className="muted server-tools__hint">Other programs in the agents’ bin folders (installed by hand or by an agent).</p>
          <div className="tool-others">
            {others.map((o) => (
              <code key={o.name} data-tip={o.path}>
                {o.name}
              </code>
            ))}
          </div>
          {!others.length && <p className="empty">{q ? `No program matches “${q}”.` : 'Nothing else there.'}</p>}
        </>
      )}
      {tokenMenu && (
        <ActionMenu
          x={tokenMenu.x}
          y={tokenMenu.y}
          above={tokenMenu.above}
          title={`Add ${tokenMenu.tool.tokens[0]} to an agent's Secrets`}
          onClose={() => setTokenMenu(null)}
          actions={agents.map((a) => ({ icon: <LuKeyRound />, label: a.name, run: () => openUrl({ agent: a.id, tab: 'overview', secret: tokenMenu.tool.tokens[0] }) }))}
        />
      )}
    </div>
  )
}
