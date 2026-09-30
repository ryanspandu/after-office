import { createHmac } from 'node:crypto'

// What agent sessions may see of the server. The server's environment holds the dashboard's secrets (SESSION_SECRET,
// the password hash, HOOK_TOKEN, notification tokens), and an agent that is talked into running `env` must not get
// them. Every tmux call (and so the tmux server and every session it starts) gets this allowlisted environment.

// DOCKER_HOST: the agents' own rootless Docker (setup-vps.sh --containers); MISE_*: per-project runtime versions;
// ANDROID_HOME / JAVA_HOME: Android builds (--android)
const ALLOWED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TMPDIR|TZ|XDG_[A-Z_]+|EDITOR|VISUAL|CLAUDE_CONFIG_DIR|BUN_INSTALL|NVM_DIR|DOCKER_HOST|MISE_[A-Z_]+|ANDROID_HOME|JAVA_HOME)$/

/** Extra variables to pass through, comma separated (e.g. SSH_AUTH_SOCK so local agents can push with your key). */
const EXTRA = new Set((process.env.OFFICE_AGENT_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean))

export function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (ALLOWED.test(k) || EXTRA.has(k)) env[k] = v
  }
  // agents use the Claude subscription login; an API key would take precedence and bill the API instead
  if (process.env.OFFICE_ALLOW_API_KEY === 'true') {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (process.env[k]) env[k] = process.env[k]!
  }
  return env
}

/** Is this variable one an agent may have? (Used to clean a tmux server's global environment.) */
export const agentMayHave = (name: string) => ALLOWED.test(name) || EXTRA.has(name) || (process.env.OFFICE_ALLOW_API_KEY === 'true' && name.startsWith('ANTHROPIC_'))

/**
 * Agents live on their own tmux server, never the owner's default one:
 * - OFFICE_TMUX_SOCKET=/run/after-office/tmux.sock: a server run by a separate agent user (deploy/, the VPS setup);
 * - otherwise `tmux -L after-office` (a private server of the current user).
 */
export const TMUX_SOCKET_ARGS = process.env.OFFICE_TMUX_SOCKET ? ['-S', process.env.OFFICE_TMUX_SOCKET] : ['-L', process.env.OFFICE_TMUX_NAME ?? 'after-office']

/** True when agents run as another Unix user on a shared tmux socket (the hardened VPS setup). */
export const ISOLATED = !!process.env.OFFICE_TMUX_SOCKET

/**
 * Each agent's own hook/MCP token: HMAC(HOOK_TOKEN, agentId). An agent can only speak for itself; it cannot claim
 * to be another agent (or the manager) with the token it was given.
 */
export function agentToken(agentId: string) {
  const secret = process.env.HOOK_TOKEN
  if (!secret) return ''
  return createHmac('sha256', secret).update(`agent:${agentId}`).digest('base64url')
}
