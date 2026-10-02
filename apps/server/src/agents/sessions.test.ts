import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { agentsRepo, reportsRepo, sideSessionsRepo, tasksRepo } from '../db'
import { PROJECT_DIR } from '../fsroots'
import { handleHook, handleStatusline } from './ingest'
import { closeSideSession, hooksTampered, renameSideSession, sessionKeyOf, writeAgentSettings } from './manager'
import { getPending, pendingFor, resolvePending, runtimeOf, sideRuntimeOf, toInfo } from './registry'
import { transcriptPath } from './transcripts'
import { expectChatReport } from '../work/work'

// Side sessions: more Claude Code processes of one agent, for the owner to chat in parallel. Their events must never
// touch the main session: its conversation id, its status, its task, its queue, its prompts.

const scratch = mkdtempSync(join(dirname(PROJECT_DIR), 'ao-sessions-test-'))
const cwd = join(scratch, 'kai')
mkdirSync(cwd, { recursive: true })
const MAIN_SID = crypto.randomUUID()
agentsRepo.insert({ id: 'ss-a', name: 'Kai', tmux_session: 'ao-ss-kai', cwd, desk: 981, role: '', model: 'haiku', permission_mode: 'default', session_id: MAIN_SID, created_at: Date.now(), kind: 'worker' })
sideSessionsRepo.insert({ agent_id: 'ss-a', key: 's2', tmux_session: 'ao-ss-kai--s2', session_id: crypto.randomUUID(), title: null, created_at: Date.now(), closed_at: null })
afterAll(() => {
  sideSessionsRepo.removeAgent('ss-a')
  agentsRepo.remove('ss-a')
  rmSync(scratch, { recursive: true, force: true })
})

const app = new Hono()
app.post('/hook', handleHook)
app.post('/statusline', handleStatusline)
const hook = (body: Record<string, unknown>, session?: string) =>
  app.request('/hook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-agent': 'ss-a', ...(session !== undefined ? { 'x-ao-session': session } : {}) }, body: JSON.stringify(body) })

test('session keys: s2, s3… are side sessions; anything else is the main session', () => {
  expect(sessionKeyOf('s2')).toBe('s2')
  expect(sessionKeyOf('main')).toBe('')
  expect(sessionKeyOf('$AO_SESSION_KEY')).toBe('')
  expect(sessionKeyOf('')).toBe('')
  expect(sessionKeyOf('s2; rm -rf')).toBe('')
})

test("a side session's events change its own state only, never the main session's conversation or status", async () => {
  const sid = crypto.randomUUID()
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi there' }, 's2')
  expect(agentsRepo.get('ss-a')!.session_id).toBe(MAIN_SID)
  expect(sideSessionsRepo.get('ss-a', 's2')!.session_id).toBe(sid)
  expect(sideRuntimeOf('ss-a', 's2').status).toBe('working')
  expect(runtimeOf('ss-a').status).toBe('offline')
  const info = toInfo(agentsRepo.get('ss-a')!)
  expect(info.status).toBe('offline')
  expect(info.sessions).toEqual([expect.objectContaining({ key: 's2', open: true, status: 'working' })])
  // its transcript is its own file
  expect(transcriptPath(agentsRepo.get('ss-a')!, 's2')).toEndWith(`${sid}.jsonl`)
  // the main session (no header, or "main") still follows /clear as before
  const main2 = crypto.randomUUID()
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: main2, prompt: 'x' }, 'main')
  expect(agentsRepo.get('ss-a')!.session_id).toBe(main2)
  expect(runtimeOf('ss-a').status).toBe('working')
})

test("a side session's turn ending never closes the main session's task", async () => {
  tasksRepo.put({ id: 'ss-t', title: 'Ship it', agentId: 'ss-a', deadline: Date.now() + 1000, priority: 'low', status: 'in_progress', startedAt: Date.now() })
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'side answer' }, 's2')
  expect(tasksRepo.get('ss-t')!.status).toBe('in_progress')
  expect(reportsRepo.latest(50).some((r) => r.refId === 'ss-t')).toBe(false)
  expect(sideRuntimeOf('ss-a', 's2')).toMatchObject({ status: 'idle', lastMessage: 'side answer', unread: 1 })
  tasksRepo.remove('ss-t')
})

