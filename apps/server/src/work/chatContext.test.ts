import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { agentsRepo, reportsRepo, type AgentRow } from '../db'
import { PROJECTS_DIR } from '../fsroots'
import { deleteTag, putTag } from './tags'
import { cleanChatContext, contextBlock, CONTEXT_HEADER, expectChatReport, onAgentStopped, onPromptSubmitted, withContext } from './work'

// The chat's optional folder and tags: a block after the owner's words; the manager uses them for its work, any
// other agent's answer is kept in Reports under them.

const row = (id: string, kind: AgentRow['kind']): AgentRow => ({
  id, name: id.toUpperCase(), tmux_session: `ao-${id}`, cwd: '/tmp', desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku',
  permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind,
})
agentsRepo.insert(row('cc-w', 'worker'))
agentsRepo.insert(row('cc-m', 'manager'))
mkdirSync(join(PROJECTS_DIR, 'cc-blog'), { recursive: true })
const BLOG = realpathSync(join(PROJECTS_DIR, 'cc-blog'))
putTag('cc-t', { name: 'SEO' })
afterAll(() => {
  agentsRepo.remove('cc-w')
  agentsRepo.remove('cc-m')
  rmSync(BLOG, { recursive: true, force: true })
  deleteTag('cc-t')
})

test('the picks are checked: a folder agents may work in, known tags only', () => {
  expect(cleanChatContext(BLOG, ['cc-t', 'nope'])).toEqual({ folder: BLOG, tags: ['cc-t'] })
  expect(cleanChatContext('', [])).toEqual({})
  expect(() => cleanChatContext(join(PROJECTS_DIR, 'ghost'), [])).toThrow('No folder')
  expect(() => cleanChatContext('/etc', [])).toThrow('Folder must be inside')
})

test('the manager is told to use them; another agent gets the folder, and hears its answer is kept', () => {
  const ctx = { folder: BLOG, tags: ['cc-t'] }
  const m = contextBlock('cc-m', ctx)!
  expect(m).toStartWith(CONTEXT_HEADER)
  expect(m).toContain(`Folder: ${BLOG}`)
  expect(m).toContain('Tags: SEO')
  expect(m).toContain('delegate_task')
  const w = contextBlock('cc-w', ctx)!
  expect(w).toContain(`Folder: ${BLOG} (work there)`)
  expect(w).toContain("kept in the owner's Reports")
  expect(contextBlock('cc-w', {})).toBeNull()
  expect(withContext('Write the intro', w)).toStartWith('Write the intro\n\n[After Office context]')
})

test("a worker's answer to that message becomes a report with the folder and tags; the next plain message doesn't", () => {
  const ctx = { folder: BLOG, tags: ['cc-t'] }
  const sent = withContext('Write the intro\nAbout 200 words', contextBlock('cc-w', ctx))
  expectChatReport('cc-w', sent, 'Write the intro\nAbout 200 words', ctx)
  // its turn ending before the message was even seen (an earlier turn): not this answer
  onAgentStopped('cc-w', 'something earlier')
  expect(reportsRepo.latest(50).some((r) => r.kind === 'chat' && r.refId === 'cc-w')).toBe(false)
  onPromptSubmitted('cc-w', sent)
  onAgentStopped('cc-w', 'Here is the intro.')
  const r = reportsRepo.latest(50).find((x) => x.kind === 'chat' && x.refId === 'cc-w')!
  expect(r).toMatchObject({ title: 'Write the intro', text: 'Here is the intro.', folder: BLOG, tags: ['cc-t'], ok: true })
  reportsRepo.remove(r.id)
  // a plain message afterwards: no report
  onPromptSubmitted('cc-w', 'thanks')
  onAgentStopped('cc-w', 'You are welcome.')
  expect(reportsRepo.latest(50).some((x) => x.kind === 'chat' && x.refId === 'cc-w')).toBe(false)
})
