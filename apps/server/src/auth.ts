import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { getConnInfo } from 'hono/bun'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { agentToken } from './agents/env'
import { describeUserAgent, type LoginEvent, type SessionInfo } from '@after-office/shared'
import { loginLog, sessionsRepo, settingsRepo } from './db'
import { hashRecovery, matchStep, newRecoveryCodes, newSecret, otpauthUrl, seal, unseal } from './totp'

// Single-owner auth for a dashboard that runs on a VPS.
//
// - Credentials come from env: OFFICE_USER + OFFICE_PASSWORD_HASH (argon2id, see `bun run auth:setup`).
// - Sessions live in the database; the browser holds a random id in a signed, HttpOnly, SameSite=Strict cookie
//   (`__Host-` prefixed over HTTPS). Signing out deletes the session; changing the password ends every session.
// - Logins: per-IP lockout with growing lock times, an office-wide cap on failed attempts, and at most two password
//   checks at a time (argon2 is memory-hungry: a burst of logins must not take the server down).
// - Two-factor is required: a 6-digit code from an authenticator app (Google Authenticator) after the password. Until
//   it's set up, a signed-in browser may only set it up. Lost phone and recovery codes: `bun run auth:reset-2fa`.

const SHORT_TTL = 12 * 60 * 60 // seconds
const LONG_TTL = 30 * 24 * 60 * 60
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000
const MAX_LOCK_MS = 24 * 60 * 60 * 1000
/** failed logins per minute, all IPs together, before everyone waits a minute */
const GLOBAL_FAILS_PER_MIN = 20
const MAX_VERIFYING = 2

interface AuthConfig {
  user: string
  hash: string
  secret: string
  secure: boolean
  /** short fingerprint of the password hash: sessions made with an older password stop working */
  pw: string
  /** the env file's hash (a password changed in the dashboard replaces it until auth:setup runs again) */
  envHash: string
  /** the env file's username (likewise) */
  envUser: string
}

const fingerprint = (hash: string) => createHash('sha256').update(hash).digest('hex').slice(0, 16)

/**
 * A password changed in the dashboard (Profile → Change password) is kept in the database, over the one from the env
 * file (which the dashboard may not be allowed to write: /etc/after-office.env is root's on the VPS). It only counts
 * while the env file's hash is the one it replaced: running `bun run auth:setup` again (a forgotten password) wins.
 */
const PW_KEY = 'passwordOverride'
function passwordOverride(envHash: string): string | null {
  try {
    const o = JSON.parse(settingsRepo.get(PW_KEY) ?? 'null') as { hash?: string; over?: string } | null
    return o?.hash && o.over === fingerprint(envHash) ? o.hash : null
  } catch {
    return null
  }
}

/**
 * A username changed in the dashboard (Profile → Edit profile), over OFFICE_USER from the env file. Like the password,
 * it only counts while the env file still has the name it replaced: `bun run auth:setup` with a new name wins.
 */
const USER_KEY = 'usernameOverride'
function usernameOverride(envUser: string): string | null {
  try {
    const o = JSON.parse(settingsRepo.get(USER_KEY) ?? 'null') as { user?: string; over?: string } | null
    return o?.user && o.over === envUser ? o.user : null
  } catch {
    return null
  }
}
export const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/

function loadConfig(): AuthConfig | null {
  const envUser = process.env.OFFICE_USER
  const user = envUser ? (usernameOverride(envUser) ?? envUser) : envUser
  // stored base64-encoded ("b64:…") because .env loaders expand the `$` signs in argon2 hashes
  const rawHash = process.env.OFFICE_PASSWORD_HASH
  const envHash = rawHash?.startsWith('b64:') ? Buffer.from(rawHash.slice(4), 'base64').toString('utf8') : rawHash
  const secret = process.env.SESSION_SECRET
  if (!user || !envHash || !secret || secret.length < 32) return null
  const hash = passwordOverride(envHash) ?? envHash
  const secure = process.env.OFFICE_SECURE_COOKIE ? process.env.OFFICE_SECURE_COOKIE === 'true' : process.env.NODE_ENV === 'production'
  return { user, envUser: envUser!, hash, envHash, secret, secure, pw: fingerprint(hash) }
}

