import { existsSync } from 'node:fs'
import { agentsRepo, settingsRepo, sideSessionsRepo } from '../db'
import { agentToken, ISOLATED, TMUX_SOCKET_ARGS } from './env'
import { AgentError } from './errors'
import { CLAUDE_CONFIG_DIR } from '../fsroots'
import { isImportsDialog, restartAgent, reviveAgent, tidySideSessions } from './manager'
import { addPending, pendingFor, resolvePending, runtimeOf, sideRuntimeOf, tickAll, updateRuntime, updateSideRuntime } from './registry'
import { tmux } from './tmux'
import { pollTranscripts } from './transcripts'

// Keeps the dashboard honest about sessions that die or survive server restarts. Runs on a timer; no LLM.

const AUTO_RESTART = process.env.OFFICE_AUTO_RESTART !== 'false'
const reviving = new Set<string>()
const tidied = new Set<string>()
/**
 * Managers whose session outlived a server restart. Claude Code drops an MCP server after a failed call (e.g. one made
 * while this server was down) and doesn't reconnect by itself, so the manager would lose its office tools: once it
 * is idle, it's restarted with --resume (same conversation, tools loaded fresh).
 */
const reconnectMcp = new Set<string>()

/**
 * Restart an agent's session (--resume, same conversation) once it's idle: for settings Claude Code only reads at
 * start, e.g. which connectors it may use.
 */
export const restartWhenIdle = (agentId: string) => void reconnectMcp.add(agentId)
/** Agents held by the startup imports dialog: nothing runs behind it, so once it's gone they are simply idle. */
const heldAtStart = new Set<string>()

/**
 * Restart the agents' tmux server (the dashboard's "Restart all agents"): every session stops and starts again with
 * --resume, so conversations continue. For a server that can't start sessions any more. Not on the hardened VPS: there
 * the server belongs to the agents' user and systemd (`sudo systemctl restart after-office-agents`).
 */
export async function restartAgentServer() {
  if (ISOLATED) throw new AgentError('On this server the agents run under their own service: run `sudo systemctl restart after-office-agents`', 409)
  await tmux.killServer()
  reviving.clear()
  const rows = agentsRepo.all()
  for (const row of rows) {
    updateRuntime(row.id, (r) => ({ ...r, status: 'offline', waitingFor: undefined, tool: undefined }))
    reviving.add(row.id)
    await reviveAgent(row)
      .catch((e) => console.error(`[tmux] could not restart ${row.name}:`, e))
      .finally(() => setTimeout(() => reviving.delete(row.id), 60_000))
  }
  console.log(`[tmux] restarted the agents' tmux server (${rows.length} agent(s) resuming)`)
  return rows.length
}

/** An import is replacing the office (work/migrate.ts): no reviving the agents being stopped until the restart. */
export const revivePause = { on: false }

export async function reconcile() {
  if (revivePause.on) return
  const alive = new Set(await tmux.listSessions())
  const { starting } = await import('./manager')
  for (const row of agentsRepo.all()) {
    // being created: its session is on its way (starting it here too would make that fail)
    if (starting.has(row.id)) continue
    const rt = runtimeOf(row.id)
    if (alive.has(row.tmux_session)) {
      if (!tidied.has(row.tmux_session)) {
        tidied.add(row.tmux_session)
        void tmux.tidy(row.tmux_session) // sessions started before this server version
      }
      // survived a server restart but hasn't reported yet: it's there, just quiet
      if (rt.status === 'offline' && Date.now() - rt.lastEventAt > 20_000) updateRuntime(row.id, (r) => ({ ...r, status: 'idle' }))
      await adoptScreenDialog(row.id, row.tmux_session).catch(() => {})
      if (reconnectMcp.has(row.id) && rt.status === 'idle') {
        reconnectMcp.delete(row.id)
        console.log(`[tmux] restarting ${row.name} (resume) to load its tools and settings`)
        await restartAgent(row.id).catch((e) => console.error(`[tmux] could not restart ${row.name}:`, e.message))
      }
      continue
    }
    if (rt.status !== 'offline') updateRuntime(row.id, (r) => ({ ...r, status: 'offline', waitingFor: undefined, tool: undefined }))
    if (AUTO_RESTART && !reviving.has(row.id)) {
      reviving.add(row.id)
      reviveAgent(row)
        .catch((e) => console.error(`[reconcile] could not restart ${row.name}:`, e))
        .finally(() => setTimeout(() => reviving.delete(row.id), 60_000))
    }
  }
  // side sessions: one whose process is gone is closed (not brought back: each one costs memory); one that survived a
  // server restart but hasn't reported yet is there, just quiet
  await tidySideSessions()
  for (const side of sideSessionsRepo.open()) {
    if (!alive.has(side.tmux_session)) continue
    const srt = sideRuntimeOf(side.agent_id, side.key)
    if (srt.status === 'offline' && Date.now() - side.created_at > 20_000 && Date.now() - srt.lastEventAt > 20_000) updateSideRuntime(side.agent_id, side.key, (r) => ({ ...r, status: 'idle' }))
  }
}

