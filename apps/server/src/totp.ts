import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Time-based one-time codes (RFC 6238), the 6-digit codes of Google Authenticator and the like: HMAC-SHA1 over the
// 30-second step, no dependency. And the small crypto around them: the secret is kept encrypted (AES-256-GCM, key
// from SESSION_SECRET), recovery codes only as hashes.

export const STEP_SECONDS = 30
const DIGITS = 6
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Uint8Array) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error('Not base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret: 20 random bytes (160 bits, what RFC 4226 recommends), base32. */
export const newSecret = () => base32Encode(randomBytes(20))

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS)

/** The code for one step. */
export function codeAt(secret: string, step: number) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const off = mac[mac.length - 1] & 15
  const n = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0')
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * The step a code matches (this one, or one step either side for a phone's clock that is a little off), or null. Steps
 * at or before `after` don't count: a code works once.
 */
export function matchStep(secret: string, code: string, { now = Date.now(), after = -1 }: { now?: number; after?: number } = {}): number | null {
  const given = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const t = stepAt(now)
  let found: number | null = null
  // check every candidate (no early exit), so timing doesn't tell which one matched
  for (const step of [t - 1, t, t + 1]) if (same(codeAt(secret, step), given) && step > after && found === null) found = step
  return found
}

/** otpauth:// link for the QR code the phone scans. */
export function otpauthUrl(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}

// ── recovery codes ──
/** "abcd-efgh-ijkl": 12 letters/digits without look-alikes. */
export function newRecoveryCodes(n = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: n }, () => {
    const b = randomBytes(12)
    const s = Array.from(b, (x) => chars[x % chars.length]).join('')
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`
  })
}
export const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '')
export const hashRecovery = (code: string) => createHash('sha256').update(`ao-recovery:${normalizeRecovery(code)}`).digest('hex')

// ── the secret at rest ──
const keyFrom = (secret: string) => createHash('sha256').update(`ao-2fa:${secret}`).digest()

export function seal(plain: string, sessionSecret: string) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyFrom(sessionSecret), iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`
}

export function unseal(sealed: string, sessionSecret: string): string | null {
  try {
    if (!sealed.startsWith('v1:')) return null
    const raw = Buffer.from(sealed.slice(3), 'base64')
    const d = createDecipheriv('aes-256-gcm', keyFrom(sessionSecret), raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