export const config = loadConfig()
if (!config) {
  console.warn(
    '[auth] OFFICE_USER, OFFICE_PASSWORD_HASH and SESSION_SECRET (32+ chars) are not all set. ' +
      'Every /api route will refuse requests. Run `bun run auth:setup` to create them.',
  )
}

/** The `__Host-` prefix pins the cookie to this exact host, HTTPS and path / (browsers enforce it). */
const COOKIE = config?.secure ? '__Host-ao_session' : 'ao_session'

// ── rate limiting ──
const fails = new Map<string, { count: number; until: number; locks: number; last: number }>()
let globalFails: number[] = []
let verifying = 0

function lockedFor(key: string) {
  const f = fails.get(key)
  return f && f.until > Date.now() ? f.until - Date.now() : 0
}

function recordFail(key: string) {
  const now = Date.now()
  const f = fails.get(key) ?? { count: 0, until: 0, locks: 0, last: now }
  f.count++
  f.last = now
  if (f.count >= MAX_FAILS) {
    // 15 min, 30 min, 1 h … up to a day
    f.until = now + Math.min(MAX_LOCK_MS, LOCK_MS * 2 ** f.locks)
    f.locks++
    f.count = 0
  }
  fails.set(key, f)
  globalFails.push(now)
}

// forget old entries so the map can't grow without bound
setInterval(() => {
  const now = Date.now()
  for (const [k, f] of fails) if (f.until < now && now - f.last > MAX_LOCK_MS) fails.delete(k)
  globalFails = globalFails.filter((t) => now - t < 60_000)
}, 10 * 60_000).unref?.()

/**
 * A browser request's Origin belongs to this dashboard: the Host it was sent to, or the public address it is served
 * at (OFFICE_PUBLIC_URL). Behind a proxy that rewrites Host (e.g. `tailscale serve`) the latter is what matches.
 */
export function sameOrigin(origin: string, host: string | undefined) {
  try {
    const o = new URL(origin)
    if (host && o.host === host) return true
    const pub = process.env.OFFICE_PUBLIC_URL
    return !!pub && o.origin === new URL(pub).origin
  } catch {
    return false // "null" or garbage
  }
}

const isLoopback = (ip?: string) => !!ip && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')

function clientIp(c: Context) {
  let remote = 'unknown'
  try {
    remote = getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // not a Bun request (tests)
  }
  // Behind the reverse proxy (OFFICE_TRUST_PROXY=true) the proxy's X-Forwarded-For names the client, but only a
  // proxy on this machine is believed: a direct connection can't pick its own IP by sending the header.
  if (process.env.OFFICE_TRUST_PROXY === 'true' && isLoopback(remote)) {
    const fwd = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || c.req.header('x-real-ip')
    if (fwd) return fwd
  }
  return remote
}

// ── sessions ──
const hashId = (id: string) => createHash('sha256').update(id).digest('hex')

/**
 * The signed-in browser: `full` (password and code), or `setup` (password only, while 2FA isn't set up yet: it may
 * only set it up). Once 2FA is set up, a session without the code doesn't count at all.
 */
async function readSessionLevel(c: Context): Promise<{ user: string; level: 'full' | 'setup' } | null> {
  if (!config) return null
  const id = await getSignedCookie(c, config.secret, COOKIE)
  if (!id) return null
  const key = hashId(id)
  const s = sessionsRepo.get(key)
  const now = Date.now()
  if (!s || s.user !== config.user || s.pw !== config.pw || s.expires_at <= now) return null
  const enrolled = !!twoFactor()
  if (enrolled && s.mfa !== 1) return null
  // "last active" for the Profile's device list (written at most once a minute)
  if (now - (s.last_seen ?? 0) > 60_000) sessionsRepo.touch(key, now)
  c.set('sessionKey' as never, key as never)
  return { user: s.user, level: enrolled ? 'full' : 'setup' }
}

