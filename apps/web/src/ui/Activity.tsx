import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LuCircleAlert, LuCircleCheck, LuCircleX, LuCrown, LuDownload, LuEye, LuHourglass, LuInfo, LuLoader, LuPencil, LuShieldAlert } from 'react-icons/lu'
import type { ActivityEntry, ActivityOrigin } from '@after-office/shared'
import { api } from '../state/auth'
import { useActivityLive } from '../state/activity'
import { useOffice } from '../state/store'
import { useNow } from '../state/clock'
import { setUrl } from '../state/url'
import { ago } from './FollowUps'
import { Modal } from './Modal'
import { Select } from './Select'
import { SearchBox } from './SearchBox'

// The Activity log (server: work/activity.ts): what agents did with connectors, who let it run, and why they were
// doing it. In an agent's profile (its own), in the left sidebar (everyone's, latest), and in full (?activity=1) with
// filters and a CSV export.

export interface ActivityFilters {
  agentId?: string
  connector?: string
  access?: 'read' | 'write'
  problems?: boolean
  /** only the last N days */
  days?: number
  /** words anywhere in an entry */
  q?: string
}

const query = (f: ActivityFilters) => {
  const q = new URLSearchParams()
  if (f.agentId) q.set('agent', f.agentId)
  if (f.connector) q.set('connector', f.connector)
  if (f.access) q.set('access', f.access)
  if (f.problems) q.set('problems', '1')
  if (f.days) q.set('from', String(Date.now() - f.days * 86_400_000))
  if (f.q?.trim()) q.set('q', f.q.trim())
  return q
}
const matches = (e: ActivityEntry, f: ActivityFilters) =>
  (!f.agentId || e.agentId === f.agentId) &&
  (!f.connector || e.connector === f.connector) &&
  (!f.access || e.access === f.access) &&
  (!f.problems || e.status === 'error' || e.status === 'denied') &&
  (!f.days || e.at >= Date.now() - f.days * 86_400_000) &&
  (!f.q?.trim() || f.q.trim().toLowerCase().split(/\s+/).every((w) => JSON.stringify(e).toLowerCase().includes(w)))

