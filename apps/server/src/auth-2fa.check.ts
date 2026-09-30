// Run by auth-2fa.test.ts in its own process, with a throwaway login and data folder: sign-in with two-factor.
import { Hono } from 'hono'

const auth = await import('./auth')
const kit = await import('./auth.testkit')
const { settingsRepo } = await import('./db')
const { codeAt, stepAt } = await import('./totp')
const app = new Hono()
app.use('/api/*', auth.requireJsonForWrites, auth.requireAuth)
app.post('/api/auth/login', auth.login)
app.post('/api/auth/login/code', auth.loginCode)
app.post('/api/auth/2fa/setup', auth.twoFactorSetup)
app.post('/api/auth/2fa/enable', auth.twoFactorEnable)
app.post('/api/auth/2fa/reset', auth.twoFactorReset)
app.post('/api/auth/2fa/recovery', auth.twoFactorNewRecovery)
app.post('/api/auth/username', auth.changeUsername)
app.get('/api/auth/me', auth.me)
app.get('/api/x', (c) => c.json({ ok: true }))
app.post('/api/fresh', async (c) => auth.requireFreshCode(c, (await c.req.json()).code) ?? c.json({ ok: true }))

const post = kit.makePost(app)
const get = (path: string, cookie = '') => app.request(`http://office.test${path}`, { headers: { host: 'office.test', cookie } })
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]
const out: Record<string, unknown> = {}

// 1. not set up: the password signs in, but only to set 2FA up
const first = await post('/api/auth/login', { username: 'owner', password: 'old-password-123' })
const setupCookie = cookieOf(first)
out.firstLogin = (await first.json()).needs2fa
out.setupMe = (await (await get('/api/auth/me', setupCookie)).json()).needs2fa
out.setupBlocked = (await get('/api/x', setupCookie)).status
const other = cookieOf(await post('/api/auth/login', { username: 'owner', password: 'old-password-123' }))
const setup = (await (await post('/api/auth/2fa/setup', {}, setupCookie)).json()) as { secret: string; otpauthUrl: string }
out.qr = setup.otpauthUrl.startsWith('otpauth://totp/')
out.enableWrong = (await post('/api/auth/2fa/enable', { code: '000000' }, setupCookie)).status
const enabled = await post('/api/auth/2fa/enable', { code: codeAt(setup.secret, stepAt()) }, setupCookie)
const recovery = ((await enabled.json()) as { recoveryCodes: string[] }).recoveryCodes
out.recoveryCount = recovery.length
out.thisBrowserIn = (await get('/api/x', setupCookie)).status
out.otherBrowserOut = (await get('/api/x', other)).status
out.stored = !JSON.stringify(settingsRepo.get('twoFactor')).includes(setup.secret)
out.setupAgain = (await post('/api/auth/2fa/setup', {}, setupCookie)).status

// 2. set up: password, then the code
const pw = await post('/api/auth/login', { username: 'owner', password: 'old-password-123' })
const pwBody = (await pw.json()) as { needCode?: boolean; ticket: string }
out.needCode = pwBody.needCode === true && !pw.headers.get('set-cookie')
out.wrongCode = (await post('/api/auth/login/code', { ticket: pwBody.ticket, code: '123456' })).status
const good = await post('/api/auth/login/code', { ticket: pwBody.ticket, code: kit.currentCode(setup.secret) })
out.goodCode = good.status
const fresh = cookieOf(good)
out.freshIn = (await get('/api/x', fresh)).status
out.ticketUsed = (await post('/api/auth/login/code', { ticket: pwBody.ticket, code: kit.currentCode(setup.secret) })).status
// the same code twice (replay) is refused
const t2 = ((await (await post('/api/auth/login', { username: 'owner', password: 'old-password-123' })).json()) as { ticket: string }).ticket
const code = kit.currentCode(setup.secret)
await post('/api/fresh', { code }, fresh)
out.replay = (await post('/api/auth/login/code', { ticket: t2, code })).status
// a recovery code works once
out.recovery = (await post('/api/auth/login/code', { ticket: t2, recovery: recovery[0] })).status
const t3 = ((await (await post('/api/auth/login', { username: 'owner', password: 'old-password-123' })).json()) as { ticket: string }).ticket
out.recoveryAgain = (await post('/api/auth/login/code', { ticket: t3, recovery: recovery[0] })).status
out.recoveryLeft = (await (await get('/api/auth/me', fresh)).json()).twoFactor.recoveryLeft
// the code again for an action (Boss mode)
out.freshMissing = (await post('/api/fresh', {}, fresh)).status
out.freshOk = (await post('/api/fresh', { code: kit.currentCode(setup.secret) }, fresh)).status
// new phone: the current code, a new QR, its first code
const reset = (await (await post('/api/auth/2fa/reset', { code: kit.currentCode(setup.secret) }, fresh)).json()) as { secret: string }
out.moved = (await post('/api/auth/2fa/enable', { code: codeAt(reset.secret, stepAt()) }, fresh)).status
kit.currentCode(reset.secret)
out.oldPhoneRefused = (await post('/api/fresh', { code: codeAt(setup.secret, stepAt()) }, fresh)).status
// a new username: the code too; this browser stays, the old name no longer signs in
const otherBrowser = await kit.signIn(app, 'owner', 'old-password-123', reset.secret)
out.renameNoCode = (await post('/api/auth/username', { username: 'boss' }, fresh)).status
out.renameBad = (await post('/api/auth/username', { username: 'no spaces', code: '123456' }, fresh)).status
out.renamed = (await post('/api/auth/username', { username: 'boss', code: kit.currentCode(reset.secret) }, fresh)).status
out.renamedMe = (await (await get('/api/auth/me', fresh)).json()).user
out.renameOtherOut = (await get('/api/x', otherBrowser!)).status
out.oldNameRefused = (await post('/api/auth/login', { username: 'owner', password: 'old-password-123' })).status
out.newNameWorks = !!(await kit.signIn(app, 'boss', 'old-password-123', reset.secret))
// lockout after 5 wrong codes
for (let i = 0; i < 5; i++) await post('/api/fresh', { code: '000001' }, fresh)
out.locked = (await post('/api/fresh', { code: kit.currentCode(reset.secret) }, fresh)).status
console.log(JSON.stringify(out))
process.exit(0)