/** A fully signed-in user (password and code), or null. */
async function readSession(c: Context): Promise<string | null> {
  const s = await readSessionLevel(c)
  return s?.level === 'full' ? s.user : null
}

// ── two-factor (authenticator app codes) ──
const TWO_FA_KEY = 'twoFactor'
interface TwoFactor {
  /** the base32 secret, sealed with SESSION_SECRET */
  secret: string
  enrolledAt: number
  /** the last step a code was used for: a code works once */
  lastStep: number
  /** SHA-256 of the recovery codes not used yet */
  recovery: string[]
}

function twoFactor(): TwoFactor | null {
  try {
    const t = JSON.parse(settingsRepo.get(TWO_FA_KEY) ?? 'null') as TwoFactor | null
    return t?.secret ? t : null
  } catch {
    return null
  }
}
const saveTwoFactor = (t: TwoFactor) => settingsRepo.set(TWO_FA_KEY, JSON.stringify(t))

/** Is 2FA set up? (Every sign-in then needs a code.) */
export const twoFactorEnrolled = () => !!twoFactor()

type CodeCheck = { ok: true } | { ok: false; error: string; status: 400 | 403 | 429 | 500; retryAfter?: number }

/**
 * Check an authenticator code (or, with `recovery`, a one-time recovery code) with the lockout of sign-in: 5 wrong
 * ones lock this IP out for a while. A code works once.
 */
function checkCode(c: Context, input: { code?: unknown; recovery?: unknown }, allowRecovery = false): CodeCheck {
  const t = twoFactor()
  if (!t || !config) return { ok: false, error: 'Two-factor is not set up.', status: 400 }
  const ipKey = `code:${clientIp(c)}`
  const wait = lockedFor(ipKey)
  if (wait) return { ok: false, error: 'Too many attempts. Try again later.', status: 429, retryAfter: Math.ceil(wait / 1000) }
  const code = typeof input.code === 'string' ? input.code.trim() : ''
  const recovery = allowRecovery && typeof input.recovery === 'string' ? input.recovery.trim() : ''
  if (!code && !recovery) return { ok: false, error: 'Enter the 6-digit code from your authenticator app.', status: 400 }
  recordFail(ipKey)
  if (recovery) {
    const h = hashRecovery(recovery)
    if (recovery.length > 64 || !t.recovery.includes(h)) return { ok: false, error: 'That recovery code is wrong or already used.', status: 403 }
    saveTwoFactor({ ...t, recovery: t.recovery.filter((x) => x !== h) })
  } else {
    const secret = unseal(t.secret, config.secret)
    if (!secret) return { ok: false, error: "The two-factor secret can't be read (SESSION_SECRET changed?). Run `bun run auth:reset-2fa` on the server.", status: 500 }
    const step = matchStep(secret, code, { after: t.lastStep })
    if (step === null) return { ok: false, error: 'Wrong code. Use the current one from your authenticator app.', status: 403 }
    saveTwoFactor({ ...t, lastStep: step })
  }
  fails.delete(ipKey)
  globalFails.pop()
  return { ok: true }
}

const codeError = (c: Context, r: Extract<CodeCheck, { ok: false }>) =>
  c.json({ error: r.error, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) }, r.status)

/**
 * For actions that need the code again while signed in (turning on Boss mode): null when the code is right, else the
 * error response to send.
 */
export function requireFreshCode(c: Context, code: unknown): Response | null {
  const r = checkCode(c, { code })
  return r.ok ? null : codeError(c, r)
}

