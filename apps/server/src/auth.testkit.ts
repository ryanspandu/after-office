// For tests: sign in the way the dashboard does, two-factor included (set up on first sign-in, then a code each
// time). The codes come from the secret the setup returned, as an authenticator app would compute them.
import type { Hono } from 'hono'
import { settingsRepo } from './db'
import { codeAt, stepAt } from './totp'

export const HOST = 'office.test'

export function makePost(app: Hono) {
  return (path: string, body: unknown, cookie = '') =>
    app.request(`http://${HOST}${path}`, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
}
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]

/** The current code. A code works once (per 30-second step): the test forgets the last one used, like time passing. */
export function currentCode(secret: string) {
  const t = JSON.parse(settingsRepo.get('twoFactor') ?? 'null')
  if (t) settingsRepo.set('twoFactor', JSON.stringify({ ...t, lastStep: -1 }))
  return codeAt(secret, stepAt())
}

/** First sign-in: password, then set up 2FA. Returns the session cookie, the secret and the recovery codes. */
export async function signInAndEnroll(app: Hono, username: string, password: string) {
  const post = makePost(app)
  const r = await post('/api/auth/login', { username, password })
  if (r.status !== 200) return null
  const setupCookie = cookieOf(r)
  const setup = (await (await post('/api/auth/2fa/setup', {}, setupCookie)).json()) as { secret: string }
  const enabled = await post('/api/auth/2fa/enable', { code: codeAt(setup.secret, stepAt()) }, setupCookie)
  const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] }
  return { cookie: setupCookie, secret: setup.secret, recoveryCodes }
}

/** A later sign-in: password, then the code. Null when refused. */
export async function signIn(app: Hono, username: string, password: string, secret: string) {
  const post = makePost(app)
  const r = await post('/api/auth/login', { username, password })
  if (r.status !== 200) return null
  const { ticket } = (await r.json()) as { ticket?: string }
  if (!ticket) return null
  const done = await post('/api/auth/login/code', { ticket, code: currentCode(secret) })
  return done.status === 200 ? cookieOf(done) : null
}
