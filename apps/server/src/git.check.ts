// Run by git.test.ts in its own process, with a throwaway agents' home (OFFICE_AGENT_HOME): per-agent git identities
// and SSH keys, end to end with real git commits.
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { agentsRepo } = await import('./db')
const g = await import('./agents/git')
const out: Record<string, unknown> = {}
const cwd = mkdtempSync(join(tmpdir(), 'ao-git-'))
agentsRepo.insert({ id: 'git-a', name: 'Gita', tmux_session: 'ao-git-a', cwd, desk: 981, role: '', model: 'haiku', permission_mode: 'default', session_id: 'x', created_at: 0, kind: 'worker' })
const row = () => agentsRepo.get('git-a')!

try { g.setGitIdentity(row(), 'Gita', 'not-an-email') } catch (e) { out.badEmail = (e as Error).message }
g.setGitIdentity(row(), 'Gita Bot', 'gita@example.com')
const k = await g.generateKey(row())
out.generated = k.publicKey.startsWith('ssh-ed25519 ') && k.fingerprint.startsWith('SHA256:')
out.keyMode = (statSync(join(g.keyDir('git-a'), 'id_ed25519')).mode & 0o777).toString(8)

// an extra identity for a client's folder and their GitHub org
const clientDir = mkdtempSync(join(tmpdir(), 'ao-client-'))
try { g.putIdentity(row(), null, { name: 'X', email: 'x@y.z', match: [] }) } catch (e) { out.noRule = (e as Error).message }
const acme = g.putIdentity(row(), null, { label: 'Acme', name: 'Gita (Acme)', email: 'gita@acme.com', match: [clientDir, 'github.com/acme'] })
await g.generateKey(row(), acme.id)

const env = await g.gitEnv(row())
out.env = Object.keys(env)
const git = (dir: string, args: string[]) => new TextDecoder().decode(Bun.spawnSync(['git', ...args], { cwd: dir, env: { PATH: process.env.PATH!, HOME: cwd, ...env } }).stdout).trim()
const commitIn = (dir: string, remote?: string) => {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  if (remote) git(dir, ['remote', 'add', 'origin', remote])
  git(dir, ['commit', '--allow-empty', '-q', '-m', 'hi'])
  return `${git(dir, ['log', '-1', '--format=%an <%ae>'])} | key ${git(dir, ['config', 'core.sshCommand']).includes(`${acme.id}/id_ed25519`) ? 'acme' : 'default'}`
}
out.plain = commitIn(mkdtempSync(join(tmpdir(), 'ao-r1-')))
out.inClientFolder = commitIn(join(clientDir, 'site'))
out.acmeRemote = commitIn(mkdtempSync(join(tmpdir(), 'ao-r2-')), 'git@github.com:acme/api.git')
out.acmeHttps = commitIn(mkdtempSync(join(tmpdir(), 'ao-r3-')), 'https://github.com/acme/web.git')
out.otherOrg = commitIn(mkdtempSync(join(tmpdir(), 'ao-r4-')), 'git@github.com:someone-else/x.git')

// an existing key: accepted without a passphrase, refused with one, and not-a-key refused (the old key stays)
const tmp = mkdtempSync(join(tmpdir(), 'ao-key-'))
Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(tmp, 'plain')])
Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', 'secret', '-f', join(tmp, 'locked')])
const up = await g.uploadKey(row(), readFileSync(join(tmp, 'plain'), 'utf8'))
out.uploaded = up.publicKey.split(' ')[1] === readFileSync(join(tmp, 'plain.pub'), 'utf8').split(' ')[1]
try { await g.uploadKey(row(), readFileSync(join(tmp, 'locked'), 'utf8')) } catch (e) { out.locked = (e as Error).message }
try { await g.uploadKey(row(), 'hello') } catch (e) { out.notKey = (e as Error).message }
out.stillOld = row().ssh_public === up.publicKey && readFileSync(join(g.keyDir('git-a'), 'id_ed25519.pub'), 'utf8').trim() === up.publicKey
await g.removeIdentity(row(), acme.id)
out.identityGone = !statSync(g.keyDir('git-a', acme.id), { throwIfNoEntry: false })
await g.removeGitFor(row())
out.allGone = !statSync(g.keyDir('git-a'), { throwIfNoEntry: false })
agentsRepo.remove('git-a')
console.log(JSON.stringify(out))
process.exit(0)