// a secret being set up (shown as a QR code), per session, until the first code from it proves the phone has it
const pendingSecrets = new Map<string, { secret: string; until: number; replacing: boolean }>()
const SETUP_MS = 15 * 60_000

function startSetup(c: Context, key: string, replacing: boolean) {
  const secret = newSecret()
  pendingSecrets.set(key, { secret, until: Date.now() + SETUP_MS, replacing })
  const issuer = brandName()
  return c.json({ secret, otpauthUrl: otpauthUrl(secret, config!.user, issuer), issuer, account: config!.user })
}

let brandName = () => 'After Office'
let avatarSource: () => string | null = () => null
/** The owner's picture address (set by the profile routes). */
export const setAvatarSource = (f: () => string | null) => void (avatarSource = f)
/** The office's name for the authenticator's label (set by the branding routes). */
export const setBrandNameSource = (f: () => string) => void (brandName = f)

/** POST /api/auth/2fa/setup: a new secret to scan (only while 2FA isn't set up; a new phone goes through /reset). */
export async function twoFactorSetup(c: Context) {
  const key = c.get('sessionKey' as never) as string | undefined
  if (!key || !config) return c.json({ error: 'Not signed in' }, 401)
  if (twoFactor()) return c.json({ error: 'Two-factor is already set up. To move it to a new phone, use Profile → Two-factor.' }, 409)
  return startSetup(c, key, false)
}

/** POST /api/auth/2fa/reset { code }: move 2FA to a new phone (the current code first); then /enable as for setup. */
export async function twoFactorReset(c: Context) {
  const key = c.get('sessionKey' as never) as string | undefined
  if (!key || !config) return c.json({ error: 'Not signed in' }, 401)
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; recovery?: unknown } | null
  const r = checkCode(c, body ?? {}, true)
  if (!r.ok) return codeError(c, r)
  return startSetup(c, key, true)
}

/**
 * POST /api/auth/2fa/enable { code }: the first code from the new secret. Saved; this browser counts as signed in with
 * a code, every other one signs in again; the recovery codes come back once.
 */
export async function twoFactorEnable(c: Context) {
  const key = c.get('sessionKey' as never) as string | undefined
  if (!key || !config) return c.json({ error: 'Not signed in' }, 401)
  const pending = pendingSecrets.get(key)
  if (!pending || pending.until < Date.now()) return c.json({ error: 'Start again: the QR code expired.' }, 400)
  if (twoFactor() && !pending.replacing) return c.json({ error: 'Two-factor is already set up.' }, 409)
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
  const ipKey = `code:${clientIp(c)}`
  const wait = lockedFor(ipKey)
  if (wait) return c.json({ error: 'Too many attempts. Try again later.', retryAfter: Math.ceil(wait / 1000) }, 429)
  recordFail(ipKey)
  const step = matchStep(pending.secret, typeof body?.code === 'string' ? body.code : '')
  if (step === null) return c.json({ error: 'Wrong code. Scan the QR code, then enter the 6 digits the app shows.' }, 403)
  fails.delete(ipKey)
  globalFails.pop()
  pendingSecrets.delete(key)
  const codes = newRecoveryCodes()
  saveTwoFactor({ secret: seal(pending.secret, config.secret), enrolledAt: Date.now(), lastStep: step, recovery: codes.map(hashRecovery) })
  sessionsRepo.setMfa(key)
  sessionsRepo.clearOthers(key)
  return c.json({ ok: true, recoveryCodes: codes })
}

/** POST /api/auth/2fa/recovery { code }: new recovery codes (the old ones stop working). */
export async function twoFactorNewRecovery(c: Context) {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
  const r = checkCode(c, body ?? {})
  if (!r.ok) return codeError(c, r)
  const codes = newRecoveryCodes()
  saveTwoFactor({ ...twoFactor()!, recovery: codes.map(hashRecovery) })
  return c.json({ ok: true, recoveryCodes: codes })
}


