import { settingsRepo } from '../db'
import { seal, unseal } from '../totp'
import { AgentError } from './errors'

// An agent's secrets (Overview → Secrets): access tokens for the services its projects use (Expo, Railway, Supabase,
// Vercel…), each an environment variable of its sessions (EXPO_TOKEN, RAILWAY_TOKEN…), which those tools read on
// their own. Stored sealed with the server's key; write-only (the dashboard shows a name and its last 4 characters,
// never the value again). A change restarts the agent once it's idle, so its sessions get it.

export interface SecretInfo {
  name: string
  /** the value's last 4 characters, to tell tokens apart */
  last4: string
  updatedAt: number
}
interface Stored extends SecretInfo {
  /** the value, sealed (totp.ts seal, with SESSION_SECRET) */
  sealed: string
}

const key = (agentId: string) => `agentSecrets:${agentId}`
const MAX = 40
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/
/** what the office itself sets or relies on: not overridable from here */
const RESERVED = /^(AO_|CLAUDE|ANTHROPIC_|GIT_|SSH_|TMUX|PATH$|HOME$|USER$|SHELL$|LANG$|LC_|LD_|DYLD_|NODE_OPTIONS$|TERM$|PWD$)/

const serverKey = () => {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) throw new AgentError('Sign-in is not set up on this server (SESSION_SECRET)', 500)
  return s
}

function load(agentId: string): Stored[] {
  try {
    const v = JSON.parse(settingsRepo.get(key(agentId)) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const save = (agentId: string, list: Stored[]) => (list.length ? settingsRepo.set(key(agentId), JSON.stringify(list)) : settingsRepo.delete(key(agentId)))

/** Its secrets as the dashboard sees them: names, never values. */
export const listSecrets = (agentId: string): SecretInfo[] => load(agentId).map(({ name, last4, updatedAt }) => ({ name, last4, updatedAt }))

/** Add or replace one. */
export function putSecret(agentId: string, nameIn: unknown, valueIn: unknown): SecretInfo {
  const name = typeof nameIn === 'string' ? nameIn.trim().toUpperCase() : ''
  if (!NAME.test(name)) throw new AgentError('A name in capitals, digits and _ (like EXPO_TOKEN)', 400)
  if (RESERVED.test(name)) throw new AgentError(`${name} is set by the office itself: pick another name`, 400)
  const value = typeof valueIn === 'string' ? valueIn.trim() : ''
  if (!value) throw new AgentError('Paste the value', 400)
  if (value.length > 8000 || /[\0\n\r]/.test(value)) throw new AgentError('That value can’t be used (one line, at most 8000 characters)', 400)
  const list = load(agentId).filter((s) => s.name !== name)
  if (list.length >= MAX) throw new AgentError(`At most ${MAX} secrets per agent`, 400)
  const info: SecretInfo = { name, last4: value.slice(-4), updatedAt: Date.now() }
  list.push({ ...info, sealed: seal(value, serverKey()) })
  list.sort((a, b) => a.name.localeCompare(b.name))
  save(agentId, list)
  return info
}

export function removeSecret(agentId: string, name: string) {
  const list = load(agentId)
  if (!list.some((s) => s.name === name)) throw new AgentError('No such secret', 404)
  save(agentId, list.filter((s) => s.name !== name))
}

/** Gone with its agent. */
export const dropSecrets = (agentId: string) => settingsRepo.delete(key(agentId))

/** Its secrets as environment variables for its sessions (ones that can't be opened, e.g. after a key change: left out). */
export function secretEnv(agentId: string): Record<string, string> {
  const out: Record<string, string> = {}
  const k = process.env.SESSION_SECRET
  if (!k) return out
  for (const s of load(agentId)) {
    const v = unseal(s.sealed, k)
    if (v !== null) out[s.name] = v
  }
  return out
}
