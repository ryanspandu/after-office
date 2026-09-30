import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { LuEye, LuPencil, LuTriangleAlert, LuPlug, LuRefreshCw, LuSearch, LuX } from 'react-icons/lu'
import { create } from 'zustand'
import type { Connector, ConnectorTool } from '@after-office/shared'
import { api } from '../../state/auth'
import { useOffice, type OfficeAgent } from '../../state/store'

// Which of the Claude account's connectors (Gmail, Google Drive, …) this agent may use. New agents get none. The
// list comes from the server (`claude mcp list` with the account's config folder); logging in to a connector is done
// at claude.ai (or `claude mcp add`), not here.

type Tools = Record<string, ConnectorTool[]>
export const useConnectors = create<{
  list: Connector[] | null
  checkedAt: number
  loading: boolean
  error: string
  load: (fresh?: boolean) => Promise<void>
  /** each connector's tools (by prefix); null until asked for (the Read / Write popups) */
  tools: Tools | null
  toolsLoading: boolean
  loadTools: (fresh?: boolean) => Promise<void>
}>(
  (set, get) => ({
    tools: null,
    toolsLoading: false,
    loadTools: async (fresh = false) => {
      if (get().toolsLoading) return
      set({ toolsLoading: true })
      try {
        const r = await api(`/api/connectors/tools${fresh ? '?fresh=1' : ''}`)
        if (r.ok) set({ tools: ((await r.json()) as { tools: Tools }).tools })
        else set({ tools: get().tools ?? {} })
      } catch {
        set({ tools: get().tools ?? {} })
      } finally {
        set({ toolsLoading: false })
      }
    },
    list: null,
    checkedAt: 0,
    loading: false,
    error: '',
    load: async (fresh = false) => {
      if (get().loading) return
      set({ loading: true, error: '' })
      try {
        const r = await api(`/api/connectors${fresh ? '?fresh=1' : ''}`)
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Could not list connectors (${r.status})`)
        const d = (await r.json()) as { list: Connector[]; checkedAt: number }
        set({ list: d.list, checkedAt: d.checkedAt })
      } catch (e) {
        set({ error: (e as Error).message, list: get().list ?? [] })
      } finally {
        set({ loading: false })
      }
    },
  }),
)

const STATUS: Record<Connector['status'], { label: string; tip: string }> = {
  connected: { label: 'Connected', tip: 'Ready to use' },
  'needs-auth': { label: 'Needs login', tip: 'Log in at claude.ai (Settings → Connectors) or with `claude mcp` first' },
  failed: { label: 'Failed', tip: "Claude Code couldn't reach it" },
  'not-configured': { label: 'Not set up', tip: 'Part of a plugin, but not set up on this account' },
  unknown: { label: 'Unknown', tip: '' },
}

const shortName = (c: Connector) => c.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '')

export function ConnectorsTab({ agent }: { agent: OfficeAgent }) {
  const { list, loading, error, load, checkedAt } = useConnectors()
  const [q, setQ] = useState('')
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    if (!list) void load()
  }, [list, load])

  const allowed = agent.connectors ?? null // null: every connector (an agent from before)
  const on = (c: Connector) => allowed === null || allowed.includes(c.prefix)
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (list ?? []).filter((c) => !needle || `${c.name} ${c.host ?? ''}`.toLowerCase().includes(needle))
  }, [list, q])

  // may also write (send, create, edit, delete…): off by default, such tools then wait for the owner's approval
  const writes = agent.connectorsWrite ?? []
  const canWrite = (c: Connector) => writes.includes(c.prefix)
  // reading asks first (Read off): rare, reading is on by default
  const readAsks = agent.connectorsReadAsk ?? []
  const canRead = (c: Connector) => !readAsks.includes(c.prefix)

  // saved right away; the session picks it up when it restarts (automatically, once it's idle)
  const save = async (next: string[], nextWrite: string[] = writes.filter((p) => next.includes(p)), nextReadAsk: string[] = readAsks.filter((p) => next.includes(p))) => {
    setSaveError('')
    const before = { connectors: agent.connectors, connectorsWrite: agent.connectorsWrite, connectorsReadAsk: agent.connectorsReadAsk }
    useOffice.setState((s) => ({
      agents: s.agents.map((a) => (a.id === agent.id ? { ...a, connectors: next, connectorsWrite: nextWrite, connectorsReadAsk: nextReadAsk } : a)),
    }))
    const r = await api(`/api/agents/${agent.id}/connectors`, { method: 'PUT', body: JSON.stringify({ allowed: next, write: nextWrite, readAsk: nextReadAsk }) }).catch(() => null)
    if (!r?.ok) {
      useOffice.setState((s) => ({ agents: s.agents.map((a) => (a.id === agent.id ? { ...a, ...before } : a)) }))
      setSaveError((await r?.json().catch(() => null))?.error ?? 'Could not save')
    }
  }
  const current = () => (allowed === null ? (list ?? []).map((c) => c.prefix) : allowed)
  const toggle = (c: Connector) => {
    const cur = current()
    void save(on(c) ? cur.filter((p) => p !== c.prefix) : [...cur, c.prefix])
  }

  const setWrite = (c: Connector, yes: boolean) => void save(current(), yes ? [...writes.filter((p) => p !== c.prefix), c.prefix] : writes.filter((p) => p !== c.prefix))
  const setRead = (c: Connector, yes: boolean) => void save(current(), writes, yes ? readAsks.filter((p) => p !== c.prefix) : [...readAsks.filter((p) => p !== c.prefix), c.prefix])

  const count = allowed === null ? (list?.length ?? 0) : allowed.length
  // an agent in Auto that may write with a connector: nothing asks before it sends or changes something
  const autoWriters = agent.permissionMode === 'auto' ? (list ?? []).filter((c) => on(c) && canWrite(c)).map(shortName) : []
  return (
    <div className="connectors">
      {allowed === null && (
        <div className="connectors__legacy">
          {agent.name} can use every connector: it was set up before connectors were managed. Turn off the ones it doesn't need, or{' '}
          <button className="link link--inline" onClick={() => void save([])}>
            turn them all off
          </button>
          .
        </div>
      )}
      {autoWriters.length > 0 && (
        <div className="connectors__warn" role="note">
          <LuTriangleAlert />
          <span>
            {agent.name} runs in <b>Auto</b> and may write with {autoWriters.join(', ')}: it can send or change things there without asking. If what it reads
            (web pages, emails) could steer it, turn Write off or switch it to <b>Ask before actions</b> in Overview.
          </span>
        </div>
      )}
      <div className="connectors__bar">
        <label className="search-box grow">
          <LuSearch />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search connectors" aria-label="Search connectors" />
          {q && (
            <button className="icon-btn small ghost" onClick={() => setQ('')} aria-label="Clear search">
              <LuX />
            </button>
          )}
        </label>
        <span className="muted connectors__count">
          {count} of {list?.length ?? 0} on
        </span>
        <button className="small" onClick={() => void save([])} disabled={!list || (allowed !== null && !allowed.length)}>
          All off
        </button>
        <button className="small" onClick={() => void save((list ?? []).map((c) => c.prefix))} disabled={!list?.length}>
          All on
        </button>
        <button className="icon-btn small" onClick={() => {
            void load(true)
            // their tools too (the server checks once for both)
            if (useConnectors.getState().tools) void useConnectors.getState().loadTools(true)
          }} disabled={loading} data-tip="Check the account's connectors again" aria-label="Refresh connectors">
          <LuRefreshCw className={loading ? 'spin' : ''} />
        </button>
      </div>
      {(error || saveError) && <div className="row__error">{saveError || error}</div>}
      {!list ? (
        <div className="empty">Checking the account's connectors… (this takes a few seconds)</div>
      ) : !list.length ? (
        <div className="empty">No connectors on this Claude account. Add them at claude.ai → Settings → Connectors.</div>
      ) : (
        <ul className="connectors__list">
          {shown.map((c) => (
            <li key={c.prefix} className={`connector${on(c) ? ' is-on' : ''}`}>
              <label className="toggle" data-tip={on(c) ? 'Turn off for this agent' : 'Turn on for this agent'}>
                <input type="checkbox" role="switch" checked={on(c)} onChange={() => toggle(c)} aria-label={`${shortName(c)} for ${agent.name}`} />
                <span />
              </label>
              <span className="connector__icon">
                <LuPlug />
              </span>
              <span className="connector__body">
                <span className="connector__name truncate">{shortName(c)}</span>
                <span className="connector__meta muted truncate">
                  {c.source === 'claude.ai' ? 'claude.ai' : c.source === 'plugin' ? `plugin ${c.plugin ?? ''}` : 'added by hand'}
                  {c.host ? ` · ${c.host}` : ''}
                </span>
              </span>
              {on(c) && (
                <span className="connector__access">
                  {canWrite(c) && (
                    <span
                      className="connector__warn-icon"
                      tabIndex={0}
                      aria-label="Write is on"
                      data-tip={`Write is on: ${agent.name} can send, create, edit or delete in ${shortName(c)} without asking${agent.permissionMode === 'auto' ? ', and it runs in Auto' : ''}.`}
                    >
                      <LuTriangleAlert />
                    </span>
                  )}
                  <PermissionsButton
                    connector={c}
                    agentName={agent.name}
                    read={canRead(c)}
                    write={canWrite(c)}
                    onRead={(yes) => setRead(c, yes)}
                    onWrite={(yes) => setWrite(c, yes)}
                  />
                </span>
              )}
              <span className={`connector__status connector__status--${c.status}`} data-tip={c.detail ?? STATUS[c.status].tip}>
                {STATUS[c.status].label}
              </span>
            </li>
          ))}
          {!shown.length && <li className="empty">No connectors match.</li>}
        </ul>
      )}
      <p className="field__hint">
        New agents start with none. A connector turned on may read (Read) but not write (Write): its tools that send, create, edit or
        delete wait for your approval in Needs your attention, even in Auto. Click its permissions to see its tools and change them (applies at once). Changes apply when {agent.name}'s session restarts: that happens on its own once it's idle, and the conversation
        continues. Logging in to a connector is done at claude.ai.
        {checkedAt ? ` Checked ${new Date(checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` : ''}
      </p>
    </div>
  )
}

const ACCESS = {
  read: { label: 'Read', icon: <LuEye />, what: 'Search, open and list things.' },
  write: { label: 'Write', icon: <LuPencil />, what: 'Send, create, edit, share or delete things.' },
} as const

const toolLabel = (name: string) => name.replace(/[_-]+/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase())

/** "N permissions" for one connector: opens Read and Write, each with its switch and the tools it covers. */
function PermissionsButton({ connector, agentName, read, write, onRead, onWrite }: { connector: Connector; agentName: string; read: boolean; write: boolean; onRead: (yes: boolean) => void; onWrite: (yes: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const { tools, toolsLoading, loadTools } = useConnectors()
  useEffect(() => {
    if (open && !tools) void loadTools()
  }, [open, tools, loadTools])
  // floats over the page (a portal), placed by floating-ui: never cut off by the modal
  useLayoutEffect(() => {
    const ref = btn.current
    const el = pop.current
    if (!open || !ref || !el) return
    return autoUpdate(ref, el, () =>
      void computePosition(ref, el, {
        placement: 'bottom-end',
        strategy: 'fixed',
        middleware: [
          offset(6),
          // below the button, or above it when there's more room there; never past the window (it scrolls inside)
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          size({ padding: 8, apply: ({ availableHeight }) => void (el.style.maxHeight = `${Math.max(160, Math.min(520, availableHeight))}px`) }),
        ],
      }).then(({ x, y }) => {
        el.style.left = `${x}px`
        el.style.top = `${y}px`
      }),
    )
  }, [open])
  // closes on a click elsewhere, or Esc
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !btn.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const n = Number(read) + Number(write)
  const all = tools?.[connector.prefix] ?? null
  const section = (kind: 'read' | 'write', allowed: boolean, onChange: (yes: boolean) => void) => {
    const a = ACCESS[kind]
    const list = all?.filter((t) => t.readOnly === (kind === 'read')) ?? null
    return (
      <section className={`perm-sec${allowed ? ' is-on' : ''}`}>
        <div className="perm-sec__head">
          <span className="perm-sec__title">
            {a.icon} {a.label}
            {kind === 'write' && allowed && <LuTriangleAlert className="perm-sec__warn" aria-label="Write is on" />}
          </span>
          <label className="toggle">
            <input type="checkbox" role="switch" checked={allowed} onChange={(e) => onChange(e.target.checked)} aria-label={`${a.label} without asking, for ${agentName}`} />
            <span />
          </label>
        </div>
        <p className="perm-sec__desc">
          {a.what}{' '}
          <b>
            {allowed
              ? kind === 'write'
                ? 'Runs without asking, also in Auto.'
                : 'Runs without asking.'
              : 'Each one waits for your approval in Needs your attention.'}
          </b>
        </p>
        {list === null ? (
          <p className="muted perm-sec__empty">
            {toolsLoading ? 'Checking its tools… (about half a minute)' : tools && connector.status !== 'connected' ? 'Its tools show once it’s connected.' : tools ? 'Its tools couldn’t be read right now.' : ''}
          </p>
        ) : !list.length ? (
          <p className="muted perm-sec__empty">No {a.label.toLowerCase()} tools.</p>
        ) : (
          <ul className="perm-sec__list">
            {list.map((t) => (
              <li key={t.name} className={allowed ? '' : 'is-ask'}>
                <span className="truncate">{toolLabel(t.name)}</span>
                {t.destructive && <span className="perm-pop__tag">can delete</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }
  return (
    <>
      <button ref={btn} type="button" className={`connector__perm${n ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        {n} permission{n === 1 ? '' : 's'}
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="perm-pop" role="dialog" aria-label={`Permissions: ${shortName(connector)}`}>
            <div className="perm-pop__title">
              <LuPlug /> {shortName(connector)} · {agentName}
            </div>
            {section('read', read, onRead)}
            {section('write', write, onWrite)}
          </div>,
          document.body,
        )}
    </>
  )
}