// after the password, before the code: a ticket for the second step (in memory, a few minutes, a few tries)
const tickets = new Map<string, { ip: string; until: number; tries: number; remember: boolean }>()
const TICKET_MS = 5 * 60_000

async function startSession(c: Context, remember: boolean, mfa: boolean) {
  const now = Date.now()
  const ttl = remember ? LONG_TTL : SHORT_TTL
  const id = randomBytes(32).toString('base64url')
  sessionsRepo.add({ id: hashId(id), user: config!.user, pw: config!.pw, expires_at: now + ttl * 1000, created_at: now, ip: clientIp(c), agent: agentOf(c), last_seen: now, mfa: mfa ? 1 : 0 })
  await setSignedCookie(c, COOKIE, id, config!.secret, {
    httpOnly: true,
    secure: config!.secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: ttl,
  })
}

/** POST /api/auth/login/code { ticket, code | recovery }: the second step of signing in. */
export async function loginCode(c: Context) {
  if (!config) return c.json({ error: 'Auth is not configured on the server.' }, 503)
  const body = (await c.req.json().catch(() => null)) as { ticket?: unknown; code?: unknown; recovery?: unknown } | null
  const id = typeof body?.ticket === 'string' ? body.ticket : ''
  const t = tickets.get(id)
  if (!t || t.until < Date.now() || t.ip !== clientIp(c)) {
    tickets.delete(id)
    return c.json({ error: 'Sign in again: that took too long.', restart: true }, 401)
  }
  const r = checkCode(c, body ?? {}, true)
  if (!r.ok) {
    loginLog.add({ at: Date.now(), ok: false, ip: clientIp(c), agent: agentOf(c), user: config.user, step: typeof body?.recovery === 'string' && body.recovery.trim() ? 'recovery' : 'code' })
    if (++t.tries >= 5) tickets.delete(id)
    return c.json({ error: r.error, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}), ...(t.tries >= 5 ? { restart: true } : {}) }, r.status)
  }
  tickets.delete(id)
  loginLog.add({ at: Date.now(), ok: true, ip: clientIp(c), agent: agentOf(c), user: config.user, step: typeof body?.recovery === 'string' && body.recovery.trim() ? 'recovery' : 'code' })
  await startSession(c, t.remember, true)
  return c.json({ user: config.user })
}

setInterval(() => {
  const now = Date.now()
  for (const [k, t] of tickets) if (t.until < now) tickets.delete(k)
  for (const [k, p] of pendingSecrets) if (p.until < now) pendingSecrets.delete(k)
}, 60_000).unref?.()

/** The dashboard's session cookie, under either name (HTTPS-only or not): the preview proxy strips it. */
export const SESSION_COOKIE_NAMES = ['__Host-ao_session', 'ao_session']

// the same check as the dashboard's, for a request that isn't one of its own (the preview proxy)
const sessionProbe = new Hono().get('*', async (c) => c.text((await readSession(c)) ?? ''))
/** The signed-in user for a Cookie header, or null. */
export async function readSessionFromCookie(cookie: string | null) {
  if (!cookie) return null
  const res = await sessionProbe.request('http://preview.local/', { headers: { cookie } })
  return (await res.text()) || null
}

const agentOf = (c: Context) => (c.req.header('user-agent') ?? '').slice(0, 300)

/** Who sent a request, for the Activity log: their device ("Chrome on macOS") and IP address. */
export const requestWho = (c: Context) => ({ device: describeUserAgent(agentOf(c)).label, ip: clientIp(c) })

