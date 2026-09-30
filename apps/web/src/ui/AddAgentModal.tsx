import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { LuLoader } from 'react-icons/lu'
import { DEFAULT_MANAGER, type LiveMode } from '@after-office/shared'
import { api } from '../state/auth'
import { liveApi } from '../state/live'
import { useOffice } from '../state/store'
import { FolderPicker } from './FolderPicker'
import { Field, Modal } from './Modal'
import { Select } from './Select'
import { FigurePicker } from './FigurePicker'
import type { AgentFigure } from '@after-office/shared'
import { RulesPicker } from './RulesPicker'
import { DEFAULT_MODEL, defaultRulePacks, MODELS, type RulePackId } from '@after-office/shared'

const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const MODEL_LIST = MODELS.map((m) => ({ value: m.value as string, label: `${m.label} · ${m.hint}` }))
const MODES: { value: LiveMode; label: string }[] = [
  { value: 'default', label: 'Ask before actions' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan first' },
  { value: 'auto', label: 'Auto' },
]

/** `manager`: hire the office manager (one per office): it delegates to the other agents and reports back to you. */
export function AddAgentModal({ open, onClose, manager = false }: { open: boolean; onClose: () => void; manager?: boolean }) {
  const addAgent = useOffice((s) => s.addAgent)
  const live = useOffice((s) => s.source === 'live')
  const agents = useOffice((s) => s.agents)
  const taken = useMemo(() => new Set(agents.map((a) => a.tmuxSession)), [agents])
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [figure, setFigure] = useState<AgentFigure>(() => (Date.now() % 2 ? 'woman' : 'man'))
  const [session, setSession] = useState('')
  const [sessionEdited, setSessionEdited] = useState(false)
  const [cwd, setCwd] = useState('')
  const [cwdEdited, setCwdEdited] = useState(false)
  // where new agents live on the server (<agentsDir>/<name>), e.g. ~/after-office
  const [agentsDir, setAgentsDir] = useState('~/after-office')
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [mode, setMode] = useState<LiveMode>('auto')
  // office rules for its CLAUDE.md: follow the role (engineering for a coding one) until picked by hand
  const [rules, setRules] = useState<RulePackId[]>(['office'])
  const [rulesEdited, setRulesEdited] = useState(false)
  useEffect(() => {
    if (!rulesEdited) setRules(defaultRulePacks(role))
  }, [role, rulesEdited])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(manager ? DEFAULT_MANAGER.name : '')
    setRole(manager ? DEFAULT_MANAGER.role : '')
    setSession('')
    setSessionEdited(false)
    setCwd('')
    setCwdEdited(false)
    // the manager plans and delegates: the strongest model is worth it
    setModel(manager ? DEFAULT_MANAGER.model : DEFAULT_MODEL)
    // works without stopping for permission prompts, like a hire (risky actions are still held back by Claude Code)
    setMode('auto')
    setError('')
    setBusy(false)
    if (live)
      api('/api/fs')
        .then((r) => (r.ok ? r.json() : null))
        .then((l: { agentsDir?: string } | null) => l?.agentsDir && setAgentsDir(l.agentsDir.replace(/^\/(Users|home)\/[^/]+/, '~')))
        .catch(() => {})
  }, [open, manager, live])

  // live sessions are prefixed "ao-" on the server so they're easy to spot in `tmux ls`
  const prefix = live ? 'ao-' : 'cc-'
  const sessionName = sessionEdited ? session : name ? `${prefix}${slug(name)}` : ''
  const clash = !!sessionName && taken.has(sessionName)
  // <agents folder>/<name> until a folder is picked or typed
  const folder = cwdEdited ? cwd : name.trim() ? `${agentsDir.replace(/\/+$/, '')}/${slug(name)}` : ''
  const valid = name.trim() && sessionName && !clash && folder.trim() && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    if (!live) {
      addAgent({ name: name.trim(), tmuxSession: sessionName, cwd: folder.trim(), status: 'idle' })
      return onClose()
    }
    setBusy(true)
    setError('')
    try {
      // the server starts `claude` in tmux; the new agent arrives through the live feed and drives in
      await liveApi.createAgent({ name: name.trim(), role: role.trim(), cwd: folder.trim(), tmuxSession: sessionName, model, permissionMode: mode, kind: manager ? 'manager' : 'worker', figure, ...(manager ? {} : { rules }) })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the agent')
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={manager ? 'Hire a general manager' : 'New agent'}
      description={
        manager
          ? 'A Claude Code session that runs every division: it hands work to any active agent, follows up, and reports back to you in its chat. Divisions are your agents\' roles.'
          : 'Starts a Claude Code session in tmux on the server.'
      }
      width={540}
    >
      <form className="modal__body" onSubmit={submit}>
        <div className="field-row">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Atlas"
              autoFocus
              maxLength={24}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
          </Field>
          <Field label="Role">
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Backend engineer" maxLength={60} autoComplete="off" data-1p-ignore />
          </Field>
        </div>
        <div className="field">
          <span className="field__label">Character</span>
          <FigurePicker value={figure} onChange={setFigure} />
        </div>
        {!manager && (
          <Field label="Office rules" hint="Written into its CLAUDE.md. Software engineering is picked for a coding role; change it any time in its CLAUDE.md tab.">
            <RulesPicker
              value={rules}
              onChange={(r) => {
                setRules(r)
                setRulesEdited(true)
              }}
            />
          </Field>
        )}
        <p className="field__hint add-agent__connectors">
          Connectors (Gmail, Google Drive, …): all off for a new agent. Turn on the ones it needs in its profile → Connectors.
        </p>
        <Field label="tmux session" hint={clash ? 'A session with this name already exists.' : 'Auto-generated from the name. You can change it.'}>
          <input
            className={`mono${clash ? ' invalid' : ''}`}
            value={sessionName}
            onChange={(e) => {
              setSessionEdited(true)
              setSession(prefix + slug(e.target.value).replace(/^(cc|ao)-/, ''))
            }}
            placeholder={`${prefix}atlas`}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
        </Field>
        {live && (
          <div className="field-row">
            <Field label="Model">
              <Select
                ariaLabel="Model"
                value={model}
                options={MODEL_LIST}
                onChange={(m) => {
                  setModel(m)
                  // Haiku can't run in Auto: the closest it has
                  if (m === 'haiku' && mode === 'auto') setMode('acceptEdits')
                }}
              />
            </Field>
            <Field label="Starts in">
              <Select ariaLabel="Permission mode" value={mode} options={MODES} onChange={setMode} />
            </Field>
          </div>
        )}
        <Field label="Working folder" hint={`${agentsDir}/<name> by default (created for it). Type a path or browse to use another folder; ~ is the home folder.`}>
          <FolderPicker
            value={folder}
            onChange={(v) => {
              setCwd(v)
              setCwdEdited(true)
            }}
          />
        </Field>
        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {busy ? <LuLoader className="spin" /> : 'Create agent'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
