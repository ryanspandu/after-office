import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DATA_DIR, db } from './db'

// Daily backup of the SQLite file. `VACUUM INTO` writes a consistent, compacted copy while the server keeps running
// (WAL mode: readers and the writer don't block each other), then it is gzipped. The newest OFFICE_BACKUP_KEEP
// (default 14) are kept in OFFICE_BACKUP_DIR (default <data dir>/backups).
//
// Runs inside the server (checked hourly; one backup per day) and by hand: `bun run backup`.
// Restore: stop the service, `gunzip -c <file> > data/after-office.db`, delete data/after-office.db-wal and -shm,
// start the service.

export const BACKUP_DIR = resolve(process.env.OFFICE_BACKUP_DIR ?? resolve(DATA_DIR, 'backups'))
const KEEP = Math.max(1, Number(process.env.OFFICE_BACKUP_KEEP) || 14)
const NAME = /^after-office-(\d{4}-\d{2}-\d{2})-\d{6}\.db\.gz$/

/** 2026-09-27-081530 (UTC), sorts by time */
const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '')

function backups() {
  try {
    return readdirSync(BACKUP_DIR)
      .filter((f) => NAME.test(f))
      .sort()
  } catch {
    return []
  }
}

/** Write a backup now and prune old ones. Returns the file path. */
export async function backupNow() {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  chmodSync(BACKUP_DIR, 0o700)
  const base = resolve(BACKUP_DIR, `after-office-${stamp()}`)
  const tmp = `${base}.db`
  rmSync(tmp, { force: true })
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`)
  // sanity check before we trust (and keep) it
  const check = new Database(tmp, { readonly: true })
  const ok = check.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check === 'ok'
  check.close()
  if (!ok) {
    rmSync(tmp, { force: true })
    throw new Error('backup failed its integrity check')
  }
  const file = `${tmp}.gz`
  await Bun.write(file, Bun.gzipSync(await Bun.file(tmp).bytes()))
  chmodSync(file, 0o600)
  rmSync(tmp, { force: true })
  const all = backups()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(resolve(BACKUP_DIR, old), { force: true })
  return file
}

/** Once a day, in the server process. Also catches up right after start if the last backup is older than a day. */
export function startBackups() {
  if (process.env.OFFICE_BACKUP === 'false') return
  const due = () => {
    const last = backups().at(-1)
    if (!last) return true
    return Date.now() - statSync(resolve(BACKUP_DIR, last)).mtimeMs > 23.5 * 3_600_000
  }
  const run = () => {
    if (!due()) return
    backupNow()
      .then((f) => console.log(`[backup] ${f}`))
      .catch((e) => console.error('[backup] failed:', e.message))
  }
  setTimeout(run, 60_000) // not in the middle of startup
  setInterval(run, 3_600_000)
}

if (import.meta.main) console.log(await backupNow())