/** GET /api/auth/sessions: the owner's signed-in browsers and recent sign-in attempts. */
export async function listSessions(c: Context) {
  if (!config) return c.json({ error: 'Auth is not configured on the server.' }, 503)
  const current = c.get('sessionKey' as never) as string | undefined
  const sessions: SessionInfo[] = sessionsRepo
    .active(config.user)
    .filter((s) => s.pw === config!.pw)
    .map((s) => ({ id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen || s.created_at, expiresAt: s.expires_at, ip: s.ip, agent: s.agent, current: s.id === current }))
  const log: LoginEvent[] = loginLog.latest(30).map((e) => ({
    // entries from before the step was recorded: "<user> (wrong code)" was a wrong authenticator code
    ...e,
    ...(e.user.endsWith(' (wrong code)') ? { user: e.user.slice(0, -' (wrong code)'.length), step: 'code' } : {}),
  })).map((e) => ({
    at: e.at,
    ok: !!e.ok,
    ip: e.ip,
    agent: e.agent,
    ...(e.user && e.user !== config!.user ? { username: e.user } : {}),
    ...(e.step === 'password' || e.step === 'code' || e.step === 'recovery' ? { step: e.step } : {}),
  }))
  return c.json({ sessions, log })
}

/** DELETE /api/auth/sessions/:id: sign one browser out (this one included). */
export async function revokeSession(c: Context) {
  const id = c.req.param('id') ?? ''
  if (!/^[a-f0-9]{64}$/.test(id)) return c.json({ error: 'Invalid session' }, 400)
  sessionsRepo.remove(id)
  if (id === c.get('sessionKey' as never)) deleteCookie(c, COOKIE, { path: '/', secure: config?.secure })
  return c.json({ ok: true })
}

/** POST /api/auth/logout-others: every browser but this one. */
export async function logoutOthers(c: Context) {
  const current = c.get('sessionKey' as never) as string | undefined
  if (!current) return c.json({ error: 'Not signed in' }, 401)
  sessionsRepo.clearOthers(current)
  return c.json({ ok: true })
}

export async function login(c: Context) {
  if (!config) return c.json({ error: 'Auth is not configured on the server.' }, 503)
  const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown; remember?: unknown } | null
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || !password || username.length > 64 || password.length > 1024) return c.json({ error: 'Enter your username and password.' }, 400)

  const now = Date.now()
  const ipKey = `ip:${clientIp(c)}`
  const wait = lockedFor(ipKey)
  if (wait) return c.json({ error: 'Too many attempts. Try again later.', retryAfter: Math.ceil(wait / 1000) }, 429)
  if (globalFails.filter((t) => now - t < 60_000).length >= GLOBAL_FAILS_PER_MIN)
    return c.json({ error: 'Too many failed logins right now. Try again in a minute.', retryAfter: 60 }, 429)
  if (verifying >= MAX_VERIFYING) return c.json({ error: 'Busy, try again in a moment.', retryAfter: 2 }, 429)

  // count the attempt before the (slow) check, so a burst of parallel requests can't all slip past the lock
  recordFail(ipKey)
  verifying++
  let passwordOk = false
  try {
    // always verify (even for an unknown user) so timing doesn't reveal which part was wrong
    passwordOk = await Bun.password.verify(password, config.hash).catch(() => false)
  } finally {
    verifying--
  }
  if (username !== config.user || !passwordOk) {
    loginLog.add({ at: now, ok: false, ip: clientIp(c), agent: agentOf(c), user: username.slice(0, 64), step: 'password' })
    return c.json({ error: 'Wrong username or password.' }, 401)
  }
  // right: this attempt doesn't count
  fails.delete(ipKey)
  globalFails.pop()

  const remember = body?.remember === true
  // 2FA set up: no session yet, the code comes next
  if (twoFactor()) {
    const ticket = randomBytes(24).toString('base64url')
    tickets.set(ticket, { ip: clientIp(c), until: now + TICKET_MS, tries: 0, remember })
    return c.json({ needCode: true, ticket })
  }
  // not yet: signed in only to set it up
  loginLog.add({ at: now, ok: true, ip: clientIp(c), agent: agentOf(c), user: username, step: 'password' })
  await startSession(c, remember, false)
  return c.json({ user: config.user, needs2fa: 'setup' })
}

