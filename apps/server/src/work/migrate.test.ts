import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settingsRepo } from '../db'
import { seal, unseal } from '../totp'
import { AGENTS_DIR } from '../fsroots'

// Moving an office: export → import of the same file. The sealed values come back sealed with this server's key; the
// passphrase is checked before anything changes; the agents' folder is restored (the one there goes to the trash).

process.env.SESSION_SECRET ??= 'test-secret-'.padEnd(40, 'x')
const SECRET = process.env.SESSION_SECRET
const m = await import('./migrate')
let restarted = 0
m.afterImport.restart = () => void restarted++

const until = async (done: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

afterAll(() => rmSync(m.PENDING_DB, { force: true }))

test('export, then import the file back: secrets, folders and the database', async () => {
  settingsRepo.set('twoFactor', JSON.stringify({ secret: seal('JBSWY3DPEHPK3PXP', SECRET), lastStep: 0, recovery: [] }))
  mkdirSync(join(AGENTS_DIR, 'nara'), { recursive: true })
  writeFileSync(join(AGENTS_DIR, 'nara', 'CLAUDE.md'), '# Nara')
  mkdirSync(join(AGENTS_DIR, 'nara', 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(AGENTS_DIR, 'nara', 'node_modules', 'x', 'big.js'), 'skip me')

  expect(() => m.startExport({ passphrase: 'short' })).toThrow('8 characters')
  m.startExport({ passphrase: 'correct horse', folders: true, conversations: true })
  await until(() => !!m.migrateStatus()?.done)
  expect(m.migrateStatus()?.error).toBeUndefined()
  const file = m.exportPath()!
  expect(existsSync(file)).toBe(true)

  // here, after the export: changed, to see the import put things back
  writeFileSync(join(AGENTS_DIR, 'nara', 'CLAUDE.md'), '# changed')
  writeFileSync(join(AGENTS_DIR, 'stray.txt'), 'not in the export')

  const bytes = readFileSync(file)
  const send = () => {
    const { id, chunk } = m.startUpload()
    for (let at = 0; at < bytes.length; at += chunk) m.addChunk(id, at, bytes.subarray(at, at + chunk))
    return id
  }
  // a piece out of order is refused
  const bad = m.startUpload()
  expect(() => m.addChunk(bad.id, 5, new Uint8Array(3))).toThrow('Expected the piece at 0')

  // the wrong passphrase: refused before anything changes
  await expect(m.startImport({ id: send(), passphrase: 'wrong horse' })).rejects.toThrow("doesn't open")
  expect(existsSync(m.PENDING_DB)).toBe(false)

  await m.startImport({ id: send(), passphrase: 'correct horse' })
  await until(() => !!m.migrateStatus()?.done)
  expect(m.migrateStatus()?.error).toBeUndefined()
  expect(m.migrateStatus()?.restarting).toBe(true)

  // the database waiting for the restart: its 2FA secret opens with this server's key
  const next = new Database(m.PENDING_DB, { readonly: true })
  const row = next.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'twoFactor'").get()!
  next.close()
  expect(unseal(JSON.parse(row.value).secret, SECRET)).toBe('JBSWY3DPEHPK3PXP')

  // the folder as exported; what was there went to the trash; bulky folders left out
  expect(readFileSync(join(AGENTS_DIR, 'nara', 'CLAUDE.md'), 'utf8')).toBe('# Nara')
  expect(existsSync(join(AGENTS_DIR, 'stray.txt'))).toBe(false)
  expect(existsSync(join(AGENTS_DIR, 'nara', 'node_modules'))).toBe(false)
  await until(() => restarted === 1, 5000)
}, 60_000)
