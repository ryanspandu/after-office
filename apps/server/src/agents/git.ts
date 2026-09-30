import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitIdentity } from '@after-office/shared'
import { agentsRepo, gitIdentitiesRepo, type AgentRow, type GitIdentityRow } from '../db'
import { AGENT_HOME, AGENTS_DIR } from '../fsroots'
import { runAsAgent } from './asagent'
import { AgentError } from './errors'

// Per-agent git identities and SSH keys (the agent's Overview → Git).
// - A default identity (name, email, key) on the agent, plus extra ones, each for the projects its rules match: folders
//   (a repo under ~/…/client-a) or repos by remote (github.com/acme). E.g. a work GitHub account for one client's repos.
// - Agents may share one Unix user (the VPS setup), so nothing goes in a global git or ssh config. Each session gets
//   GIT_CONFIG_GLOBAL = its own gitconfig, which includes the agents' ~/.gitconfig, sets the default identity, and
//   includes an identity's file (includeIf gitdir: / hasconfig:remote.*.url:) where its rules match. Every identity
//   file sets user.name/email and core.sshCommand with that identity's key.
// - Git reads the file on every run: after the first session start with it, changes apply right away.
// - Keys live in the agents' home (~/.ssh/after-office/<agent>/[<identity>/]id_ed25519), written as the agents' user
//   so ssh accepts them. Only public halves and fingerprints ever reach the dashboard.

export const keyDir = (agentId: string, identity?: string) => join(AGENT_HOME, '.ssh', 'after-office', agentId, ...(identity ? [identity] : []))
const keyFile = (agentId: string, identity?: string) => join(keyDir(agentId, identity), 'id_ed25519')
/** The agent's own gitconfig (GIT_CONFIG_GLOBAL of its session). */
export const gitConfigFile = (agentId: string) => join(keyDir(agentId), 'gitconfig')
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+$/
const ID_RE = /^gid-[a-f0-9]{12}$/
const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>"\\]/g, '').trim().slice(0, 80) : '')
function cleanEmail(v: unknown) {
  const e = typeof v === 'string' ? v.trim().slice(0, 120) : ''
  if (e && !EMAIL_RE.test(e)) throw new AgentError("That email address doesn't look right", 400)
  return e
}