export async function logout(c: Context) {
  const id = config ? await getSignedCookie(c, config.secret, COOKIE) : null
  if (id) sessionsRepo.remove(hashId(id))
  deleteCookie(c, COOKIE, { path: '/', secure: config?.secure })
  return c.json({ ok: true })
}

export const MIN_PASSWORD = 12

/**
 * POST /api/auth/password { current, next }: change the password from the dashboard. The current one is checked
 * (with the same lockout as sign-in); every other browser is signed out, this one stays signed in.
 */
export async function changePassword(c: Context) {
  if (!config) return c.json({ error: 'Auth is not configured on the server.' }, 503)
  const key = c.get('sessionKey' as never) as string | undefined
  if (!key) return c.json({ error: 'Not signed in' }, 401)
  const body = (await c.req.json().catch(() => null)) as { current?: unknown; next?: unknown; code?: unknown } | null
  const current = typeof body?.current === 'string' ? body.current : ''
  const next = typeof body?.next === 'string' ? body.next : ''
  if (!current) return c.json({ error: 'Enter your current password.' }, 400)
  if (next.length < MIN_PASSWORD || next.length > 1024) return c.json({ error: `The new password needs at least ${MIN_PASSWORD} characters.` }, 400)
  if (next === current) return c.json({ error: 'The new password is the same as the current one.' }, 400)

  const ipKey = `pw:${clientIp(c)}`
  const wait = lockedFor(ipKey)
  if (wait) return c.json({ error: 'Too many attempts. Try again later.', retryAfter: Math.ceil(wait / 1000) }, 429)
  if (verifying >= MAX_VERIFYING) return c.json({ error: 'Busy, try again in a moment.', retryAfter: 2 }, 429)
  recordFail(ipKey)
  verifying++
  let ok = false
  try {
    ok = await Bun.password.verify(current, config.hash).catch(() => false)
  } finally {
    verifying--
  }
  // 403, not 401: a wrong answer here doesn't mean this browser is signed out
  if (!ok) return c.json({ error: 'The current password is wrong.' }, 403)
  fails.delete(ipKey)
  // and the authenticator code: a password alone (seen over a shoulder) can't change it
  const code = checkCode(c, { code: body?.code })
  if (!code.ok) return codeError(c, code)

  const hash = await Bun.password.hash(next, { algorithm: 'argon2id' })
  settingsRepo.set(PW_KEY, JSON.stringify({ hash, over: fingerprint(config.envHash), at: Date.now() }))
  config.hash = hash
  config.pw = fingerprint(hash)
  // every other browser signs in again with the new password; this one carries on
  sessionsRepo.clearOthers(key)
  sessionsRepo.setPw(key, config.pw)
  return c.json({ ok: true })
}

/**
 * POST /api/auth/username { username, code }: a new sign-in name (the authenticator code too). This browser stays signed
 * in; every other one signs in again with the new name.
 */
export async function changeUsername(c: Context) {
  if (!config) return c.json({ error: 'Auth is not configured on the server.' }, 503)
  const key = c.get('sessionKey' as never) as string | undefined
  if (!key) return c.json({ error: 'Not signed in' }, 401)
  const body = (await c.req.json().catch(() => null)) as { username?: unknown; code?: unknown } | null
  const next = typeof body?.username === 'string' ? body.username.trim() : ''
  if (!USERNAME_RE.test(next)) return c.json({ error: 'A username has 2–32 characters: letters, numbers, dot, dash or underscore.' }, 400)
  if (next === config.user) return c.json({ error: "That's already your username." }, 400)
  const code = checkCode(c, { code: body?.code })
  if (!code.ok) return codeError(c, code)
  settingsRepo.set(USER_KEY, JSON.stringify({ user: next, over: config.envUser, at: Date.now() }))
  config.user = next
  sessionsRepo.clearOthers(key)
  sessionsRepo.setUser(key, next)
  return c.json({ user: next })
}

