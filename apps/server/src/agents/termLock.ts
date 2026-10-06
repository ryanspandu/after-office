import type { Context, MiddlewareHandler } from 'hono'

// Terminals (an agent's Claude Code session, a folder's shell) are keys straight into the server. Being signed in is
// not enough: the authenticator code typed just now unlocks them for this browser session, for a while after the last
// time one was opened. Signing out (or the session ending) ends it too.

const TTL_MS = 30 * 60_000
const unlocked = new Map<string, number>()

const sessionOf = (c: Context) => c.get('sessionKey' as never) as string | undefined

/** Until when this session's terminals are open (0: locked). */
export function terminalsOpenUntil(c: Context) {
  const key = sessionOf(c)
  const until = key ? (unlocked.get(key) ?? 0) : 0
  if (until && until <= Date.now()) unlocked.delete(key!)
  return until > Date.now() ? until : 0
}

/** The code was checked: this session's terminals open (again) for a while. */
export function unlockTerminals(c: Context) {
  const key = sessionOf(c)
  if (!key) return 0
  // a few minutes' worth of other sessions' leftovers go when one unlocks
  for (const [k, until] of unlocked) if (until <= Date.now()) unlocked.delete(k)
  const until = Date.now() + TTL_MS
  unlocked.set(key, until)
  return until
}

/** Lock them again now (the navbar's padlock): the code is asked for next time. Terminals still running keep running. */
export function lockTerminals(c: Context) {
  const key = sessionOf(c)
  if (key) unlocked.delete(key)
}

/** A terminal connection: only for a session that unlocked them; opening one keeps them open a while longer. */
export const requireUnlockedTerminal: MiddlewareHandler = async (c, next) => {
  if (!terminalsOpenUntil(c)) return c.json({ error: 'Enter the code from your authenticator app to open a terminal', locked: true }, 403)
  unlockTerminals(c)
  return next()
}