test("a side session's chat answer with a project / tags goes to Reports (its own turn)", async () => {
  expectChatReport('ss-a', 'Write the intro\n\n[After Office context]\nTags: x', 'Write the intro', { tags: [] }, 's2')
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Write the intro\n\n[After Office context]\nTags: x' }, 's2')
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'The intro.' }, 's2')
  const r = reportsRepo.latest(50).find((x) => x.kind === 'chat' && x.refId === 'ss-a')!
  expect(r).toMatchObject({ title: 'Write the intro', text: 'The intro.' })
  reportsRepo.remove(r.id)
})

test("a side session's permission prompt is its own: tagged with the session, not cleared by the main session", async () => {
  const held = hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-1' }, 's2')
  await Bun.sleep(50)
  const f = pendingFor('ss-a').find((x) => x.tool === 'Bash')!
  expect(f).toMatchObject({ sessionKey: 's2', id: 'ss-a:s2:tu-1' })
  // the main session moving on doesn't answer the side session's prompt
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'main again' })
  expect(getPending(f.id)).toBeDefined()
  resolvePending(f.id, {})
  expect((await held).status).toBe(200)
})

test('the status line of a side session reports for that session', async () => {
  const res = await app.request('/statusline', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ao-agent': 'ss-a', 'x-ao-session': 's2' },
    body: JSON.stringify({ cost: { total_cost_usd: 0.42 }, context_window: { used_percentage: 12 } }),
  })
  expect(await res.text()).toContain('session 2')
  expect(sideRuntimeOf('ss-a', 's2')).toMatchObject({ costUsd: 0.42, contextPct: 12 })
  expect(runtimeOf('ss-a').costUsd).toBeUndefined()
})

test("the owner's name for a session wins over Claude Code's title; empty goes back to it", async () => {
  sideSessionsRepo.update('ss-a', 's2', { title: 'Auto title' })
  renameSideSession('ss-a', 's2', '  Riset   SEO ')
  expect(toInfo(agentsRepo.get('ss-a')!).sessions?.[0].title).toBe('Riset SEO')
  renameSideSession('ss-a', 's2', '')
  expect(toInfo(agentsRepo.get('ss-a')!).sessions?.[0].title).not.toBe('Riset SEO')
})

test("a closed side session's events are ignored; it stays listed to open again", async () => {
  await closeSideSession('ss-a', 's2')
  expect(sideSessionsRepo.get('ss-a', 's2')!.closed_at).toBeNumber()
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'late' }, 's2')
  expect(sideRuntimeOf('ss-a', 's2').status).toBe('offline')
  expect(toInfo(agentsRepo.get('ss-a')!).sessions).toEqual([expect.objectContaining({ key: 's2', open: false, status: 'offline' })])
})

test('hooks from before side sessions are an upgrade, not tampering', async () => {
  writeAgentSettings(cwd)
  expect(hooksTampered(cwd)).toBeNull()
  // the same file as an older version wrote it: no session header
  const file = join(cwd, '.claude', 'settings.local.json')
  const json = JSON.parse(await Bun.file(file).text())
  for (const groups of Object.values(json.hooks) as { hooks: { headers: Record<string, string>; allowedEnvVars: string[] }[] }[][])
    for (const g of groups)
      for (const h of g.hooks) {
        delete h.headers['X-AO-Session']
        h.allowedEnvVars = h.allowedEnvVars.filter((v) => v !== 'AO_SESSION_KEY')
      }
  json.statusLine.command = json.statusLine.command.replace(' -H "x-ao-session: $AO_SESSION_KEY"', '')
  writeFileSync(file, JSON.stringify(json, null, 2))
  expect(hooksTampered(cwd)).not.toBeNull()
  expect(hooksTampered(cwd, { ignoreNewer: true })).toBeNull()
})

test("a tool finishing settles only its own permission prompt, not another tool's still open beside it", async () => {
  const held = hook({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: '/elsewhere/a.md' }, tool_use_id: 'tu-read' })
  await Bun.sleep(50)
  const f = pendingFor('ss-a').find((x) => x.tool === 'Read')!
  expect(f.id).toBe('ss-a:tu-read')
  // a grep that ran beside it finishes: the Read prompt is still waiting for the owner
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'grep x' }, tool_use_id: 'tu-grep' })
  expect(getPending(f.id)).toBeDefined()
  // the Read itself goes through (answered in the terminal): its card goes
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/elsewhere/a.md' }, tool_use_id: 'tu-read' })
  expect(getPending(f.id)).toBeUndefined()
  expect((await held).status).toBe(200)
})