/** A rule as typed ("~/projects/acme", "github.com/acme", "git@gitlab.com:team/**") → cleaned, or an error. */
export function cleanRule(v: string) {
  const r = v.trim().replace(/\s+/g, '')
  if (!r || r.length > 200 || /["\\\n]/.test(r)) throw new AgentError(`"${v}" isn't a folder or a repo`, 400)
  return r
}

/** One rule → the git includeIf conditions it stands for. */
export function ruleConditions(rule: string): string[] {
  // a folder: repos in it (and below). Git compares the repo's real path, so a folder reached through a symlink
  // (macOS /var → /private/var, a linked projects folder) also gets its real path
  if (rule.startsWith('/') || rule.startsWith('~/')) {
    const given = rule.replace(/\/+$/, '')
    let real = given
    try {
      real = realpathSync(given.startsWith('~/') ? join(AGENT_HOME, given.slice(2)) : given)
    } catch {
      // not there (yet) or not readable by the dashboard: the path as given
    }
    return [...new Set([`gitdir:${given}/`, `gitdir:${real}/`])]
  }
  // a full remote pattern, as git writes them
  if (/^(git@|ssh:\/\/|https?:\/\/)/.test(rule)) return [`hasconfig:remote.*.url:${rule}`]
  // host/owner[/repo]: both the SSH and the HTTPS remote forms
  const [host, ...path] = rule.split('/')
  const rest = path.join('/') || '*'
  const tail = path.length > 1 ? rest : `${rest}/**`
  return [`hasconfig:remote.*.url:git@${host}:${tail}`, `hasconfig:remote.*.url:https://${host}/${tail}`, `hasconfig:remote.*.url:ssh://git@${host}/${tail}`]
}

const sshCommand = (file: string) => `ssh -i ${q(file)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
const ini = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The agent's gitconfig and one file per extra identity: path → content. */
export function gitConfigFiles(row: AgentRow, identities = gitIdentitiesRepo.forAgent(row.id)): Record<string, string> {
  const files: Record<string, string> = {}
  const main = ['# After Office: git settings for this agent (made by the dashboard; Overview → Git). Do not edit.', '[include]', '\tpath = ~/.gitconfig']
  if (row.git_name || row.git_email) main.push('[user]', ...(row.git_name ? [`\tname = ${ini(row.git_name)}`] : []), ...(row.git_email ? [`\temail = ${ini(row.git_email)}`] : []))
  if (row.ssh_fingerprint) main.push('[core]', `\tsshCommand = ${ini(sshCommand(keyFile(row.id)))}`)
  for (const g of identities) {
    const file = join(keyDir(row.id, g.id), 'gitconfig')
    const lines = ['[user]', `\tname = ${ini(g.name)}`, `\temail = ${ini(g.email)}`]
    if (g.sshFingerprint) lines.push('[core]', `\tsshCommand = ${ini(sshCommand(keyFile(row.id, g.id)))}`)
    files[file] = lines.join('\n') + '\n'
    for (const rule of g.match) for (const cond of ruleConditions(rule)) main.push(`[includeIf ${ini(cond)}]`, `\tpath = ${ini(file)}`)
  }
  files[gitConfigFile(row.id)] = main.join('\n') + '\n'
  return files
}

async function asAgent(script: string, what: string) {
  const r = await runAsAgent(['sh', '-c', script], { cwd: AGENT_HOME, timeoutMs: 20_000, mergeStderr: true })
  if (r.code !== 0) throw new AgentError(`${what}: ${r.out.trim().split('\n').pop() || `exit ${r.code}`}`, 400)
  return r.out
}

/**
 * Files handed to the agents' user: written to a drop folder in the agents' folder (the dashboard may write there;
 * contents never appear in a command line), then moved into place by that user with the given mode.
 */
async function handOver(files: Record<string, string>, mode: '600' | '644', what: string) {
  const inbox = join(AGENTS_DIR, '.key-inbox')
  mkdirSync(inbox, { recursive: true })
  const drops: [string, string][] = []
  try {
    const cmds = ['umask 077']
    for (const [dest, content] of Object.entries(files)) {
      const drop = join(inbox, `${crypto.randomUUID()}.tmp`)
      writeFileSync(drop, content, { mode: 0o660 })
      chmodSync(drop, 0o660)
      drops.push([drop, dest])
      cmds.push(`mkdir -p ${q(join(dest, '..'))} && cp ${q(drop)} ${q(dest)}.new && chmod ${mode} ${q(dest)}.new && mv ${q(dest)}.new ${q(dest)} && rm -f ${q(drop)}`)
    }
    await asAgent(cmds.join(' && '), what)
  } finally {
    for (const [drop] of drops) rmSync(drop, { force: true })
  }
}

/** Write the agent's gitconfig files (at every session start, and after each change). */
export async function writeGitConfig(row: AgentRow) {
  await handOver(gitConfigFiles(row), '644', 'Could not write the git settings')
}

/** What the agent's session gets: its own gitconfig (written first; nothing if that fails, git stays as it was). */
export async function gitEnv(row: AgentRow): Promise<Record<string, string>> {
  try {
    await writeGitConfig(row)
    return { GIT_CONFIG_GLOBAL: gitConfigFile(row.id) }
  } catch (e) {
    console.error(`[git] ${row.name}:`, e instanceof Error ? e.message : e)
    return {}
  }
}

// ── the default identity (on the agent) ──

export function setGitIdentity(row: AgentRow, name: unknown, email: unknown) {
  agentsRepo.update(row.id, { git_name: cleanName(name) || null, git_email: cleanEmail(email) || null })
}

// ── extra identities ──

export const toIdentity = (g: GitIdentityRow): GitIdentity => ({
  id: g.id,
  label: g.label,
  name: g.name,
  email: g.email,
  match: g.match,
  ...(g.sshPublic && g.sshFingerprint ? { sshKey: { publicKey: g.sshPublic, fingerprint: g.sshFingerprint } } : {}),
})

export function putIdentity(row: AgentRow, id: string | null, b: { label?: unknown; name?: unknown; email?: unknown; match?: unknown }) {
  const prev = id ? gitIdentitiesRepo.get(id) : null
  if (id && (!prev || prev.agentId !== row.id)) throw new AgentError('No such identity', 404)
  const name = cleanName(b.name)
  const email = cleanEmail(b.email)
  if (!name || !email) throw new AgentError('An identity needs a name and an email', 400)
  const match = Array.isArray(b.match) ? [...new Set(b.match.filter((m): m is string => typeof m === 'string' && !!m.trim()).map(cleanRule))].slice(0, 20) : []
  if (!match.length) throw new AgentError('Say where it applies: a folder (~/projects/acme) or repos (github.com/acme)', 400)
  const g: GitIdentityRow = {
    ...(prev ?? { id: `gid-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, agentId: row.id }),
    label: cleanName(b.label) || email,
    name,
    email,
    match,
  }
  gitIdentitiesRepo.put(g)
  return g
}

