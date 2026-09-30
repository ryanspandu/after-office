import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two-factor sign-in (authenticator app codes): required once set up, set up on the first sign-in.
test('two-factor sign-in', async () => {
  const hash = await Bun.password.hash('old-password-123', { algorithm: 'argon2id' })
  const p = Bun.spawn(['bun', join(import.meta.dir, 'auth-2fa.check.ts')], {
    env: { ...process.env, OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'ao-2fa-')), OFFICE_USER: 'owner', OFFICE_PASSWORD_HASH: `b64:${Buffer.from(hash).toString('base64')}`, SESSION_SECRET: 'x'.repeat(40) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  const line = out.trim().split('\n').pop() ?? ''
  if (!line.startsWith('{')) throw new Error(err || out)
  expect(JSON.parse(line)).toEqual({
    firstLogin: 'setup',
    setupMe: 'setup',
    setupBlocked: 403,
    qr: true,
    enableWrong: 403,
    recoveryCount: 8,
    thisBrowserIn: 200,
    otherBrowserOut: 401,
    stored: true,
    setupAgain: 409,
    needCode: true,
    wrongCode: 403,
    goodCode: 200,
    freshIn: 200,
    ticketUsed: 401,
    replay: 403,
    recovery: 200,
    recoveryAgain: 403,
    recoveryLeft: 7,
    freshMissing: 400,
    freshOk: 200,
    moved: 200,
    oldPhoneRefused: 403,
    renameNoCode: 400,
    renameBad: 400,
    renamed: 200,
    renamedMe: 'boss',
    renameOtherOut: 401,
    oldNameRefused: 401,
    newNameWorks: true,
    locked: 429,
  })
}, 60000)
