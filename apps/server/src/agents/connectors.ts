import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Connector, ConnectorTool } from '@after-office/shared'
import { agentsRepo, connectorsOf, connectorsReadAskOf, connectorsWriteOf, type AgentRow } from '../db'
import { AGENTS_DIR, CLAUDE_CONFIG_DIR } from '../fsroots'
import { runAsAgent } from './asagent'
import { AgentError } from './errors'
import { CLAUDE } from './manager'
import { restartWhenIdle } from './reconciler'
import { readInFolder, writeInFolder } from './safefs'

// Connectors: the MCP servers of the Claude account the agents run on (claude.ai connectors, plugins, servers added
// with `claude mcp add`). Every session of that account gets all of them, so each agent's own
// <folder>/.claude/settings.local.json denies the ones it may not use. New agents get none; the owner turns them on
// per agent. The list comes from `claude mcp list` with the account's config folder (OFFICE_CLAUDE_CONFIG_DIR),
// which this never writes to.

/** The manager's own office tools: never listed, never turned off. */
const OFFICE_SERVER = 'after-office'
const CACHE_MS = 5 * 60_000

/** How Claude Code names a server's tools: mcp__<name with anything but letters, digits, _ and - as _>__<tool>. */
export const toolPrefix = (name: string) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}`

const STATUS: [RegExp, Connector['status']][] = [
  [/connected/i, 'connected'],
  [/needs authentication/i, 'needs-auth'],
  [/failed/i, 'failed'],
  [/not configured/i, 'not-configured'],
]

/** One line of `claude mcp list`: "<name>: <url or command> [(HTTP)] - <status>". */
export function parseConnectorLine(line: string): Connector | null {
  const m = line.match(/^(.+?): (.*) - (.+)$/)
  if (!m) return null
  const name = m[1].trim()
  if (!name || name === OFFICE_SERVER) return null
  const target = m[2].trim()
  const statusText = m[3].trim()
  const status = STATUS.find(([re]) => re.test(statusText))?.[1] ?? 'unknown'
  let host: string | undefined
  const url = target.match(/https?:\/\/[^\s]+/)?.[0]
  if (url) {
    try {
      host = new URL(url).host // only the host: a query string can carry a token
    } catch {
      // not a URL after all
    }
  }
  const plugin = name.match(/^plugin:([^:]+):/)?.[1]
  const detail = status === 'failed' ? statusText.replace(/^✘\s*Failed to connect\s*[—-]?\s*/i, '').slice(0, 200) || undefined : undefined
  return {
    name,
    prefix: toolPrefix(name),
    source: name.startsWith('claude.ai ') ? 'claude.ai' : plugin ? 'plugin' : 'user',
    ...(plugin ? { plugin } : {}),
    ...(host ? { host } : {}),
    status,
    ...(detail ? { detail } : {}),
  }
}

export function parseConnectorList(out: string): Connector[] {
  const seen = new Set<string>()
  const list: Connector[] = []
  for (const line of out.split('\n')) {
    const c = parseConnectorLine(line.trim())
    if (!c || seen.has(c.prefix)) continue
    seen.add(c.prefix)
    list.push(c)
  }
  return list.sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected') || a.name.localeCompare(b.name))
}

let cache: { at: number; list: Connector[] } | null = null
let pending: Promise<Connector[]> | null = null

/** For tests: pretend the account has these connectors. */
export const setConnectorsForTest = (list: Connector[]) => void (cache = { at: Date.now(), list })

/**
 * The account's connectors (cached for 5 minutes: listing checks each one, which takes seconds). When new ones
 * appear, every agent with a chosen set gets them denied, so they stay off until the owner turns them on.
 */
export async function listConnectors({ fresh = false } = {}): Promise<{ list: Connector[]; checkedAt: number }> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return { list: cache.list, checkedAt: cache.at }
  pending ??= (async () => {
    try {
      const env = CLAUDE_CONFIG_DIR ? [`CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}`] : []
      const run = await runAsAgent(['env', ...env, CLAUDE, 'mcp', 'list'], { cwd: AGENTS_DIR, timeoutMs: 90_000, mergeStderr: true })
      const list = parseConnectorList(run.out)
      if (!list.length && (run.code !== 0 || run.timedOut)) throw new AgentError('Could not list the connectors (claude mcp list failed)', 500)
      const before = new Set(cache?.list.map((c) => c.prefix) ?? [])
      cache = { at: Date.now(), list }
      if (list.some((c) => !before.has(c.prefix))) await syncAll()
      // their tools too (which ones read and which write), in the background
      void listConnectorTools({ fresh }).catch((e) => console.warn('[connectors] tools:', e instanceof Error ? e.message : e))
      return list
    } finally {
      pending = null
    }
  })()
  const list = await pending
  return { list, checkedAt: cache?.at ?? Date.now() }
}

/** Known connectors without waiting (empty until the first listing finished). */
export const knownConnectors = () => cache?.list ?? []

const isConnectorRule = (rule: string, prefixes: string[]) => prefixes.some((p) => rule === p || rule.startsWith(`${p}__`))

/**
 * Write the agent's connector rules into <cwd>/.claude/settings.local.json: deny every known connector it may not
 * use. Other deny rules (the owner's own) and the rest of the file stay as they are. Returns whether it changed.
 */
export function applyConnectors(row: AgentRow, known: Connector[] = knownConnectors()): boolean {
  if (!known.length || !existsSync(row.cwd)) return false
  const allowed = connectorsOf(row)
  const prefixes = known.map((c) => c.prefix)
  const file = join(row.cwd, '.claude', 'settings.local.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readInFolder(row.cwd, file) ?? '')
    } catch {
      throw new AgentError(`${file} is not valid JSON; fix it before changing this agent's connectors`, 409)
    }
  }
  const permissions = (settings.permissions as Record<string, unknown>) ?? {}
  const before = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : []
  const own = before.filter((r) => typeof r === 'string' && !isConnectorRule(r, prefixes))
  const ours = allowed === null ? [] : prefixes.filter((p) => !allowed.includes(p))
  const deny = [...own, ...ours]
  if (JSON.stringify(deny) === JSON.stringify(before)) return false
  if (deny.length) permissions.deny = deny
  else delete permissions.deny
  if (Object.keys(permissions).length) settings.permissions = permissions
  else delete settings.permissions
  writeInFolder(row.cwd, file, JSON.stringify(settings, null, 2) + '\n')
  return true
}