/** Sign out every browser (e.g. after a lost phone). */
export async function logoutEverywhere(c: Context) {
  sessionsRepo.clear()
  deleteCookie(c, COOKIE, { path: '/', secure: config?.secure })
  return c.json({ ok: true })
}

export async function me(c: Context) {
  const s = await readSessionLevel(c)
  if (!s) return c.json({ error: 'Not signed in' }, 401)
  const t = twoFactor()
  return c.json({
    user: s.user,
    ...(s.level === 'full' ? { avatar: avatarSource() } : {}),
    ...(s.level === 'setup' ? { needs2fa: 'setup' } : {}),
    twoFactor: t ? { enrolled: true, enrolledAt: t.enrolledAt, recoveryLeft: t.recovery.length } : { enrolled: false },
  })
}

/** Guards every /api route except the public auth endpoints. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const path = c.req.path
  if (path === '/api/auth/login' || path === '/api/auth/login/code' || path === '/api/auth/me' || path === '/api/auth/logout') return next()
  // the office's name and logo: the sign-in page shows them (read only; changing them needs a session)
  if (c.req.method === 'GET' && (path === '/api/branding' || path === '/api/branding/logo' || path === '/api/branding/manifest' || /^\/api\/branding\/icon\/[\w-]+$/.test(path))) return next()
  if (!config) return c.json({ error: 'Auth is not configured on the server.' }, 503)
  const s = await readSessionLevel(c)
  if (!s) return c.json({ error: 'Not signed in' }, 401)
  // signed in with the password only: nothing but setting up 2FA
  if (s.level === 'setup' && path !== '/api/auth/2fa/setup' && path !== '/api/auth/2fa/enable')
    return c.json({ error: 'Set up two-factor sign-in first.', needs2fa: 'setup' }, 403)
  c.set('user' as never, s.user as never)
  return next()
}

/**
 * CSRF guard for state-changing requests:
 * - the body must be JSON (exactly `application/json`, which a cross-site form or no-cors fetch can't send);
 * - a browser request must come from this very origin (Origin / Sec-Fetch-Site), not a sibling subdomain.
 * Together with the SameSite=Strict session cookie.
 * The one exception is a chat attachment (POST …/uploads): raw bytes (`application/octet-stream`) with the file name in
 * `X-File-Name`. Neither that type nor a custom header can be sent cross-site without a CORS preflight, which this
 * server never allows, and the origin checks below still apply.
 */
export const requireJsonForWrites: MiddlewareHandler = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next()
  const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
  const upload = type === 'application/octet-stream' && c.req.method === 'POST' && /^\/api\/agents\/[^/]+\/uploads$/.test(c.req.path) && !!c.req.header('x-file-name')
  if (type !== 'application/json' && !upload) return c.json({ error: 'Expected application/json' }, 415)
  const site = c.req.header('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'Cross-site request refused' }, 403)
  const origin = c.req.header('origin')
  if (origin) {
    let same = false
    try {
      same = sameOrigin(origin, c.req.header('host'))
    } catch {
      // "null" or garbage
    }
    if (!same) return c.json({ error: 'Cross-site request refused' }, 403)
  }
  return next()
}

/**
 * Claude Code hooks, the statusline and the manager's MCP calls authenticate as one agent: X-AO-Agent names it, and
 * the bearer token must be that agent's own token (HMAC of HOOK_TOKEN and its id, see agents/env.ts).
 */
export const requireHookToken: MiddlewareHandler = async (c, next) => {
  if (!process.env.HOOK_TOKEN) return c.json({ error: 'HOOK_TOKEN is not set' }, 503)
  const agentId = c.req.header('x-ao-agent') ?? ''
  const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(agentId ? agentToken(agentId) : '')
  if (!agentId || a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'Unauthorized' }, 401)
  return next()
}