/**
 * A permission dialog on screen that the dashboard doesn't know about: its hook request was lost (server restart)
 * or ran out of time. Show it as a follow-up anyway; answering it presses the dialog's keys (ingest.decide).
 */
async function adoptScreenDialog(agentId: string, session: string) {
  const screen = await tmux.capture(session)
  const lines = screen.split('\n').filter((l) => l.trim())
  // a real dialog: the question near the bottom of the screen, followed by Claude Code's numbered choices with the
  // selection marker. Plain text an agent prints ("Do you want to proceed?") doesn't count.
  // "Do you want to proceed?" (commands), "Do you want to create x?" / "… make this edit to x?" (files), …
  const q = lines.findLastIndex((l) => /^\s*do you want to .+\?\s*$/i.test(l))
  const choices = q === -1 ? [] : lines.slice(q + 1, q + 6)
  const ask = q !== -1 && q >= lines.length - 12 && choices.some((l) => /^\s*❯\s*1\.\s/.test(l)) && choices.some((l) => /^\s*\d\.\s+No\b/.test(l)) ? q : -1
  const adoptedId = `screen-${agentId}`
  const imports = isImportsDialog(screen)
  if (ask === -1 && !imports) {
    // answered in the terminal (or by keys): drop our copy
    if (pendingFor(agentId).some((f) => f.id === adoptedId)) resolvePending(adoptedId)
    // no hook reports a dialog answered before the first prompt, so the agent would stay "waiting" and its queue
    // (e.g. the manager's first task for a new hire) would never be sent
    if (heldAtStart.delete(agentId) && runtimeOf(agentId).status === 'waiting' && !pendingFor(agentId).length) {
      updateRuntime(agentId, (r) => ({ ...r, status: 'idle', waitingFor: undefined }))
      void import('../work/work').then((w) => w.drainQueues()).catch(() => {})
    }
    return
  }
  if (imports) heldAtStart.add(agentId)
  // the dashboard already shows it (held or timed-out hook request). Only the main session's prompts count: a delegation,
  // a daily job or a side session's prompt waiting for the owner isn't this dialog
  if (pendingFor(agentId).some((f) => !f.sessionKey && ['permission', 'question', 'plan'].includes(f.kind))) return
  if (imports) {
    heldAtStart.add(agentId)
    // shown when a session starts in a folder whose CLAUDE.md (or the account's) imports files from outside it
    addPending({
      id: adoptedId,
      agentId,
      kind: 'permission',
      tool: 'External CLAUDE.md imports',
      message: "Its CLAUDE.md imports files from outside its folder (e.g. from the account's Claude config). Allow them?",
      input: { screen: lines.slice(-14).join('\n') },
      createdAt: Date.now(),
    })
    updateRuntime(agentId, (r) => ({ ...r, status: 'waiting', waitingFor: 'permission' }))
    return
  }
  // the dialog body sits between the last horizontal rule and the question
  const rule = lines.slice(0, ask).findLastIndex((l) => /^\s*─{10,}/.test(l))
  // drop the dialog's own separator lines (╌╌╌ around a file preview)
  const body = lines
    .slice(rule + 1, ask)
    .map((l) => l.trim())
    .filter((l) => l && !/^[\s─╌━═┄┈-]+$/.test(l))
  const tool = body[0] ?? 'Permission'
  addPending({
    id: adoptedId,
    agentId,
    kind: 'permission',
    tool,
    message: body.slice(1, 3).join(' · ') || tool,
    input: { screen: body.join('\n') },
    createdAt: Date.now(),
  })
  updateRuntime(agentId, (r) => ({ ...r, status: 'waiting', waitingFor: 'permission' }))
}

/**
 * Agents moved to their own tmux server (TMUX_SOCKET_ARGS). Sessions still on the previous server (the owner's
 * default one, whose environment may hold the dashboard's secrets) are stopped once; reconcile() then starts them
 * again on the new server with --resume, so conversations continue.
 */
