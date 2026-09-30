import { expect, test } from 'bun:test'
import type { AgentRow } from '../db'
import { connectorWriteGate, isReadOnlyTool, parseMcpStatus, setConnectorToolsForTest } from './connectors'

// Read-only connectors: tools that only read run as usual; anything that changes something (or can't be told) asks the
// owner first, unless the agent may write with that connector. The office's own tools are never gated.
const row = (write: string[] = [], readAsk: string[] = []): AgentRow => ({ id: 'a', name: 'A', tmux_session: 'ao-a', cwd: '/tmp', desk: 1, role: '', model: 'haiku', permission_mode: 'auto', session_id: 'x', created_at: 0, kind: 'worker', connectors_write: JSON.stringify(write), connectors_read_ask: JSON.stringify(readAsk) })

test('which connector tools only read', () => {
  for (const t of ['search_messages', 'get_thread', 'list_files', 'gmail_read_message', 'read_file_content', 'download_file', 'get_campaign_insights', 'whoami']) expect(isReadOnlyTool(t)).toBe(true)
  for (const t of ['send_message', 'create_draft', 'update_campaign_budget', 'delete_event', 'share_file', 'pause_ad', 'reply_to_thread', 'something_unknown']) expect(isReadOnlyTool(t)).toBe(false)
})

test('the gate', () => {
  expect(connectorWriteGate(row(), 'mcp__claude_ai_Gmail__search_messages')).toBeNull()
  expect(connectorWriteGate(row(), 'mcp__claude_ai_Gmail__send_message')).toContain('read-only for this agent')
  // allowed to write with Gmail: no question
  expect(connectorWriteGate(row(['mcp__claude_ai_Gmail']), 'mcp__claude_ai_Gmail__send_message')).toBeNull()
  // …but not with Drive
  expect(connectorWriteGate(row(['mcp__claude_ai_Gmail']), 'mcp__claude_ai_Google_Drive__delete_file')).not.toBeNull()
  // the manager's own tools and non-MCP tools pass
  expect(connectorWriteGate(row(), 'mcp__after-office__delegate_task')).toBeNull()
  expect(connectorWriteGate(row(), 'Bash')).toBeNull()
})

test('Read turned off: reading asks too', () => {
  expect(connectorWriteGate(row([], ['mcp__claude_ai_Gmail']), 'mcp__claude_ai_Gmail__search_messages')).toContain('Reading with')
  expect(connectorWriteGate(row([], ['mcp__claude_ai_Gmail']), 'mcp__claude_ai_Google_Drive__search_files')).toBeNull()
})

test("what the connector says about its tools wins over their names", () => {
  const out = [
    '{"type":"control_response","response":{"request_id":"s0","response":{"mcpServers":[{"name":"claude.ai Google Drive","status":"pending","tools":[]}]}}}',
    'not json',
    JSON.stringify({ type: 'control_response', response: { request_id: 's1', response: { mcpServers: [
      { name: 'claude.ai Google Drive', status: 'connected', tools: [
        { name: 'search_files', annotations: { readOnly: true } },
        { name: 'copy_file', annotations: { openWorld: true } },
        { name: 'trash_file', annotations: { destructive: true } },
        { name: 'get_thing', annotations: {} },
      ] },
      { name: 'after-office', status: 'connected', tools: [{ name: 'delegate_task' }] },
    ] } } }),
  ].join('\n')
  const got = parseMcpStatus(out)!
  expect(got.pending).toBe(0)
  expect(Object.keys(got.tools)).toEqual(['mcp__claude_ai_Google_Drive'])
  expect(got.tools.mcp__claude_ai_Google_Drive).toEqual([
    { name: 'search_files', readOnly: true },
    { name: 'copy_file', readOnly: false },
    { name: 'trash_file', readOnly: false, destructive: true },
    { name: 'get_thing', readOnly: true },
  ])
  // the gate follows it: "download_file" reads by its name, but this connector says it writes
  setConnectorToolsForTest({ mcp__claude_ai_X: [{ name: 'download_file', readOnly: false }] })
  expect(connectorWriteGate(row(), 'mcp__claude_ai_X__download_file')).not.toBeNull()
  setConnectorToolsForTest({})
})