export async function removeIdentity(row: AgentRow, id: string) {
  const g = gitIdentitiesRepo.get(id)
  if (!g || g.agentId !== row.id) throw new AgentError('No such identity', 404)
  gitIdentitiesRepo.remove(id)
  await asAgent(`rm -rf ${q(keyDir(row.id, id))}`, 'Could not remove its key')
}

// ── SSH keys (the default identity's, or an extra one's) ──

function identityOf(row: AgentRow, identity?: string) {
  if (!identity) return null
  if (!ID_RE.test(identity)) throw new AgentError('No such identity', 404)
  const g = gitIdentitiesRepo.get(identity)
  if (!g || g.agentId !== row.id) throw new AgentError('No such identity', 404)
  return g
}

async function recordKey(row: AgentRow, g: GitIdentityRow | null) {
  const f = keyFile(row.id, g?.id)
  const pub = (await asAgent(`cat ${q(f + '.pub')}`, 'Could not read the public key')).trim()
  const fp = (await asAgent(`ssh-keygen -lf ${q(f + '.pub')}`, 'Could not read the key')).trim().split(/\s+/)[1] ?? ''
  if (g) gitIdentitiesRepo.put({ ...g, sshPublic: pub, sshFingerprint: fp })
  else agentsRepo.update(row.id, { ssh_public: pub, ssh_fingerprint: fp })
  return { publicKey: pub, fingerprint: fp }
}

/** A new ed25519 key (replaces the old one). The private half never leaves the server. */
export async function generateKey(row: AgentRow, identity?: string) {
  const g = identityOf(row, identity)
  const f = keyFile(row.id, g?.id)
  const comment = `${row.name.replace(/[^\w.-]/g, '')}${g ? `-${g.label.replace(/[^\w.-]/g, '')}` : ''}@after-office`
  await asAgent(`umask 077 && mkdir -p ${q(keyDir(row.id, g?.id))} && rm -f ${q(f)} ${q(f + '.pub')} && ssh-keygen -q -t ed25519 -N '' -C ${q(comment)} -f ${q(f)}`, 'Could not make a key')
  return recordKey(row, g)
}

/** Use an existing private key (no passphrase: nobody could type it in). */
export async function uploadKey(row: AgentRow, privateKey: unknown, identity?: string) {
  const g = identityOf(row, identity)
  const text = typeof privateKey === 'string' ? privateKey.replace(/\r\n/g, '\n').trim() + '\n' : ''
  if (!/^-----BEGIN (OPENSSH|RSA|EC|DSA|)\s?PRIVATE KEY-----\n[\s\S]+\n-----END (OPENSSH|RSA|EC|DSA|)\s?PRIVATE KEY-----\n$/.test(text) || text.length > 20_000)
    throw new AgentError('Paste a private key (it starts with -----BEGIN … PRIVATE KEY-----)', 400)
  if (/Proc-Type:.*ENCRYPTED/.test(text)) throw new AgentError("This key has a passphrase; agents can't type it in. Use one without, or generate a new key.", 400)
  const f = keyFile(row.id, g?.id)
  const staged = `${f}.upload`
  await handOver({ [staged]: text }, '600', 'Could not save that key')
  await asAgent(
    // -P '': fails (instead of asking) for a key with a passphrase; the old key stays until the new one checks out
    `ssh-keygen -y -P '' -f ${q(staged)} > ${q(staged + '.pub')} && mv ${q(staged)} ${q(f)} && mv ${q(staged + '.pub')} ${q(f + '.pub')} || { rm -f ${q(staged)} ${q(staged + '.pub')}; echo 'Not a usable key (a passphrase, or not a private key)'; exit 1; }`,
    'Could not use that key',
  )
  return recordKey(row, g)
}

export async function removeKey(row: AgentRow, identity?: string) {
  const g = identityOf(row, identity)
  const f = keyFile(row.id, g?.id)
  await asAgent(`rm -f ${q(f)} ${q(f + '.pub')}`, 'Could not remove the key')
  if (g) {
    const { sshPublic: _p, sshFingerprint: _f, ...rest } = g
    gitIdentitiesRepo.put(rest)
  } else agentsRepo.update(row.id, { ssh_public: null, ssh_fingerprint: null })
}

/** The agent is gone: its identities and keys too. */
export async function removeGitFor(row: AgentRow) {
  gitIdentitiesRepo.removeAgent(row.id)
  await asAgent(`rm -rf ${q(keyDir(row.id))}`, 'Could not remove its keys')
}
