import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Changing the password in the Profile: the current one is checked, the new one works at once, the old one doesn't,
// and every other browser is signed out. Then `auth:setup` (a new env hash) wins over it again.
async function run(env: Record<string, string>) {
  const p = Bun.spawn(['bun', join(import.meta.dir, 'auth-password.check.ts')], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  const line = out.trim().split('\n').pop() ?? ''
  if (!line.startsWith('{')) throw new Error(err || out)
  return JSON.parse(line)
}

test('change password from the dashboard', async () => {
  const hash = await Bun.password.hash('old-password-123', { algorithm: 'argon2id' })
  const env = {
    OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'ao-pw-')),
    OFFICE_USER: 'owner',
    OFFICE_PASSWORD_HASH: `b64:${Buffer.from(hash).toString('base64')}`,
    SESSION_SECRET: 'x'.repeat(40),
  }
  expect(await run(env)).toEqual({
    signedIn: true,
    wrongCurrent: 403,
    tooShort: 400,
    notSignedIn: 401,
    noCode: 400,
    changed: 200,
    thisBrowserStays: true,
    otherBrowserOut: true,
    oldPasswordRefused: true,
    newPasswordWorks: true,
  })
  // `auth:setup` again (a forgotten password): a new hash in the env file, and the dashboard's change no longer counts
  const again = await Bun.password.hash('old-password-123', { algorithm: 'argon2id' })
  const after = await run({ ...env, OFFICE_PASSWORD_HASH: `b64:${Buffer.from(again).toString('base64')}` })
  expect(after.signedIn).toBe(true)
  expect(after.changed).toBe(200)
}, 60000)
