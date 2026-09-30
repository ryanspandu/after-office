// Run by auth-password.test.ts in its own process, with a throwaway login (OFFICE_USER / OFFICE_PASSWORD_HASH) and
// data folder: the auth config is read once, at import.
import { Hono } from 'hono'

const { changePassword, login, loginCode, requireAuth, requireJsonForWrites, twoFactorEnable, twoFactorSetup } = await import('./auth')
const kit = await import('./auth.testkit')
const app = new Hono()
app.use('/api/*', requireJsonForWrites, requireAuth)
app.post('/api/auth/login', login)
app.post('/api/auth/login/code', loginCode)
app.post('/api/auth/2fa/setup', twoFactorSetup)
app.post('/api/auth/2fa/enable', twoFactorEnable)
app.post('/api/auth/password', changePassword)
app.get('/api/x', (c) => c.json({ ok: true }))

const post = (path: string, body: unknown, cookie = '') =>
  app.request(`http://office.test${path}`, { method: 'POST', headers: { host: 'office.test', 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
// the first sign-in sets up 2FA (a second run on the same data folder starts over, like `auth:reset-2fa`)
const { settingsRepo } = await import('./db')
settingsRepo.delete('twoFactor')
const secret = (await kit.signInAndEnroll(app, 'owner', 'old-password-123'))!.secret
const signIn = (password: string) => kit.signIn(app, 'owner', password, secret)
const alive = async (cookie: string) => (await app.request('http://office.test/api/x', { headers: { host: 'office.test', cookie } })).status === 200

const out: Record<string, unknown> = {}
const a = (await signIn('old-password-123'))!
const b = (await signIn('old-password-123'))!
out.signedIn = !!a && !!b
out.wrongCurrent = (await post('/api/auth/password', { current: 'nope-nope-nope', next: 'new-password-456' }, a)).status
out.tooShort = (await post('/api/auth/password', { current: 'old-password-123', next: 'short' }, a)).status
out.notSignedIn = (await post('/api/auth/password', { current: 'old-password-123', next: 'new-password-456' })).status
out.noCode = (await post('/api/auth/password', { current: 'old-password-123', next: 'new-password-456' }, a)).status
out.changed = (await post('/api/auth/password', { current: 'old-password-123', next: 'new-password-456', code: kit.currentCode(secret) }, a)).status
out.thisBrowserStays = await alive(a)
out.otherBrowserOut = !(await alive(b))
out.oldPasswordRefused = (await signIn('old-password-123')) === null
out.newPasswordWorks = (await signIn('new-password-456')) !== null
console.log(JSON.stringify(out))
process.exit(0)
