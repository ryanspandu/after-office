import { expect, test } from 'bun:test'
import { base32Decode, base32Encode, codeAt, hashRecovery, matchStep, newRecoveryCodes, newSecret, otpauthUrl, seal, unseal } from './totp'

// The authenticator codes (RFC 6238) and the small crypto around them.

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

test('RFC 6238 test vectors (SHA1, last 6 digits)', () => {
  const at = (sec: number) => codeAt(RFC_SECRET, Math.floor(sec / 30))
  expect(at(59)).toBe('287082')
  expect(at(1111111109)).toBe('081804')
  expect(at(1111111111)).toBe('050471')
  expect(at(1234567890)).toBe('005924')
  expect(at(2000000000)).toBe('279037')
})

test('base32 round trip', () => {
  expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  const s = newSecret()
  expect(s).toMatch(/^[A-Z2-7]{32}$/)
  expect(base32Encode(base32Decode(s))).toBe(s)
  expect(base32Decode('gezd gnbv')).toEqual(base32Decode('GEZDGNBV'))
})

test('a code matches its step, one either side, and only once', () => {
  const now = 1_700_000_000_000
  const step = Math.floor(now / 30_000)
  expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step), { now })).toBe(step)
  expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step - 1), { now })).toBe(step - 1)
  expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step + 1), { now })).toBe(step + 1)
  expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step - 2), { now })).toBeNull()
  // already used this step: refused
  expect(matchStep(RFC_SECRET, codeAt(RFC_SECRET, step), { now, after: step })).toBeNull()
  expect(matchStep(RFC_SECRET, 'abcdef', { now })).toBeNull()
  expect(matchStep(RFC_SECRET, '12345', { now })).toBeNull()
})

test('otpauth link, recovery codes, the secret at rest', () => {
  expect(otpauthUrl('ABC', 'owner', 'After Office')).toBe('otpauth://totp/After%20Office%3Aowner?secret=ABC&issuer=After%20Office&algorithm=SHA1&digits=6&period=30')
  const codes = newRecoveryCodes()
  expect(codes).toHaveLength(8)
  for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
  expect(hashRecovery(codes[0])).toBe(hashRecovery(codes[0].toUpperCase().replace(/-/g, ' ')))
  const sealed = seal('SECRET', 'k'.repeat(40))
  expect(sealed).not.toContain('SECRET')
  expect(unseal(sealed, 'k'.repeat(40))).toBe('SECRET')
  expect(unseal(sealed, 'x'.repeat(40))).toBeNull()
})
