import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The preview proxy: only for a signed-in owner, and the app behind it never gets the dashboard's session cookie.
test('preview proxy', async () => {
  const hash = await Bun.password.hash('old-password-123', { algorithm: 'argon2id' })
  const p = Bun.spawn(['bun', join(import.meta.dir, 'previews.check.ts')], {
    env: { ...process.env, OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'ao-pv-')), OFFICE_USER: 'owner', OFFICE_PASSWORD_HASH: `b64:${Buffer.from(hash).toString('base64')}`, SESSION_SECRET: 'x'.repeat(40) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  const line = out.trim().split('\n').pop() ?? ''
  if (!line.startsWith('{')) throw new Error(err || out)
  const r = JSON.parse(line)
  expect(r.noSession).toBe(401)
  expect(r.setupOnly).toBe(401)
  expect(r.withSession).toBe(200)
  expect(r.upstreamSaw).toEqual({ cookie: 'theme=dark', host: 'localhost:4591', fwd: 'office.test:3000', path: '/hello' })
  expect(r.strip).toBe('a=1')
  expect(r.ports).toEqual([3000, 3001, 3002, 5173]) // below 1024: ignored
  expect(r.ws).toBe('echo:ping')
}, 30000)
