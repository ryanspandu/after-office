import type { MiddlewareHandler } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { WSEvents } from 'hono/ws'
import { agentsRepo, sideSessionsRepo } from '../db'
import { agentEnv } from './env'
import { sameOrigin } from '../auth'
import { tmux, tmuxCmd } from './tmux'

// Browser terminal: a WebSocket bridged to `tmux attach` running in a Bun PTY (Bun.Terminal).
// The browser sees and types into the exact Claude Code TUI.
//
// Protocol: client → server text frames `{"t":"in","d":"…"}` / `{"t":"resize","cols":N,"rows":N}`;
// server → client binary frames with raw terminal output.

/** Refuse cross-site WebSocket handshakes: the session cookie alone must not open a terminal. */
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
  let ok = false
  try {
    ok = !!origin && sameOrigin(origin, host)
  } catch {
    // "null" or garbage
  }
  if (!ok) return c.json({ error: 'Bad origin' }, 403)
  if (!agentsRepo.get(c.req.param('id') ?? '')) return c.json({ error: 'No such agent' }, 404)
  return next()
}

/** Same-origin only (a folder's terminal: no agent in the address). */
export const requireSameOriginOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
  let ok = false
  try {
    ok = !!origin && sameOrigin(origin, host)
  } catch {
    // "null" or garbage
  }
  if (!ok) return c.json({ error: 'Bad origin' }, 403)
  return next()
}

/** The browser side of a folder's shell (work/shells.ts): only one that is running (it's opened with the code). */
export const shellSocket = upgradeWebSocket((c) => bridge(c.get('shellTarget' as never) as string))

type Msg = { t: 'in'; d: string } | { t: 'resize'; cols: number; rows: number }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number(n) || lo)))

export const terminalSocket = upgradeWebSocket((c) => {
  const row = agentsRepo.get(c.req.param('id') ?? '')!
  // ?session=s2: one of its side sessions (an unknown or closed one: its main session)
  const side = /^s\d{1,4}$/.test(c.req.query('session') ?? '') ? sideSessionsRepo.get(row.id, c.req.query('session')!) : null
  return bridge(side && !side.closed_at ? side.tmux_session : row.tmux_session)
})

/** A browser terminal attached to the tmux session `target` (an agent's, or a folder's shell: work/shells.ts). */
export function bridge(target: string): WSEvents {
  let term: InstanceType<typeof Bun.Terminal> | null = null
  let proc: ReturnType<typeof Bun.spawn> | null = null

  return {
    onMessage(event, ws) {
      let msg: Msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg.t === 'resize') {
        const cols = clamp(msg.cols, 20, 400)
        const rows = clamp(msg.rows, 5, 200)
        if (term) return term.resize(cols, rows)
        // first resize = the browser is ready; attach now at its size
        term = new Bun.Terminal({
          cols,
          rows,
          name: 'xterm-256color',
          data: (_t, data) => ws.send(data),
        })
        // agentEnv has no TMUX (attaching from inside another tmux would refuse) and none of the server's secrets
        const env = { ...agentEnv(), TERM: 'xterm-256color' }
        proc = Bun.spawn(tmuxCmd('attach-session', '-t', `=${target}`), { terminal: term, env })
        proc.exited.then(() => {
          try {
            ws.close(1000, 'Session ended')
          } catch {
            // already closed
          }
        })
      } else if (msg.t === 'in' && term && typeof msg.d === 'string') {
        term.write(msg.d)
      }
    },
    onClose() {
      // detaching (killing the attach client) leaves the tmux session and Claude running
      proc?.kill()
      term?.close()
      void (proc?.exited ?? Promise.resolve()).then(() => tmux.resetSize(target))
    },
  }
}