/** A page of the log, newest first, kept current by the live stream. */
function useActivity(filters: ActivityFilters, limit = 50) {
  const key = JSON.stringify(filters)
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [connectors, setConnectors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const live = useActivityLive((s) => s.byId)

  const load = useCallback(
    async (before?: number) => {
      setLoading(true)
      setError('')
      try {
        const q = query(filters)
        q.set('limit', String(limit))
        if (before) q.set('before', String(before))
        const r = await api(`/api/activity?${q}`)
        if (!r.ok) throw new Error(`Could not load the activity (${r.status})`)
        const d = (await r.json()) as { entries: ActivityEntry[]; next: number | null; connectors: string[] }
        setEntries((cur) => (before && cur ? [...cur, ...d.entries] : d.entries))
        setNext(d.next)
        setConnectors(d.connectors)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the activity')
        setEntries((cur) => cur ?? [])
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, limit],
  )
  useEffect(() => {
    setEntries(null)
    void load()
  }, [load])

  // lay the live updates over the page: newer versions of listed entries, and new ones that match
  const shown = useMemo(() => {
    if (!entries) return null
    const byId = new Map(entries.map((e) => [e.id, e]))
    const oldest = entries.length ? entries[entries.length - 1].at : 0
    for (const e of Object.values(live)) if (matches(e, filters) && (byId.has(e.id) || e.at >= oldest || !next)) byId.set(e.id, e)
    return [...byId.values()].sort((a, b) => b.at - a.at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, live, key, next])

  return { entries: shown, next, connectors, loading, error, loadMore: () => next && load(next), reload: () => load() }
}

const STATUS: Record<ActivityEntry['status'], { label: string; icon: ReactNode; cls: string }> = {
  running: { label: 'Running', icon: <LuLoader className="spin" />, cls: '' },
  waiting: { label: 'Waiting for you', icon: <LuHourglass />, cls: 'is-waiting' },
  ok: { label: 'Done', icon: <LuCircleCheck />, cls: 'is-ok' },
  error: { label: 'Failed', icon: <LuCircleAlert />, cls: 'is-bad' },
  denied: { label: 'Denied', icon: <LuCircleX />, cls: 'is-bad' },
  info: { label: 'Note', icon: <LuShieldAlert />, cls: 'is-waiting' },
}

/** "Your chat (Chrome on macOS · 203.0.113.7)" */
function originStep(o: ActivityOrigin) {
  const where = [o.device, o.ip].filter(Boolean).join(' · ')
  const what =
    o.kind === 'owner'
      ? o.label
      : o.kind === 'task'
        ? `Task “${o.label}”`
        : o.kind === 'cron'
          ? `Daily job “${o.label}”`
          : o.kind === 'webhook'
            ? `Webhook run of “${o.label}”`
            : o.kind === 'manager'
              ? `${o.label} (manager${o.boss ? ', Boss mode' : ''})`
              : o.kind === 'report'
                ? o.label
                : o.label
  return where ? `${what} (${where})` : what
}
/** The whole chain, nearest first. */
export function originChain(o?: ActivityOrigin): string[] {
  const out: string[] = []
  for (let cur = o, i = 0; cur && i < 5; cur = cur.via, i++) out.push(originStep(cur))
  return out
}

function EntryRow({ e, showAgent, onOpen }: { e: ActivityEntry; showAgent: boolean; onOpen: () => void }) {
  const now = useNow(30_000).getTime()
  const st = STATUS[e.status]
  const chain = originChain(e.origin)
  return (
    <li className={`activity__row ${st.cls}${e.access === 'write' ? ' is-write' : ''}`}>
      <span className="activity__status" title={st.label}>
        {st.icon}
      </span>
      <span className="activity__body">
        <span className="activity__what truncate">
          {e.kind === 'system' ? (
            e.message
          ) : (
            <>
              <b>{e.connector}</b> · {e.tool}
              {e.access && <span className={`activity__access activity__access--${e.access}`}>{e.access === 'write' ? <LuPencil /> : <LuEye />}{e.access === 'write' ? 'Write' : 'Read'}</span>}
            </>
          )}
        </span>
        <span className="activity__meta muted truncate">
          {showAgent && <>{e.agentName} · </>}
          {ago(now - e.at)}
          {e.status !== 'ok' && e.status !== 'running' && e.kind !== 'system' ? ` · ${st.label}` : ''}
          {e.decision?.by === 'owner' ? (e.decision.allowed ? ' · approved by you' : '') : ''}
          {chain.length ? ` · ← ${chain[chain.length - 1]}` : ''}
          {e.origin?.boss || e.origin?.via?.boss ? (
            <>
              {' '}
              <LuCrown className="activity__boss" aria-label="Boss mode" />
            </>
          ) : null}
        </span>
      </span>
      <button className="icon-btn small ghost" aria-label="Details" onClick={onOpen}>
        <LuInfo />
      </button>
    </li>
  )
}

function Detail({ e, onClose }: { e: ActivityEntry; onClose: () => void }) {
  const st = STATUS[e.status]
  const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const rows: [string, ReactNode][] = [
    ['When', when(e.at)],
    ['Agent', e.agentName],
    ...(e.kind === 'tool'
      ? ([
          ['Connector', `${e.connector} · ${e.tool}`],
          ['Kind', e.access === 'write' ? 'Write (sends, creates, edits or deletes)' : 'Read'],
          ['Result', <span className={st.cls === 'is-bad' ? 'danger-text' : ''}>{st.label}{e.doneAt ? ` · ${when(e.doneAt)}` : ''}</span>],
          [
            'Allowed by',
            e.decision
              ? e.decision.by === 'owner'
                ? `You${e.decision.allowed ? '' : ' (denied)'}, ${when(e.decision.at)}${e.decision.device || e.decision.ip ? ` · ${[e.decision.device, e.decision.ip].filter(Boolean).join(' · ')}` : ''}`
                : `Automatic (${e.access === 'write' ? 'Write' : 'Read'} is on for this agent)`
              : e.status === 'waiting'
                ? 'Waiting for you under For you'
                : 'Not recorded',
          ],
        ] as [string, ReactNode][])
      : [['What happened', e.message ?? '']] as [string, ReactNode][]),
  ]
  const chain = originChain(e.origin)
  return (
    <Modal open onClose={onClose} title={e.kind === 'tool' ? `${e.connector} · ${e.tool}` : 'Activity'} width={560}>
      <div className="modal__body signin-detail activity-detail">
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          {chain.length > 0 && (
            <div>
              <dt>Why</dt>
              <dd>
                <ol className="activity-detail__chain">
                  {chain.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ol>
              </dd>
            </div>
          )}
          {e.input && e.input !== '{}' && (
            <div>
              <dt>Called with</dt>
              <dd>
                <code>{e.input}</code>
              </dd>
            </div>
          )}
          {e.result && (
            <div>
              <dt>Came back</dt>
              <dd>
                <code>{e.result}</code>
              </dd>
            </div>
          )}
          {!!e.readBefore?.length && (
            <div>
              <dt>Read before this</dt>
              <dd>
                <ul className="activity-detail__reads">
                  {e.readBefore.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                <span className="field__hint">What it read in the same turn: if the request came from none of your messages, look here.</span>
              </dd>
            </div>
          )}
        </dl>
        <footer className="modal__foot">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  )
}

/** A list of activity (an agent's, or everyone's). */
export function ActivityList({ filters, showAgent = true, limit = 50, empty }: { filters: ActivityFilters; showAgent?: boolean; limit?: number; empty?: string }) {
  const { entries, next, loading, error, loadMore } = useActivity(filters, limit)
  const [open, setOpen] = useState<ActivityEntry | null>(null)
  if (!entries) return <p className="muted activity__empty">Loading…</p>
  return (
    <>
      {error && <div className="row__error">{error}</div>}
      {!entries.length ? (
        <p className="muted activity__empty">{empty ?? 'Nothing yet. Connector calls (Gmail, Drive…) show up here as agents make them.'}</p>
      ) : (
        <ul className="activity">
          {entries.map((e) => (
            <EntryRow key={e.id} e={e} showAgent={showAgent} onOpen={() => setOpen(e)} />
          ))}
        </ul>
      )}
      {next && (
        <button className="small activity__more" onClick={() => void loadMore()} disabled={loading}>
          {loading ? 'Loading…' : 'Older'}
        </button>
      )}
      {open && <Detail e={entries.find((x) => x.id === open.id) ?? open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** An agent's own activity (its profile's Activity tab). */
export function AgentActivityTab({ agentId }: { agentId: string }) {
  return (
    <div className="activity-tab">
      <p className="field__hint">Every connector call this agent made, who let it run, and why it was working on it. Kept 90 days.</p>
      <ActivityList filters={{ agentId }} showAgent={false} empty="No connector calls yet. They show up here as this agent makes them." />
    </div>
  )
}

/** The left sidebar's Activity tab: the latest, everyone's, with the full log a click away. */
export function ActivitySidebar({ q = '' }: { q?: string }) {
  return (
    <div className="activity-side">
      <div className="activity-side__head">
        <span className="muted">Latest connector activity</span>
        <button className="small" onClick={() => setUrl({ activity: '1' }, 'push')}>
          View all
        </button>
      </div>
      <ActivityList filters={{ days: 7, q }} limit={30} empty={q.trim() ? 'Nothing matches in the last 7 days.' : undefined} />
    </div>
  )
}

const DAYS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
]

/** The whole log (?activity=1): filters and CSV. */
export function ActivityModal({ onClose }: { onClose: () => void }) {
  const agents = useOffice((s) => s.agents)
  const [f, setF] = useState<ActivityFilters>({ days: 7 })
  const { connectors } = useActivity({ days: 90 }, 1)
  const csv = `/api/activity/export.csv?${query(f)}`
  return (
    <Modal open onClose={onClose} title="Activity" description="What agents did with connectors, who let it run, and why. Kept 90 days." width={760}>
      <div className="modal__body activity-modal">
        <div className="activity-modal__filters">
          <Select ariaLabel="Agent" value={f.agentId ?? ''} options={[{ value: '', label: 'All agents' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={(v) => setF({ ...f, agentId: v || undefined })} />
          <Select ariaLabel="Connector" value={f.connector ?? ''} options={[{ value: '', label: 'All connectors' }, ...connectors.map((c) => ({ value: c, label: c }))]} onChange={(v) => setF({ ...f, connector: v || undefined })} />
          <Select
            ariaLabel="Kind"
            value={f.problems ? 'problems' : (f.access ?? '')}
            options={[
              { value: '', label: 'Read & write' },
              { value: 'write', label: 'Write only' },
              { value: 'read', label: 'Read only' },
              { value: 'problems', label: 'Failed or denied' },
            ]}
            onChange={(v) => setF({ ...f, access: v === 'read' || v === 'write' ? v : undefined, problems: v === 'problems' })}
          />
          <Select ariaLabel="Period" value={String(f.days ?? 90)} options={DAYS} onChange={(v) => setF({ ...f, days: Number(v) })} />
          <SearchBox value={f.q ?? ''} onChange={(v) => setF({ ...f, q: v })} placeholder="Search activity" className="activity-modal__search" />
          <a className="activity-modal__csv" href={csv} download>
            <LuDownload /> CSV
          </a>
        </div>
        <ActivityList filters={f} />
      </div>
    </Modal>
  )
}
