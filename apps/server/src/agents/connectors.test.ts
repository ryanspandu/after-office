import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { agentsRepo, type AgentRow } from '../db'
import { AGENTS_DIR } from '../fsroots'
import { agentRoutes } from '../routes/agents'
import { applyConnectors, parseConnectorList, setConnectorsForTest, syncAll, toolPrefix } from './connectors'

// Connectors: listed from `claude mcp list`, off by default for new agents, denied per agent in its own
// .claude/settings.local.json (the owner's other rules and our hooks stay).

const SAMPLE = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/mcp?token=secret123 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp - ✔ Connected
claude.ai Figma: https://mcp.figma.com/mcp - ! Needs authentication
plugin:design:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
plugin:design:asana: https://mcp.asana.com/sse (HTTP) - ✘ Failed to connect — Incompatible auth server: does not support dynamic client registration
plugin:design:gmail:  (HTTP) - - Not configured
after-office: http://127.0.0.1:8787/mcp (HTTP) - ✘ Failed to connect
`

describe('connectors', () => {
  test('parses every status; hosts only; the office tools are left out', () => {
    const list = parseConnectorList(SAMPLE)
    const by = Object.fromEntries(list.map((c) => [c.name, c]))
    expect(list.map((c) => c.name).sort()).toEqual(['claude.ai Claude Docs', 'claude.ai Figma', 'claude.ai Gmail', 'plugin:design:asana', 'plugin:design:gmail', 'plugin:design:slack'])
    expect(by['claude.ai Claude Docs']).toMatchObject({ prefix: 'mcp__claude_ai_Claude_Docs', source: 'claude.ai', host: 'api.anthropic.com', status: 'connected' })
    expect(JSON.stringify(list)).not.toContain('secret123')
    expect(by['claude.ai Figma'].status).toBe('needs-auth')
    expect(by['plugin:design:slack']).toMatchObject({ prefix: 'mcp__plugin_design_slack', source: 'plugin', plugin: 'design' })
    expect(by['plugin:design:asana']).toMatchObject({ status: 'failed', detail: 'Incompatible auth server: does not support dynamic client registration' })
    expect(by['plugin:design:gmail'].status).toBe('not-configured')
    expect(toolPrefix('claude.ai Google Drive')).toBe('mcp__claude_ai_Google_Drive')
  })

  const row = (id: string, connectors: string | null): AgentRow => ({
    id, name: id, tmux_session: `ao-${id}`, cwd: join(AGENTS_DIR, id), desk: 961, role: '', model: 'haiku',
    permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker', connectors,
  })
  const settingsOf = (id: string) => JSON.parse(readFileSync(join(AGENTS_DIR, id, '.claude', 'settings.local.json'), 'utf8'))

  test('deny = known − allowed, merged into the agent’s own settings; agents from before are left alone', () => {
    const list = parseConnectorList(SAMPLE)
    for (const id of ['cn-new', 'cn-some', 'cn-old']) mkdirSync(join(AGENTS_DIR, id, '.claude'), { recursive: true })
    // the owner's own deny rule and our hooks must survive
    writeFileSync(join(AGENTS_DIR, 'cn-some', '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'x' }] }] }, permissions: { deny: ['Bash(rm -rf:*)'], allow: ['Read'] } }))

    expect(applyConnectors(row('cn-new', '[]'), list)).toBe(true)
    expect(settingsOf('cn-new').permissions.deny.sort()).toEqual(list.map((c) => c.prefix).sort())

    expect(applyConnectors(row('cn-some', JSON.stringify(['mcp__claude_ai_Gmail'])), list)).toBe(true)
    const s = settingsOf('cn-some')
    expect(s.permissions.deny).toContain('Bash(rm -rf:*)')
    expect(s.permissions.deny).not.toContain('mcp__claude_ai_Gmail')
    expect(s.permissions.deny).toContain('mcp__claude_ai_Claude_Docs')
    expect(s.permissions.allow).toEqual(['Read'])
    expect(s.hooks.Stop).toHaveLength(1)
    // again with the same choice: nothing to write
    expect(applyConnectors(row('cn-some', JSON.stringify(['mcp__claude_ai_Gmail'])), list)).toBe(false)

    expect(applyConnectors(row('cn-old', null), list)).toBe(false) // every connector, as before
  })

  test('a new connector on the account is denied for agents with a chosen set; the choice is saved over the API', async () => {
    const app = new Hono().route('/api', agentRoutes)
    const list = parseConnectorList(SAMPLE)
    setConnectorsForTest(list)
    agentsRepo.insert(row('cn-api', '[]'))
    mkdirSync(join(AGENTS_DIR, 'cn-api', '.claude'), { recursive: true })
    const put = (allowed: unknown) => app.request('/api/agents/cn-api/connectors', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowed }) })

    expect((await put(['mcp__nope'])).status).toBe(400)
    expect((await put(['mcp__claude_ai_Claude_Docs'])).status).toBe(200)
    expect(agentsRepo.get('cn-api')!.connectors).toBe('["mcp__claude_ai_Claude_Docs"]')
    expect(settingsOf('cn-api').permissions.deny).not.toContain('mcp__claude_ai_Claude_Docs')

    const withNew = [...list, { name: 'claude.ai Notion', prefix: 'mcp__claude_ai_Notion', source: 'claude.ai' as const, status: 'connected' as const }]
    setConnectorsForTest(withNew)
    await syncAll()
    expect(settingsOf('cn-api').permissions.deny).toContain('mcp__claude_ai_Notion')
    agentsRepo.remove('cn-api')
  })
})
