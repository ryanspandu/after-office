import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRulePacks, isEffort, isModelChoice, type AgentEffort, type ModelChoice, type FollowUpDecision, type LiveFollowUp, type LiveMode } from '@after-office/shared'
import { cleanPacks } from '../agents/rules'
import { agentsRepo, settingsRepo } from '../db'
import { AGENTS_DIR, PROJECT_DIR, PROJECTS_DIR, rootOf } from '../fsroots'
import { relative, sep } from 'node:path'
import { AgentError, createAgent, resolveCwd } from '../agents/manager'
import { addPending, getPending, resolvePending, updateRuntime } from '../agents/registry'
import { deliver, notifyUser } from './work'

// The manager may propose new agents; the owner decides. A hire waits under "For you" (kept in the
// settings table so it survives a restart) and only an approval starts a session. The manager never picks the
// folder: new agents live in OFFICE_AGENTS_DIR/<name>, a folder that must not exist yet.

export interface HireRequest {
  id: string
  managerId: string
  name: string
  role: string
  brief?: string
  model: ModelChoice
  mode: Extract<LiveMode, 'default' | 'acceptEdits' | 'plan' | 'auto'>
  folder: string
  /** its character in the office ('man' | 'woman'), when the manager said */
  figure?: 'man' | 'woman'
  /** connectors (tool prefixes) the manager asked for; the owner can change them before approving */
  connectors?: string[]
  /** thinking effort the manager suggested; unset: Claude Code's default */
  effort?: AgentEffort
  /** office rules for its CLAUDE.md (unset: by its role) */
  rules?: string[]
  createdAt: number
}

const KEY = 'pendingHires'
const load = (): HireRequest[] => {
  try {
    return JSON.parse(settingsRepo.get(KEY) ?? '[]')
  } catch {
    return []
  }
}
const save = (list: HireRequest[]) => settingsRepo.set(KEY, JSON.stringify(list))


const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

/** Most agents an office may have through the manager (the owner can still add more by hand). */
export const MAX_AGENTS = Math.max(1, Number(process.env.OFFICE_MAX_AGENTS) || 12)

/**
 * The folder for a hire: the manager's choice (e.g. a repo) or AGENTS_DIR/<name>. Symlinks are resolved first, so the
 * checks apply to where it really leads: inside an allowed root, no hidden folder on the way (~/.claude, ~/.ssh…),
 * not the After Office checkout, and not another agent's folder.
 */
export function hireFolder(name: string, wanted?: string) {
  const folder = resolveCwd(wanted?.trim() || join(AGENTS_DIR, slug(name)))
  const root = rootOf(folder)!
  if (relative(root, folder).split(sep).some((part) => part.startsWith('.'))) throw new AgentError('Hidden folders (starting with ".") are not allowed for agents')
  if (folder === PROJECT_DIR || folder.startsWith(PROJECT_DIR + sep)) throw new AgentError('Agents cannot work inside the After Office installation')
  if (folder === PROJECTS_DIR) throw new AgentError(`${PROJECTS_DIR} holds the projects; pick another name or folder`, 409)
  const other = agentsRepo.all().find((a) => a.cwd === folder) ?? load().find((h) => h.folder === folder)
  if (other) throw new AgentError(`${other.name} already works in ${folder}`, 409)
  if (!wanted?.trim() && existsSync(folder)) throw new AgentError(`${folder} already exists; pick another name or give a folder`, 409)
  return folder
}

export function requestHire(managerId: string, input: Omit<HireRequest, 'id' | 'managerId' | 'folder' | 'createdAt'> & { folder?: string }) {
  const name = input.name.trim()
  if (!slug(name)) throw new AgentError('Give the agent a name with letters or digits')
  const pendingNames = load().map((h) => h.name.toLowerCase())
  if (agentsRepo.all().some((a) => a.name.toLowerCase() === name.toLowerCase()) || pendingNames.includes(name.toLowerCase()))
    throw new AgentError(`There is already an agent (or a pending hire) called ${name}`, 409)
  if (agentsRepo.all().length + load().length >= MAX_AGENTS) throw new AgentError(`The office is full (${MAX_AGENTS} agents). Ask the owner.`, 409)
  const folder = hireFolder(name, input.folder)
  const hire: HireRequest = { ...input, name, id: `hire-${crypto.randomUUID().slice(0, 12)}`, managerId, folder, createdAt: Date.now() }
  save([...load(), hire])
  show(hire)
  return hire
}

function show(h: HireRequest) {
  if (getPending(h.id)) return
  addPending({
    id: h.id,
    agentId: h.managerId,
    kind: 'hire',
    tool: 'create_agent',
    message: `Hire ${h.name} (${h.role})`,
    input: { name: h.name, role: h.role, model: h.model, mode: h.mode, folder: h.folder, brief: h.brief ?? '', figure: h.figure ?? '', connectors: h.connectors ?? [], effort: h.effort ?? '', rules: h.rules ?? defaultRulePacks(h.role) },
    createdAt: h.createdAt,
  })
}