/** Re-apply every agent's rules (e.g. a new connector appeared); sessions whose rules changed restart when idle. */
export async function syncAll() {
  for (const row of agentsRepo.all()) {
    try {
      if (applyConnectors(row)) restartWhenIdle(row.id)
    } catch (e) {
      console.warn(`[connectors] ${row.name}:`, e instanceof Error ? e.message : e)
    }
  }
}

/** The owner's choice for one agent: saved, written to its folder, and loaded at its next (idle) restart. */
export async function setAgentConnectors(id: string, allowed: string[], write?: string[], readAsk?: string[]) {
  const row = agentsRepo.get(id)
  if (!row) throw new AgentError('No such agent', 404)
  const { list } = await listConnectors()
  const known = new Set(list.map((c) => c.prefix))
  const unknown = allowed.filter((p) => !known.has(p))
  if (unknown.length) throw new AgentError(`Unknown connector: ${unknown.join(', ')}`, 400)
  agentsRepo.update(id, { connectors: JSON.stringify([...new Set(allowed)]) })
  // may write: only among the ones it may use (no restart needed: checked on every tool call, see writeGate)
  if (write) agentsRepo.update(id, { connectors_write: JSON.stringify([...new Set(write)].filter((p) => allowed.includes(p))) })
  if (readAsk) agentsRepo.update(id, { connectors_read_ask: JSON.stringify([...new Set(readAsk)].filter((p) => allowed.includes(p))) })
  if (applyConnectors(agentsRepo.get(id)!, list)) restartWhenIdle(id)
}

// ── read and write, per connector ──
// A connector turned on for an agent can read (Read, on by default) and not write (Write, off by default). A tool of a
// side that's off is turned into a permission prompt through the PreToolUse hook, so the owner approves it in "Needs
// your attention", even when the agent runs in Auto. A guard against an agent talked into sending or changing things
// (prompt injection). Which side a tool is on: what the connector says about it (MCP's readOnlyHint), or its name.

const WRITE_WORD = /(^|[_-])(send|create|update|delete|remove|post|publish|write|edit|modify|upload|move|copy|share|pause|resume|enable|disable|set|add|insert|reply|forward|archive|trash|label|mark|schedule|cancel|launch|approve|invite|submit|transfer|pay|buy|purchase|charge|refund|rename|import|patch|put|replace|restore|revoke|grant|assign|unassign|close|open|merge|comment|react|like|follow|unfollow|block|mute|boost|duplicate)([_-]|$)/i
const READ_WORD = /(^|[_-])(get|list|search|read|fetch|find|query|lookup|describe|view|show|count|check|download|export|retrieve|browse|preview|summari[sz]e|inspect|stat|status|info|whoami|me)([_-]|$)/i

/** Does this connector tool only read, by its name? (Unsure counts as a write: the owner is asked.) */
export function isReadOnlyTool(tool: string) {
  if (WRITE_WORD.test(tool)) return false
  return READ_WORD.test(tool)
}

// the connectors' tools come from Claude Code itself: a session started only to ask for its MCP servers' status
// (`mcp_status` over stream-json), which sends no prompt (no usage) and keeps no transcript. Connecting takes a few
// seconds, so it asks again until none is pending.
const TOOLS_CACHE_MS = 10 * 60_000
let toolsCache: { at: number; tools: Record<string, ConnectorTool[]> } | null = null
let toolsPending: Promise<Record<string, ConnectorTool[]>> | null = null

