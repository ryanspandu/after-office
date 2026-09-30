import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Per-agent git identities and SSH keys (Overview → Git): in a throwaway agents' home, never the real ~/.ssh.
test('git identity and SSH keys per agent', async () => {
  const p = Bun.spawn(['bun', join(import.meta.dir, 'git.check.ts')], {
    env: { ...process.env, OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'ao-gd-')), OFFICE_AGENT_HOME: mkdtempSync(join(tmpdir(), 'ao-home-')), OFFICE_AGENTS_DIR: mkdtempSync(join(tmpdir(), 'ao-ad-')) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  const line = out.trim().split('\n').pop() ?? ''
  if (!line.startsWith('{')) throw new Error(err || out)
  const r = JSON.parse(line)
  expect(r.badEmail).toContain("doesn't look right")
  expect(r.generated).toBe(true)
  expect(r.keyMode).toBe('600')
  expect(r.noRule).toContain('Say where it applies')
  expect(r.env).toEqual(['GIT_CONFIG_GLOBAL'])
  // the default identity, unless a rule of another one matches (its folder, or its org's remote in either form)
  expect(r.plain).toBe('Gita Bot <gita@example.com> | key default')
  expect(r.inClientFolder).toBe('Gita (Acme) <gita@acme.com> | key acme')
  expect(r.acmeRemote).toBe('Gita (Acme) <gita@acme.com> | key acme')
  expect(r.acmeHttps).toBe('Gita (Acme) <gita@acme.com> | key acme')
  expect(r.otherOrg).toBe('Gita Bot <gita@example.com> | key default')
  expect(r.uploaded).toBe(true)
  expect(r.locked).toContain('passphrase')
  expect(r.notKey).toContain('Paste a private key')
  expect(r.stillOld).toBe(true)
  expect(r.identityGone).toBe(true)
  expect(r.allGone).toBe(true)
}, 30000)