async function moveToAgentServer() {
  const current = JSON.stringify(TMUX_SOCKET_ARGS)
  const previous = settingsRepo.get('tmuxServer')
  if (previous !== current) {
    const oldArgs = previous ? (JSON.parse(previous) as string[]) : []
    const bin = process.env.TMUX_BIN ?? 'tmux'
    let moved = 0
    for (const row of agentsRepo.all()) {
      const r = Bun.spawnSync([bin, ...oldArgs, 'kill-session', '-t', `=${row.tmux_session}`])
      if (r.exitCode === 0) moved++
    }
    if (moved) console.log(`[tmux] moved ${moved} agent session(s) to the agents' own tmux server; they resume shortly`)
    settingsRepo.set('tmuxServer', current)
  }
  await tmux.scrubGlobalEnv()
  await tmux.harden()
  // sessions started with an older token (e.g. the shared one, before tokens were per agent) can't report in:
  // restart them (with --resume, so the conversation continues)
  for (const row of agentsRepo.all()) {
    const token = await tmux.sessionEnv(row.tmux_session, 'AO_HOOK_TOKEN')
    if (token === null) continue // no session
    if (row.kind === 'manager') reconnectMcp.add(row.id)
    // sessions started with an older token, or another Claude account's folder (OFFICE_CLAUDE_CONFIG_DIR changed)
    const configDir = (await tmux.sessionEnv(row.tmux_session, 'CLAUDE_CONFIG_DIR')) ?? null
    const why = token !== agentToken(row.id) ? 'its own token' : configDir !== CLAUDE_CONFIG_DIR ? `Claude config ${CLAUDE_CONFIG_DIR ?? '~/.claude'}` : null
    if (!why) continue
    reconnectMcp.delete(row.id)
    console.log(`[tmux] restarting ${row.name} with ${why}`)
    await restartAgent(row.id).catch((e) => console.error(`[tmux] could not restart ${row.name}:`, e.message))
  }
}

export function startBackgroundJobs() {
  const safe = (fn: () => unknown) => () => {
    try {
      const r = fn()
      if (r instanceof Promise) r.catch((e) => console.error('[jobs]', e))
    } catch (e) {
      console.error('[jobs]', e)
    }
  }
  setInterval(safe(pollTranscripts), 2_000)
  // the account's connectors: listed soon after start (so new agents get their rules right away), then every 30 min
  const connectors = () => import('./connectors').then((m) => m.listConnectors({ fresh: true }))
  setTimeout(safe(connectors), 15_000)
  setInterval(safe(connectors), 30 * 60_000)
  setInterval(safe(() => tickAll()), 30_000)
  // the office's hooks in every agent's folder: put back (and reported) if an agent changed them
  setInterval(safe(checkHooks), 60_000)
  // chat attachments never sent (page closed mid-message): cleared after a day
  const sweep = () => import('./uploads').then((m) => m.sweepStaged())
  setTimeout(safe(sweep), 60_000)
  setInterval(safe(sweep), 60 * 60_000)
  void moveToAgentServer()
    .catch((e) => console.error('[tmux]', e))
    .finally(() => {
      setInterval(safe(reconcile), 5_000)
      safe(reconcile)()
    })
}

/**
 * Every agent's hooks still in place? They feed the Activity log, the connector gate and the permission prompts. If an
 * agent changed them (its own .claude files), they're put back, its session restarts when idle (to load them), and
 * the owner is told. The Activity log keeps a line about it.
 */
export async function checkHooks() {
  const { hooksTampered, restoreHooks } = await import('./manager')
  const { applyConnectors } = await import('./connectors')
  const { logSystem } = await import('../work/activity')
  const { notify } = await import('../notify')
  for (const row of agentsRepo.all()) {
    if (!existsSync(row.cwd)) continue
    const why = hooksTampered(row.cwd)
    if (!why) continue
    // only a hook event newer than the agent's settings is missing: an upgrade, not tampering
    if (!hooksTampered(row.cwd, { ignoreNewer: true })) {
      try {
        restoreHooks(row.cwd)
        restartWhenIdle(row.id)
      } catch (e) {
        console.warn(`[hooks] could not update ${row.name}:`, e instanceof Error ? e.message : e)
      }
      continue
    }
    try {
      restoreHooks(row.cwd)
      applyConnectors(row)
      restartWhenIdle(row.id)
      logSystem(row.id, `Hooks put back: ${why}. Tool calls in between may be missing from this log.`)
      void notify('security', `${row.name}'s hooks were changed`, `${why}. After Office put them back; the session restarts when idle.`)
      console.warn(`[hooks] ${row.name}: ${why}; restored`)
    } catch (e) {
      console.error(`[hooks] could not restore ${row.name}:`, e instanceof Error ? e.message : e)
    }
  }
}