/** For tests. */
export const setConnectorToolsForTest = (tools: Record<string, ConnectorTool[]>) => void (toolsCache = { at: Date.now(), tools })

type McpStatus = { name?: string; status?: string; tools?: { name?: string; annotations?: { readOnly?: boolean; destructive?: boolean } }[] }

/** The tools out of the stream-json replies: the last status asked for (the one with the fewest still connecting). */
export function parseMcpStatus(out: string): { tools: Record<string, ConnectorTool[]>; pending: number } | null {
  let best: { tools: Record<string, ConnectorTool[]>; pending: number } | null = null
  for (const line of out.split('\n')) {
    let msg: { type?: string; response?: { response?: { mcpServers?: McpStatus[] } } }
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const servers = msg.type === 'control_response' ? msg.response?.response?.mcpServers : undefined
    if (!Array.isArray(servers)) continue
    const tools: Record<string, ConnectorTool[]> = {}
    for (const sv of servers) {
      if (!sv.name || sv.name === OFFICE_SERVER || !sv.tools?.length) continue
      tools[toolPrefix(sv.name)] = sv.tools
        .filter((t) => typeof t.name === 'string')
        .map((t) => ({
          name: t.name!,
          // a connector that says nothing: its name decides
          readOnly: t.annotations?.readOnly ?? (t.annotations?.destructive ? false : Object.keys(t.annotations ?? {}).length ? false : isReadOnlyTool(t.name!)),
          ...(t.annotations?.destructive ? { destructive: true } : {}),
        }))
    }
    const pending = servers.filter((sv) => sv.status === 'pending').length
    if (!best || pending <= best.pending) best = { tools, pending }
  }
  return best
}

/** Each connector's tools (only the connected ones have any), cached for 10 minutes. */
export async function listConnectorTools({ fresh = false } = {}): Promise<{ tools: Record<string, ConnectorTool[]>; checkedAt: number }> {
  if (!fresh && toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_MS) return { tools: toolsCache.tools, checkedAt: toolsCache.at }
  toolsPending ??= (async () => {
    try {
      const ask = (id: string, subtype: string) => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })
      const asks = [ask('init', 'initialize'), ...Array.from({ length: 12 }, (_, i) => `sleep 3; printf '%s\\n' '${ask(`s${i}`, 'mcp_status')}'`)]
      const feed = `printf '%s\\n' '${asks[0]}'; ${asks.slice(1).join('; ')}`
      const env = CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR='${CLAUDE_CONFIG_DIR.replace(/'/g, `'\\''`)}' ` : ''
      const claude = `'${CLAUDE.replace(/'/g, `'\\''`)}'`
      const run = await runAsAgent(['sh', '-c', `(${feed}) | ${env}${claude} -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence`], {
        cwd: AGENTS_DIR,
        timeoutMs: 90_000,
      })
      const got = parseMcpStatus(run.out)
      if (!got) throw new AgentError("Could not read the connectors' tools", 500)
      toolsCache = { at: Date.now(), tools: got.tools }
      return got.tools
    } finally {
      toolsPending = null
    }
  })()
  const tools = await toolsPending
  return { tools, checkedAt: toolsCache?.at ?? Date.now() }
}

/** Is this tool of the connector only reading? What the connector says when known, else its name. */
export function toolReads(prefix: string, tool: string) {
  const known = toolsCache?.tools[prefix]?.find((t) => t.name === tool)
  return known ? known.readOnly : isReadOnlyTool(tool)
}

/**
 * For a tool call: the reason to ask the owner first, or null. mcp__<server>__<tool>; the office's own server (the
 * manager's tools) is never gated.
 */
export function connectorWriteGate(row: AgentRow, toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null
  const [, server, ...rest] = toolName.split('__')
  const tool = rest.join('__')
  if (!server || !tool || server === OFFICE_SERVER) return null
  const prefix = `mcp__${server}`
  const name = cache?.list.find((c) => c.prefix === prefix)?.name ?? server.replace(/_/g, ' ')
  if (toolReads(prefix, tool)) {
    if (!connectorsReadAskOf(row).includes(prefix)) return null
    return `Reading with ${name} is off for this agent: "${tool}" waits for the owner's approval in After Office (or turn Read on in its Connectors tab).`
  }
  if (connectorsWriteOf(row).includes(prefix)) return null
  return `${name} is read-only for this agent: "${tool}" changes something, so the owner approves it in After Office (or turns Write on in its Connectors tab).`
}

/** A connector's name for people: "claude.ai Gmail" → "Gmail" (from the listing when known). */
export function connectorLabel(prefix: string) {
  const name = cache?.list.find((c) => c.prefix === prefix)?.name ?? prefix.replace(/^mcp__/, '').replace(/_/g, ' ')
  return name.replace(/^claude[._ ]ai /, '').replace(/^plugin[:_ ][^:_ ]+[:_ ]/, '')
}
export const OFFICE_TOOLS_PREFIX = `mcp__${OFFICE_SERVER}`
