// Create or change the dashboard login.
//
//   bun run auth:setup                 # asks for username + password
//   bun run auth:setup admin           # asks for the password only
//
// Writes OFFICE_USER, OFFICE_PASSWORD_HASH (argon2id) and, if missing, SESSION_SECRET + HOOK_TOKEN to
// apps/server/.env (or OFFICE_ENV_FILE, e.g. /etc/after-office.env on the VPS, run as root). The file is made
// readable by its owner only. A new password signs every browser out.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const ENV = resolve(process.env.OFFICE_ENV_FILE ?? resolve(import.meta.dir, '../.env'))

const username = (process.argv[2] ?? prompt('Username:') ?? '').trim()
if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
  console.error('Username must be 2–32 characters: letters, numbers, dot, dash or underscore.')
  process.exit(1)
}
/** prompt() without echoing what is typed (stty), so the password isn't left on screen. */
function promptHidden(question: string) {
  const tty = process.stdin.isTTY
  if (tty) Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' })
  try {
    return prompt(question)
  } finally {
    if (tty) {
      Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' })
      process.stdout.write('\n')
    }
  }
}

const password = process.env.OFFICE_NEW_PASSWORD ?? promptHidden('Password (min 12 chars):') ?? ''
if (password.length < 12) {
  console.error('Password must be at least 12 characters.')
  process.exit(1)
}

const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
const lines = existsSync(ENV) ? readFileSync(ENV, 'utf8').split('\n') : []
const env = new Map<string, string>()
for (const l of lines) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env.set(m[1], m[2])
}

const set = (key: string, value: string) => {
  const line = `${key}=${value}`
  const i = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (i >= 0) lines[i] = line
  else lines.push(line)
}

set('OFFICE_USER', username)
// base64 so the `$` signs in the argon2 hash survive .env variable expansion
set('OFFICE_PASSWORD_HASH', `b64:${Buffer.from(hash).toString('base64')}`)
if (!env.get('SESSION_SECRET')) set('SESSION_SECRET', randomBytes(32).toString('hex'))
if (!env.get('HOOK_TOKEN')) set('HOOK_TOKEN', randomBytes(24).toString('hex'))

writeFileSync(ENV, lines.filter((l, i) => l || i < lines.length - 1).join('\n') + '\n', { mode: 0o600 })
// mode only applies to a new file: an existing one (e.g. copied from .env.example) is tightened here
chmodSync(ENV, 0o600)
console.log(`Saved login for "${username}" to ${ENV}. Restart the server to apply.`)
