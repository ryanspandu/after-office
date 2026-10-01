import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LuFileText, LuLoader, LuMessageSquare, LuPlug, LuPlus, LuRotateCw, LuSettings2, LuSparkles, LuSquareTerminal, LuTrash2, LuX, LuCopy, LuInfo, LuShuffle, LuActivity, LuFolder } from 'react-icons/lu'
import { FileBrowser } from './FileBrowser'
import type { AgentEffort, AgentSkill, LiveMode, AccountSkill } from '@after-office/shared'
import { EFFORT_OPTIONS } from './effort'
import { api } from '../state/auth'
import { liveApi } from '../state/live'
import { useOffice, type OfficeAgent, avatarStyle, makeLook } from '../state/store'
import { ChatTab, MODEL_OPTIONS, modelAlias } from './agent/ChatTab'
import { TerminalTab } from './agent/TerminalTab'
import { MODE_LABEL } from './AgentsPanel'
import { FolderPicker } from './FolderPicker'
import { Field } from './Modal'
import { confirm } from './Confirm'
import { Select } from './Select'
import { create } from 'zustand'
import { Markdown } from './FollowUps'
import { MaximizeButton, useMaximize } from './Maximize'
import { useSheetDrag } from '../state/useSheetDrag'
import { FigurePicker } from './FigurePicker'
import { ConnectorsTab } from './agent/ConnectorsTab'
import { AgentActivityTab } from './Activity'
import { GitSection } from './agent/GitSection'
import { getParam, setUrl, useUrl } from '../state/url'
import { tip } from './Tooltip'
import { RulesPicker } from './RulesPicker'

// Agent drawer. Live: Chat + Terminal with the real Claude Code session, plus Overview / CLAUDE.md / Skills read from
// and saved to the agent's folder on the server. Demo: the profile tabs edit local state only.

type Tab = 'chat' | 'terminal' | 'folder' | 'overview' | 'claude' | 'skills' | 'connectors' | 'activity'