/** After a restart: pending hires are asked again. */
export function restoreHires() {
  for (const h of load()) if (agentsRepo.get(h.managerId)) show(h)
}

const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const

/**
 * The hire as the owner approved it: their edits (name, role, model, mode, character) over the manager's proposal.
 * A new name moves the default folder with it (<agents dir>/<new name>); a folder the manager chose stays.
 */
export function withEdits(h: HireRequest, d: Extract<FollowUpDecision, { type: 'allow' }>): HireRequest {
  const e = d.hire
  if (!e) return h
  const next = { ...h }
  const name = e.name?.trim()
  if (name && name !== h.name) {
    if (!slug(name) || name.length > 32) throw new AgentError('Give the agent a name with letters or digits (max 32 characters)')
    if (agentsRepo.all().some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new AgentError(`There is already an agent called ${name}`, 409)
    next.name = name
    if (h.folder === join(AGENTS_DIR, slug(h.name))) next.folder = hireFolder(name)
  }
  if (e.role?.trim()) next.role = e.role.trim().slice(0, 60)
  if (isModelChoice(e.model)) next.model = e.model
  if (e.mode && MODES.includes(e.mode)) next.mode = e.mode
  if (e.figure === 'man' || e.figure === 'woman') next.figure = e.figure
  if (e.effort === null) delete next.effort
  else if (isEffort(e.effort)) next.effort = e.effort
  if (Array.isArray(e.rules)) next.rules = cleanPacks(e.rules)
  if (Array.isArray(e.connectors)) next.connectors = e.connectors.filter((c) => typeof c === 'string')
  return next
}

export async function decideHire(f: LiveFollowUp, d: FollowUpDecision) {
  const proposed = load().find((x) => x.id === f.id)
  if (!proposed) return void resolvePending(f.id)
  // the owner's edits are checked before the proposal goes: a bad name leaves the card up to fix
  const h = d.type === 'allow' ? withEdits(proposed, d) : proposed
  resolvePending(f.id)
  save(load().filter((x) => x.id !== f.id))
  const managerName = agentsRepo.get(h.managerId)?.name ?? 'The manager'
  const note = (d.type === 'allow' || d.type === 'deny' ? d.note : '')?.trim() ?? ''
  if (d.type !== 'allow') {
    if (agentsRepo.get(h.managerId)) await deliver(h.managerId, `[After Office] The owner declined hiring ${h.name}${note ? `. Their note: ${note}` : '.'}`)
    return
  }
  hireFolder(h.name, h.folder) // still valid (nothing moved or appeared in the meantime)
  // what the owner changed, so the manager uses the right name from now on
  const changed = [
    h.name !== proposed.name && `name ${proposed.name} → ${h.name}`,
    h.role !== proposed.role && `role → ${h.role}`,
    h.model !== proposed.model && `model → ${h.model}`,
    h.mode !== proposed.mode && `mode → ${h.mode}`,
    h.figure && h.figure !== proposed.figure && `character → ${h.figure}`,
    h.effort !== proposed.effort && `effort → ${h.effort ?? 'default'}`,
    JSON.stringify(h.rules ?? null) !== JSON.stringify(proposed.rules ?? null) && `office rules → ${(h.rules ?? []).join(', ')}`,
    JSON.stringify(h.connectors ?? []) !== JSON.stringify(proposed.connectors ?? []) && `connectors → ${(h.connectors ?? []).length ? h.connectors!.join(', ') : 'none'}`,
  ].filter(Boolean)
  const row = await createAgent({
    name: h.name,
    role: h.role,
    cwd: h.folder,
    model: h.model,
    permissionMode: h.mode,
    kind: 'worker',
    figure: h.figure,
    connectors: h.connectors ?? [],
    effort: h.effort ?? null,
    ...(h.rules ? { rules: h.rules } : {}),
    profile: h.brief?.trim() ? { claudeMd: h.brief } : undefined,
  })
  updateRuntime(row.id, (rt) => rt)
  notifyUser(h.managerId, `${h.name} joined the office`, `Hired by ${managerName} with your approval: ${h.role}, ${h.model}, ${h.folder}.`)
  if (agentsRepo.get(h.managerId))
    await deliver(
      h.managerId,
      [
        `[After Office] The owner approved: ${h.name} (${h.role}) is starting up (agent id ${row.id}). Give it a few seconds before delegating.`,
        changed.length ? `They changed the proposal: ${changed.join(', ')}.` : '',
        note ? `Their note: ${note}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
}
