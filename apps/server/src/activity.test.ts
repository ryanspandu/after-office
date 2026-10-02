import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityRepo, agentsRepo, tasksRepo, type AgentRow } from './db'
import { maskInput, noteManagerMessage, noteOwnerMessage, originOfTurn, toolDecided, toolFinished, toolStarting, toolWaiting } from './work/activity'
import { onPromptSubmitted } from './work/work'
import { hooksTampered, restoreHooks, writeAgentSettings } from './agents/manager'

// The Activity log: connector calls with masked input, who let them run, what came back, and why (the turn's origin).
const row = (id: string, name: string, kind: AgentRow['kind'] = 'worker'): AgentRow => ({ id, name, kind, tmux_session: `ao-${id}`, cwd: '/tmp', desk: agentsRepo.freeDesk(), role: '', model: 'haiku', permission_mode: 'auto', session_id: crypto.randomUUID(), created_at: Date.now() })

test('input is shortened and secrets are masked', () => {
  const m = maskInput({ to: 'a@b.c', api_key: 'abc', body: 'x'.repeat(500), auth: { token: 't' }, id: 'sk-ant-abcdefghijklmnop', list: Array.from({ length: 12 }, (_, i) => i) })
  expect(m).toContain('"to":"a@b.c"')
  expect(m).toContain('"api_key":"••••"')
  expect(m).toContain('(500 characters)')
  expect(m).toContain('"token":"••••"')
  expect(m).not.toContain('sk-ant-')
  expect(m).toContain('… 2 more')
})

test('a connector call from start to finish, with its origin', () => {
  agentsRepo.insert(row('act-w', 'Vera'))
  agentsRepo.insert(row('act-m', 'Max', 'manager'))
  // the owner asked the manager (from a device), the manager made a task, the agent works on it
  noteOwnerMessage('act-m', { device: 'Chrome on macOS', ip: '203.0.113.7' })
  onPromptSubmitted('act-m', 'please email the invoice')
  expect(originOfTurn('act-m')).toMatchObject({ kind: 'owner', device: 'Chrome on macOS', ip: '203.0.113.7' })
  noteManagerMessage('act-w', 'act-m')
  onPromptSubmitted('act-w', '[From the manager] send it')
  expect(originOfTurn('act-w')).toMatchObject({ kind: 'manager', label: 'Max', via: { kind: 'owner', ip: '203.0.113.7' } })
  // it read a page first, then a write that waits for the owner, who approves from a phone
  toolFinished('act-w', 'WebFetch', { url: 'https://example.com/invoice' }, 'ok', 'r1')
  toolStarting('act-w', 'mcp__claude_ai_Gmail__send_message', { to: 'client@x.com', token: 'nope' }, 'u1', true)
  let e = activityRepo.get('act-w:u1')!
  expect(e).toMatchObject({ connector: 'Gmail', tool: 'send_message', access: 'write', status: 'waiting', readBefore: ['Web page: https://example.com/invoice'] })
  expect(e.input).not.toContain('nope')
  // Claude Code's PermissionRequest has no tool_use_id: matched to the latest call of that tool
  toolWaiting('act-w', 'mcp__claude_ai_Gmail__send_message', {}, undefined, 'act-w:followup-1')
  expect(activityRepo.list({ agentId: 'act-w' }).filter((x) => x.tool === 'send_message')).toHaveLength(1)
  toolDecided('act-w:followup-1', true, { device: 'Safari on iPhone', ip: '198.51.100.2' })
  toolFinished('act-w', 'mcp__claude_ai_Gmail__send_message', {}, { content: [{ type: 'text', text: 'Sent, id 123' }] }, 'u1')
  e = activityRepo.get('act-w:u1')!
  expect(e).toMatchObject({ status: 'ok', result: 'Sent, id 123', decision: { by: 'owner', allowed: true, device: 'Safari on iPhone', ip: '198.51.100.2' } })
  expect(e.origin).toMatchObject({ kind: 'manager', via: { kind: 'owner', device: 'Chrome on macOS' } })
  // a read on its own: automatic; an error; a denial
  toolStarting('act-w', 'mcp__claude_ai_Google_Drive__search_files', { q: 'x' }, 'u2', false)
  toolFinished('act-w', 'mcp__claude_ai_Google_Drive__search_files', {}, { isError: true, content: [{ text: 'boom' }] }, 'u2')
  expect(activityRepo.get('act-w:u2')).toMatchObject({ access: 'read', status: 'error', decision: { by: 'auto' } })
  toolStarting('act-w', 'mcp__claude_ai_Gmail__delete_email', {}, 'u3', true)
  toolDecided('act-w:u3', false, { device: 'x', ip: 'y' })
  expect(activityRepo.get('act-w:u3')!.status).toBe('denied')
  // the office's own tools aren't logged
  toolStarting('act-m', 'mcp__after-office__delegate_task', {}, 'u4', false)
  expect(activityRepo.get('act-m:u4')).toBeNull()
  // filters
  expect(activityRepo.list({ agentId: 'act-w', access: 'write' }).map((x) => x.id).sort()).toEqual(['act-w:u1', 'act-w:u3'])
  expect(activityRepo.list({ agentId: 'act-w', problems: true }).map((x) => x.id).sort()).toEqual(['act-w:u2', 'act-w:u3'])
  expect(activityRepo.connectors()).toEqual(expect.arrayContaining(['Gmail', 'Google Drive']))
  // search: every word, anywhere in the entry; % and _ are plain characters
  expect(activityRepo.list({ agentId: 'act-w', q: 'client@x.com send' }).map((x) => x.id)).toEqual(['act-w:u1'])
  expect(activityRepo.list({ agentId: 'act-w', q: '100%' })).toEqual([])
})

