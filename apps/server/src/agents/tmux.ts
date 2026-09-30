// Thin, injection-safe wrapper around the tmux CLI. Arguments are passed as an argv array (never through a shell),
// and free text is delivered through a paste buffer instead of `send-keys`.

import { homedir } from 'node:os'
import { agentEnv, agentMayHave, TMUX_SOCKET_ARGS } from './env'

const TMUX = process.env.TMUX_BIN ?? 'tmux'

/** argv for a tmux command on the agents' server. */
export const tmuxCmd = (...args: string[]) => [TMUX, ...TMUX_SOCKET_ARGS, ...args]

async function run(args: string[], stdin?: string) {
  // the allowlisted environment: if this call starts the tmux server, the server (and every agent) inherits it
  // run from the home folder: a call that starts the tmux server gives it this working directory, and a server whose
  // directory went away (the dashboard's checkout on an external drive that was remounted) starts every new pane in a
  // "deleted" directory, so each agent's Claude Code exits right away
  const proc = Bun.spawn(tmuxCmd(...args), { cwd: homedir(), stdin: stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', env: agentEnv() })
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin)
    proc.stdin.end()
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

async function must(args: string[], stdin?: string) {
  const r = await run(args, stdin)
  if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.err.trim() || r.code}`)
  return r.out
}

export const tmux = {
  async available() {
    return (await run(['-V'])).code === 0
  },

  async hasSession(name: string) {
    return (await run(['has-session', '-t', `=${name}`])).code === 0
  },

  async listSessions(): Promise<string[]> {
    const r = await run(['list-sessions', '-F', '#{session_name}'])
    if (r.code !== 0) return [] // "no server running" means no sessions
    return r.out.split('\n').filter(Boolean)
  },

  async newSession(opts: { name: string; cwd: string; env: Record<string, string>; command: string[] }) {
    const env = Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    // wide pane so the TUI doesn't wrap; the browser terminal resizes it later
    await must(['new-session', '-d', '-s', opts.name, '-x', '200', '-y', '50', '-c', opts.cwd, ...env, ...opts.command])
    await this.tidy(opts.name)
    await this.harden()
  },

  /** Hide tmux's own status bar so the browser terminal looks exactly like Claude Code. */
  async tidy(name: string) {
    await run(['set-option', '-t', `=${name}:`, 'status', 'off'])
  },

  /**
   * Back to the default size after a browser detaches (attaching resizes the window to the browser). Reading dialogs
   * from the screen relies on a wide pane, so labels aren't truncated.
   */
  async resetSize(name: string) {
    await run(['resize-window', '-t', `=${name}:`, '-x', '200', '-y', '50'])
    // resize-window pins window-size to "manual"; with no client attached "latest" keeps 200x50 until the next attach
    await run(['set-option', '-w', '-t', `=${name}:`, 'window-size', 'latest'])
  },

  /**
   * The browser terminal is an attached tmux client: with a prefix key it could open tmux's command prompt and run
   * shell commands outside Claude Code. Agents' tmux server has no prefix (and so no key bindings to reach it).
   */
  async harden() {
    await run(['set-option', '-g', 'prefix', 'None'])
    await run(['set-option', '-g', 'prefix2', 'None'])
  },

  /** One variable of a session's environment (null when unset or no session). */
  async sessionEnv(name: string, key: string) {
    const r = await run(['show-environment', '-t', `=${name}`, key])
    if (r.code !== 0) return null
    const line = r.out.trim()
    return line.startsWith(`${key}=`) ? line.slice(key.length + 1) : null
  },

  /** Drop anything but the allowed variables from the server's global environment (inherited by new sessions). */
  async scrubGlobalEnv() {
    const r = await run(['show-environment', '-g'])
    if (r.code !== 0) return
    for (const line of r.out.split('\n')) {
      const name = line.replace(/^-/, '').split('=')[0]
      if (name && !agentMayHave(name)) await run(['set-environment', '-g', '-u', name])
    }
  },

  /**
   * Can this tmux server start a working session? A server whose own working directory went away starts every pane in
   * a "deleted" directory, and each agent's Claude Code exits at once. A throwaway session tells.
   */
  async canStartSessions() {
    const name = `_ao_probe_${process.pid}_${Date.now()}`
    const r = await run(['new-session', '-d', '-s', name, '/bin/sh', '-c', '/bin/pwd -P >/dev/null 2>&1 && sleep 5'])
    if (r.code !== 0) return false
    await Bun.sleep(400)
    const alive = await this.hasSession(name)
    await this.killSession(name)
    return alive
  },

  /** Stop the agents' tmux server and every session in it (a new one starts with the next session). */
  async killServer() {
    await run(['kill-server'])
  },

  async killSession(name: string) {
    await run(['kill-session', '-t', `=${name}`])
  },

  /** Named keys only (Enter, Escape, BTab, Down, digits). Never pass user text here. */
  async keys(name: string, ...keys: string[]) {
    await must(['send-keys', '-t', `=${name}:`, ...keys])
  },

  /** Types arbitrary text into the pane without interpreting it, then optionally presses Enter. */
  async paste(name: string, text: string, submit = true) {
    const buffer = `ao-${crypto.randomUUID()}`
    await must(['load-buffer', '-b', buffer, '-'], text)
    await must(['paste-buffer', '-d', '-p', '-b', buffer, '-t', `=${name}:`])
    if (submit) {
      await Bun.sleep(150)
      await this.keys(name, 'Enter')
    }
  },

  /** Plain-text snapshot of the visible pane (plus `history` lines of scrollback). */
  async capture(name: string, history = 0) {
    return must(['capture-pane', '-p', '-t', `=${name}:`, ...(history ? ['-S', `-${history}`] : [])])
  },
}