/** Editable profile: name/role plus the agent folder's CLAUDE.md and skills. */
interface Doc {
  name: string
  role: string
  claudeMd: string
  skills: AgentSkill[]
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export function AgentProfileDrawer() {
  const profileId = useOffice((s) => s.profileId)
  const agent = useOffice((s) => s.agents.find((a) => a.id === s.profileId))
  const openProfile = useOffice((s) => s.openProfile)
  if (!profileId || !agent) return null
  return createPortal(<Drawer key={agent.id} agent={agent} onClose={() => openProfile(null)} />, document.body)
}

function Drawer({ agent, onClose: close }: { agent: OfficeAgent; onClose: () => void }) {
  // play the slide-out before unmounting
  const [closing, setClosing] = useState(false)
  const onClose = useCallback(() => {
    setClosing(true)
    setTimeout(close, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220)
  }, [close])
  const live = useOffice((s) => s.source === 'live')
  // the side session open in the Chat tab: the Terminal tab shows that one too
  const sessionParam = useUrl((s) => s.params.session)
  const termSession = sessionParam && agent.sessions?.some((s) => s.key === sessionParam && s.open) ? sessionParam : undefined
  const updateAgent = useOffice((s) => s.updateAgent)
  // the tab is in the address bar too (?agent=<id>&tab=terminal)
  const [tab, setTabState] = useState<Tab>(() => {
    const fromUrl = getParam('tab') as Tab | null
    const ok: Tab[] = live ? ['chat', 'terminal', 'folder', 'overview', 'claude', 'skills', 'connectors', 'activity'] : ['overview', 'claude', 'skills']
    return fromUrl && ok.includes(fromUrl) ? fromUrl : live ? 'chat' : 'overview'
  })
  const setTab = (t: Tab) => {
    setTabState(t)
    setUrl({ tab: t === (live ? 'chat' : 'overview') ? null : t })
  }
  const [original, setOriginal] = useState<Doc | null>(live ? null : localDoc(agent))
  const [draft, setDraft] = useState<Doc | null>(original)
  const [skillId, setSkillId] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')

  // live: the profile lives in the agent's folder on the server
  useEffect(() => {
    if (!live) return
    let alive = true
    api(`/api/agents/${agent.id}/profile`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the profile'))))
      .then((doc: Doc) => {
        if (!alive) return
        setOriginal(doc)
        setDraft(doc)
        setSkillId(doc.skills[0]?.id ?? null)
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
    // a new folder has its own CLAUDE.md and skills
  }, [live, agent.id, agent.cwd])

  useEffect(() => {
    if (!live && original) setSkillId(original.skills[0]?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Esc closes, except while typing in the terminal (Esc goes to Claude Code there)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && tab !== 'terminal' && !(e.target as HTMLElement)?.closest?.('.chat, .modal') && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, tab])

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(original)
  const set = (patch: Partial<Doc>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const save = async () => {
    if (!draft) return
    setError('')
    if (!live) {
      updateAgent(agent.id, { name: draft.name.trim() || agent.name, profile: { ...agent.profile, role: draft.role, claudeMd: draft.claudeMd, skills: draft.skills } })
      setOriginal(draft)
      flash()
      return
    }
    setState('saving')
    try {
      const res = await api(`/api/agents/${agent.id}/profile`, { method: 'PUT', body: JSON.stringify(draft) })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Save failed')
      const doc: Doc = await res.json()
      setOriginal(doc)
      setDraft(doc)
      flash()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setState('idle')
    }
  }
  const flash = () => {
    setState('saved')
    setTimeout(() => setState('idle'), 1600)
  }

  const tabs: { id: Tab; label: string; icon: ReactNode; liveOnly?: boolean }[] = [
    { id: 'chat', label: 'Chat', icon: <LuMessageSquare />, liveOnly: true },
    { id: 'terminal', label: 'Terminal', icon: <LuSquareTerminal />, liveOnly: true },
    { id: 'folder', label: 'Folder', icon: <LuFolder />, liveOnly: true },
    { id: 'overview', label: 'Overview', icon: <LuSettings2 /> },
    { id: 'claude', label: 'CLAUDE.md', icon: <LuFileText /> },
    { id: 'skills', label: 'Skills', icon: <LuSparkles /> },
    { id: 'connectors', label: 'Connectors', icon: <LuPlug />, liveOnly: true },
    { id: 'activity', label: 'Activity', icon: <LuActivity />, liveOnly: true },
  ]
  const profileTab = tab === 'overview' || tab === 'claude' || tab === 'skills'

  const max = useMaximize('ao-max-agent')
  // phones: a bottom sheet, closed by dragging its handle or header down
  const { dragProps } = useSheetDrag(onClose, max.ref)
  return (
    <div className={`drawer-backdrop${closing ? ' drawer-backdrop--closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={max.ref} className={`drawer${live ? ' drawer--wide' : ''}${live && max.full ? ' drawer--full' : ''}`} role="dialog" aria-modal="true" aria-label={`${agent.name}`}>
        <div className="drawer__grab" aria-hidden="true" {...dragProps} />
        <header className="drawer__head" {...dragProps}>
          <span className="avatar avatar--lg" style={avatarStyle(agent.look.shirt)}>
            {agent.name[0]}
          </span>
          <div className="drawer__title">
            <h3>
              {agent.name}
              <span className={`status status--${agent.status}`}>{agent.status}</span>
            </h3>
            <p className="muted">
              {agent.role || agent.profile.role || 'No role'} · <span className="mono">{agent.tmuxSession}</span>
              {agent.title && <> · {agent.title}</>}
            </p>
          </div>
          {live && <MaximizeButton full={max.full} onToggle={max.toggle} />}
          <button className="icon-btn small ghost" data-tip="Close" aria-label="Close" onClick={onClose}>
            <LuX />
          </button>
        </header>

        <nav className="drawer__tabs seg">
          {tabs
            .filter((t) => live || !t.liveOnly)
            .map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={(e) => {
                  setTab(t.id)
                  // tabs scroll sideways on phones: bring the chosen one fully into view
                  e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
                }}
              >
                {t.icon} {t.label}
                {t.id === 'skills' && draft && <span className="seg__count">{draft.skills.length}</span>}
                {t.id === 'connectors' && Array.isArray(agent.connectors) && <span className="seg__count">{agent.connectors.length}</span>}
              </button>
            ))}
        </nav>

        <div className={`drawer__body${tab === 'chat' || tab === 'terminal' ? ' drawer__body--flush' : ''}`}>
          {tab === 'chat' && <ChatTab agent={agent} />}
          {tab === 'terminal' && (
            // the session picked in the Chat tab (?session=s2), else the main one
            <TerminalTab
              key={termSession ?? ''}
              agentId={agent.id}
              session={termSession}
              offline={termSession ? false : (agent.mainStatus ?? agent.status) === 'offline'}
            />
          )}
          {tab === 'folder' && !agent.cwd && <div className="empty">No folder known for this agent yet.</div>}
          {tab === 'folder' && agent.cwd && (
            // the agent's own folder: browse, preview, upload, new folders (the same file manager as the Projects tab)
            <div className="agent-folder">
              <code className="agent-folder__path truncate" data-tip={agent.cwd}>
                {agent.cwd.replace(/^\/(Users|home)\/[^/]+/, '~')}
              </code>
              <FileBrowser key={agent.cwd} root={agent.cwd} />
            </div>
          )}
          {profileTab && !draft && <div className="empty">{error || <LuLoader className="spin" />}</div>}
          {tab === 'overview' && draft && <Overview agent={agent} live={live} draft={draft} set={set} />}
          {tab === 'claude' && draft && live && agent.kind !== 'manager' && (
            <OfficeRulesBar
              agentId={agent.id}
              dirty={draft.claudeMd !== original?.claudeMd}
              onApplied={(claudeMd) => {
                setOriginal((o) => (o ? { ...o, claudeMd } : o))
                setDraft((d) => (d ? { ...d, claudeMd } : d))
              }}
            />
          )}
          {tab === 'claude' && draft && (
            <div className="editor">
              <div className="editor__bar">
                <span className="mono muted">{(agent.cwd || '<folder>').replace(/\/$/, '')}/CLAUDE.md</span>
                <span className="muted">{draft.claudeMd.split('\n').length} lines</span>
              </div>
              <textarea
                className="editor__text mono"
                value={draft.claudeMd}
                onChange={(e) => set({ claudeMd: e.target.value })}
                spellCheck={false}
                placeholder="# Project instructions for this agent"
              />
            </div>
          )}
          {tab === 'skills' && draft && <Skills draft={draft} set={set} skillId={skillId} setSkillId={setSkillId} />}
          {tab === 'connectors' && <ConnectorsTab agent={agent} />}
          {tab === 'activity' && <AgentActivityTab agentId={agent.id} />}
        </div>

        {profileTab && (
          <footer className="drawer__foot">
            <span className={error ? 'danger-text' : 'muted'}>
              {error ||
                (state === 'saved'
                  ? 'Saved'
                  : dirty
                    ? 'Unsaved changes'
                    : live
                      ? 'Saved to the agent folder. Claude Code reads CLAUDE.md and skills at the start of each session.'
                      : 'Demo agent: changes stay in this browser.')}
            </span>
            <button onClick={onClose}>Close</button>
            <button className="primary" disabled={!dirty || state === 'saving'} onClick={save}>
              {state === 'saving' ? <LuLoader className="spin" /> : 'Save'}
            </button>
          </footer>
        )}
      </aside>
    </div>
  )
}

function localDoc(a: OfficeAgent): Doc {
  return { name: a.name, role: a.profile.role, claudeMd: a.profile.claudeMd, skills: structuredClone(a.profile.skills) }
}

const LIVE_MODES: LiveMode[] = ['default', 'acceptEdits', 'plan', 'auto']

function Overview({ agent, live, draft, set }: { agent: OfficeAgent; live: boolean; draft: Doc; set: (p: Partial<Doc>) => void }) {
  const [busy, setBusy] = useState('')
  const [moving, setMoving] = useState(false)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState('')
  const offline = agent.status === 'offline'
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

  return (
    <div className="drawer__form">
      <div className="field-row">
        <Field label="Name">
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" data-1p-ignore />
        </Field>
        <Field label="Role">
          <input value={draft.role} onChange={(e) => set({ role: e.target.value })} placeholder="e.g. Backend engineer" autoComplete="off" data-1p-ignore />
        </Field>
      </div>
      <div className="field">
        <span className="field__label">Character</span>
        <div className="figure-row">
          <FigurePicker
            value={agent.look.figure}
            onChange={(figure) => {
              // shown right away (same look, that figure's hairstyles); live, the server keeps it and tells every dashboard
              useOffice.setState((s) => ({ agents: s.agents.map((a) => (a.id === agent.id ? { ...a, figure, look: makeLook(a.desk, a.style, figure) } : a)) }))
              if (live) void liveApi.setFigure(agent.id, figure).catch(() => {})
            }}
          />
          <button
            type="button"
            className="icon-btn small"
            {...tip('Shuffle look: new hair, hat, glasses…')}
            onClick={() => {
              if (!live) {
                const style = Math.floor(Math.random() * 0x7fffffff)
                useOffice.setState((s) => ({ agents: s.agents.map((a) => (a.id === agent.id ? { ...a, style, look: makeLook(a.desk, style, a.look.figure) } : a)) }))
                return
              }
              void liveApi.shuffleStyle(agent.id).catch(() => {})
            }}
          >
            <LuShuffle />
          </button>
        </div>
      </div>

      {live && (
        <>
          <div className="field-row">
            <Field label="Model" hint="Changing it restarts the session and resumes the same conversation.">
              <Select
                ariaLabel="Model"
                value={modelAlias(agent.model)}
                options={MODEL_OPTIONS}
                disabled={offline || !!busy || agent.status === 'working'}
                onChange={(m) => run('model', () => liveApi.setModel(agent.id, m))}
              />
            </Field>
            <Field label="Effort" hint="Higher thinks harder but uses your plan faster. Restarts the session.">
              <Select
                ariaLabel="Effort"
                value={agent.effort ?? ''}
                options={EFFORT_OPTIONS}
                disabled={offline || !!busy || agent.status === 'working'}
                onChange={(e) => run('effort', () => liveApi.setEffort(agent.id, e ? (e as AgentEffort) : null))}
              />
            </Field>
            <Field
              label="Permission mode"
              hint={
                agent.permissionMode === 'auto' && (agent.connectorsWrite?.length ?? 0) > 0
                  ? '⚠️ Auto with connectors that can write: it may send or change things there without asking. Ask before actions is safer.'
                  : 'Applied to the running session right away.'
              }
            >
              <Select
                ariaLabel="Permission mode"
                value={agent.permissionMode ?? 'default'}
                options={LIVE_MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
                disabled={offline || !!busy}
                onChange={(m) =>
                  run('mode', async () => {
                    const r = await liveApi.setMode(agent.id, m)
                    if (r.deferred) setError(`Switches to ${MODE_LABEL[m]} when you answer the current prompt.`)
                  })
                }
              />
            </Field>
          </div>
          {error && <p className="warn">{error}</p>}
          <GitSection agent={agent} />
          <dl className="facts">
            <dt>Status</dt>
            <dd>{busy ? `${busy === 'model' || busy === 'effort' ? 'Restarting' : 'Switching'}…` : agent.status}</dd>
            <dt>Running model</dt>
            <dd>{agent.modelName ?? agent.model ?? '—'}</dd>
            <dt>Context used</dt>
            <dd>{agent.contextPct != null ? `${Math.round(agent.contextPct)}%` : '—'}</dd>
            <dt>Session cost</dt>
            <dd>{agent.costUsd != null ? `$${agent.costUsd.toFixed(2)} (list price; covered by your plan)` : '—'}</dd>
            <dt>Folder</dt>
            <dd className="folder-fact">
              <span className="mono">{agent.cwd}</span>
              {!moving && (
                <button className="small" onClick={() => (setFolder(agent.cwd ?? ''), setMoving(true))} disabled={!!busy}>
                  Change
                </button>
              )}
            </dd>
            <dt>Project folders</dt>
            <dd className="extra-dirs">
              {agent.extraDirs?.length ? (
                agent.extraDirs.map((d) => (
                  <span key={d} className="extra-dirs__item">
                    <span className="mono truncate" data-tip={d}>
                      {d}
                    </span>
                    <button
                      className="icon-btn small ghost"
                      data-tip="Take this folder away (restarts the session, conversation kept)"
                      aria-label={`Remove ${d}`}
                      disabled={!!busy}
                      onClick={() => run('dirs', () => liveApi.revokeDir(agent.id, d))}
                    >
                      <LuX />
                    </button>
                  </span>
                ))
              ) : (
                <span className="muted">Only its own folder. Tasks in projects linked to other folders add them here.</span>
              )}
            </dd>
            <dt>tmux</dt>
            <dd className="mono">
              {agent.tmuxSession} · <span className="muted">tmux attach -t {agent.tmuxSession}</span>
            </dd>
            <dt>Session id</dt>
            <dd className="mono">{agent.sessionId}</dd>
          </dl>
          <div className="row__actions">
            <button className="small" disabled={!!busy} onClick={() => run('restart', () => liveApi.restart(agent.id))}>
              <LuRotateCw className={busy === 'restart' ? 'spin' : ''} /> Restart session
            </button>
          </div>
          {moving && (
            <div className="move-folder">
              <span className="field__label">Move {agent.name} to another folder</span>
              <FolderPicker value={folder} onChange={setFolder} start={agent.cwd} />
              <p className="field__hint">
                Claude Code keeps conversations per folder, so {agent.name} starts a new conversation there. Hooks are set up automatically;
                the folder's own CLAUDE.md and skills are used.
              </p>
              <div className="move-folder__actions">
                <button className="small" onClick={() => setMoving(false)}>
                  Cancel
                </button>
                <button
                  className="small primary"
                  disabled={!folder.trim() || folder.trim() === agent.cwd || !!busy}
                  onClick={() =>
                    run('folder', async () => {
                      await liveApi.changeFolder(agent.id, folder.trim())
                      setMoving(false)
                    })
                  }
                >
                  {busy === 'folder' ? <LuLoader className="spin" /> : null} Move and restart
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Skills({ draft, set, skillId, setSkillId }: { draft: Doc; set: (p: Partial<Doc>) => void; skillId: string | null; setSkillId: (id: string | null) => void }) {
  const skills = draft.skills
  const live = useOffice((s) => s.source === 'live')
  const [accountId, setAccountId] = useState<string | null>(null)
  const skill = accountId ? null : (skills.find((s) => s.id === skillId) ?? null)
  const update = (id: string, patch: Partial<AgentSkill>) => set({ skills: skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const pick = (id: string) => {
    setAccountId(null)
    setSkillId(id)
  }
  const add = (s: AgentSkill = { id: `new-${Date.now()}`, name: 'new-skill', description: '', body: '', enabled: true }) => {
    set({ skills: [...skills, s] })
    pick(s.id)
  }
  return (
    <div className="skills">
      <div className="skills__side">
        <ul className="skills__list">
          {skills.map((s) => (
            <li key={s.id}>
              <button className={`skills__item${!accountId && s.id === skillId ? ' active' : ''}`} onClick={() => pick(s.id)}>
                <span className="truncate">{s.name || 'untitled'}</span>
                {!s.enabled && <span className="muted">manual</span>}
              </button>
            </li>
          ))}
          <li>
            <button className="skills__add" onClick={() => add()}>
              <LuPlus /> New skill
            </button>
          </li>
        </ul>
        {live && <AccountSkillList selected={accountId} onSelect={setAccountId} />}
      </div>
      {accountId ? (
        <AccountSkillView
          id={accountId}
          taken={skills.some((s) => s.name === slug(accountSkillName(accountId)))}
          onCopy={(s) => add({ id: `new-${Date.now()}`, name: slug(s.name), description: s.description, body: s.body, enabled: true })}
        />
      ) : skill ? (
        <div className="skills__edit">
          <div className="field-row">
            <Field label="Name" hint={`.claude/skills/${slug(skill.name) || 'name'}/SKILL.md`}>
              <input className="mono" value={skill.name} onChange={(e) => update(skill.id, { name: slug(e.target.value) })} autoComplete="off" />
            </Field>
            <label className="check skills__toggle" data-tip="When off, Claude only uses it when you ask for it by name">
              <input type="checkbox" checked={skill.enabled} onChange={(e) => update(skill.id, { enabled: e.target.checked })} /> Auto-use
            </label>
          </div>
          <Field label="Description" hint="Claude reads this to decide when to use the skill.">
            <input value={skill.description} onChange={(e) => update(skill.id, { description: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Instructions">
            <textarea className="editor__text mono" value={skill.body} onChange={(e) => update(skill.id, { body: e.target.value })} spellCheck={false} placeholder="Step-by-step instructions for this skill" />
          </Field>
          <button
            className="small ghost"
            onClick={async () => {
              if (!(await confirm({ title: `Remove the skill “${skill.name || 'Untitled'}”?`, message: 'It is taken out of the agent’s skills when you save.', confirmLabel: 'Remove' }))) return
              set({ skills: skills.filter((s) => s.id !== skill.id) })
              setSkillId(skills.find((s) => s.id !== skill.id)?.id ?? null)
            }}
          >
            <LuTrash2 /> Remove skill
          </button>
        </div>
      ) : (
        <div className="empty">
          {live
            ? 'No skills of its own yet. It already has the skills from your Claude account (left); add one here for something only this agent does.'
            : 'No skills yet. Add one to teach this agent a repeatable workflow.'}
        </div>
      )}
    </div>
  )
}

// ── skills from the Claude account (every agent has them) ──

const useAccountSkills = create<{ list: AccountSkill[] | null; load: () => void }>((setState, get) => ({
  list: null,
  load: () => {
    if (get().list) return
    api('/api/account-skills')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: AccountSkill[]) => setState({ list }))
      .catch(() => setState({ list: [] }))
  },
}))
const accountSkillName = (id: string) => useAccountSkills.getState().list?.find((s) => s.id === id)?.name ?? ''

const SOURCE_LABEL: Record<AccountSkill['source'], string> = { user: 'yours', 'claude.ai': 'claude.ai', plugin: 'plugin' }

function AccountSkillList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const list = useAccountSkills((s) => s.list)
  const load = useAccountSkills((s) => s.load)
  const [q, setQ] = useState('')
  useEffect(load, [load])
  const shown = (list ?? []).filter((s) => {
    const k = q.trim().toLowerCase()
    return !k || s.name.toLowerCase().includes(k) || s.description.toLowerCase().includes(k) || (s.plugin ?? '').toLowerCase().includes(k)
  })
  return (
    <div className="acct-skills">
      <span className="acct-skills__title" data-tip="From the Claude account's config folder: every agent already uses these">
        From your Claude account {list ? <span className="muted">· {list.length}</span> : null}
      </span>
      <input className="acct-skills__search" type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search account skills" />
      {!list ? (
        <span className="muted acct-skills__note">Loading…</span>
      ) : !shown.length ? (
        <span className="muted acct-skills__note">{list.length ? 'No match.' : 'None found in the account folder.'}</span>
      ) : (
        <ul className="skills__list acct-skills__list">
          {shown.map((s) => (
            <li key={s.id} className={`acct-skills__row${s.description ? ' acct-skills__row--info' : ''}`}>
              <button className={`skills__item${s.id === selected ? ' active' : ''}`} onClick={() => onSelect(s.id)}>
                <span className="truncate">{s.name}</span>
                <span className="acct-skills__src">{s.plugin ?? SOURCE_LABEL[s.source]}</span>
              </button>
              {/* the description sits behind an info icon: a tip on the whole row kept popping up while scrolling */}
              {s.description && (
                <span className="acct-skills__info" tabIndex={0} role="img" aria-label={`About ${s.name}`} data-tip-title={s.name} data-tip={s.description}>
                  <LuInfo />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AccountSkillView({ id, taken, onCopy }: { id: string; taken: boolean; onCopy: (s: AccountSkill & { body: string }) => void }) {
  const [skill, setSkill] = useState<(AccountSkill & { body: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setSkill(null)
    setError(null)
    api(`/api/account-skills/${id}`)
      .then(async (r) => (r.ok ? setSkill(await r.json()) : setError('Could not read this skill')))
      .catch(() => setError('Could not read this skill'))
  }, [id])
  if (error) return <div className="row__error">{error}</div>
  if (!skill) return <div className="muted">Loading…</div>
  return (
    <div className="skills__edit acct-skill">
      <div className="acct-skill__head">
        <b className="mono">{skill.name}</b>
        <span className="acct-skills__src">{skill.plugin ? `plugin · ${skill.plugin}` : SOURCE_LABEL[skill.source]}</span>
      </div>
      {skill.description && <p className="acct-skill__desc">{skill.description}</p>}
      <p className="field__hint">Every agent already has this skill (it comes with the Claude account). Copy it to make an editable version just for this agent.</p>
      <div className="acct-skill__body">
        <Markdown text={skill.body} />
      </div>
      <button className="small" disabled={taken} onClick={() => onCopy(skill)} data-tip={taken ? 'This agent already has a skill with this name' : 'Adds it to this agent\'s own skills; Save to write it'}>
        <LuCopy /> Copy to this agent
      </button>
    </div>
  )
}

/** Office rules in this agent's CLAUDE.md: which sets it has, changed with one click (only their marked blocks). */
function OfficeRulesBar({ agentId, dirty, onApplied }: { agentId: string; dirty: boolean; onApplied: (claudeMd: string) => void }) {
  const [current, setCurrent] = useState<string[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api(`/api/agents/${agentId}/rules`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { packs: string[] } | null) => {
        if (!alive || !d) return
        setCurrent(d.packs)
        setPicked(d.packs.length ? d.packs : ['office'])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [agentId])
  const changed = !!current && (picked.join() !== current.join() || !current.length)
  const apply = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await api(`/api/agents/${agentId}/rules`, { method: 'PUT', body: JSON.stringify({ packs: picked }) })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not apply')
      const d: { packs: string[]; claudeMd: string } = await res.json()
      setCurrent(d.packs)
      onApplied(d.claudeMd)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply')
    } finally {
      setBusy(false)
    }
  }
  if (!current) return null
  return (
    <div className="office-rules">
      <span className="field__label">Office rules</span>
      <RulesPicker value={picked} onChange={setPicked} disabled={busy} />
      <span className="grow" />
      <button className="small primary" disabled={!changed || busy || dirty} onClick={() => void apply()} data-tip={dirty ? 'Save or undo your edits first' : 'Only the rules blocks change; the rest of the file stays. It restarts when idle to read them.'}>
        {busy ? 'Applying…' : current.length ? 'Apply' : 'Add rules'}
      </button>
      {!current.length && <span className="field__hint office-rules__note">This CLAUDE.md has no office rules yet (or older ones without markers: they're replaced).</span>}
      {error && <span className="danger-text office-rules__note">{error}</span>}
    </div>
  )
}