test('a task carries who made it into the turn', () => {
  tasksRepo.put({ id: 'act-t', title: 'Invoice', agentId: 'act-w', deadline: Date.now(), priority: 'low', status: 'todo', origin: { kind: 'owner', label: 'Made in the dashboard', ip: '203.0.113.9' } })
  // no active work registered here: a plain follow-up
  onPromptSubmitted('act-w', 'continue')
  expect(originOfTurn('act-w')).toMatchObject({ kind: 'agent' })
  tasksRepo.remove('act-t')
})

test("an agent's hooks: noticed when changed, put back", () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ao-hooks-'))
  mkdirSync(join(cwd, '.claude'))
  writeAgentSettings(cwd)
  expect(hooksTampered(cwd)).toBeNull()
  const file = join(cwd, '.claude', 'settings.local.json')
  const s = JSON.parse(readFileSync(file, 'utf8'))
  // removing one hook
  writeFileSync(file, JSON.stringify({ ...s, hooks: { ...s.hooks, PreToolUse: [] } }))
  expect(hooksTampered(cwd)).toContain('PreToolUse')
  restoreHooks(cwd)
  expect(hooksTampered(cwd)).toBeNull()
  // switching all hooks off, in either file
  writeFileSync(file, JSON.stringify({ ...s, disableAllHooks: true }))
  expect(hooksTampered(cwd)).toContain('disableAllHooks')
  restoreHooks(cwd)
  expect(hooksTampered(cwd)).toBeNull()
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }))
  expect(hooksTampered(cwd)).toContain('settings.json')
  restoreHooks(cwd)
  expect(hooksTampered(cwd)).toBeNull()
  // a hook event added later, missing from an older agent: not tampering (filled in quietly)
  const older = JSON.parse(readFileSync(file, 'utf8'))
  delete older.hooks.PostToolUseFailure
  writeFileSync(file, JSON.stringify(older))
  expect(hooksTampered(cwd)).toContain('PostToolUseFailure')
  expect(hooksTampered(cwd, { ignoreNewer: true })).toBeNull()
  restoreHooks(cwd)
  // the owner's own permission rules (e.g. from "allow always") are not a problem
  const again = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...again, permissions: { allow: ['Bash(ls:*)'] } }))
  expect(hooksTampered(cwd)).toBeNull()
})
