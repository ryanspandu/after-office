import { afterAll, expect, test } from 'bun:test'
import { agentsRepo, projectsRepo, reportsRepo, type AgentRow } from '../db'
import { deleteTag, putTag } from './tags'
import { cleanChatContext, contextBlock, CONTEXT_HEADER, expectChatReport, onAgentStopped, onPromptSubmitted, withContext } from './work'

// The chat's optional project and tags: a block after the owner's words; the manager uses them for its work, any
// other agent's answer is kept in Reports under them.

const row = (id: string, kind: AgentRow['kind']): AgentRow => ({
  id, name: id.toUpperCase(), tmux_session: `ao-${id}`, cwd: '/tmp', desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku',
  permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind,
})
agentsRepo.insert(row('cc-w', 'worker'))
agentsRepo.insert(row('cc-m', 'manager'))
projectsRepo.put({ id: 'cc-p', name: 'Blog', color: '#f07a1d', brief: 'Running shoes for beginners.', folder: '/tmp/cc-blog' })
putTag('cc-t', { name: 'SEO' })
afterAll(() => {
  agentsRepo.remove('cc-w')
  agentsRepo.remove('cc-m')
  projectsRepo.remove('cc-p')
  deleteTag('cc-t')
})

test('the picks are checked: an existing project, known tags only', () => {
  expect(cleanChatContext('cc-p', ['cc-t', 'nope'])).toEqual({ projectId: 'cc-p', tags: ['cc-t'] })
  expect(cleanChatContext('', [])).toEqual({})
  expect(() => cleanChatContext('ghost', [])).toThrow('No such project')
})

test('the manager is told to use them; another agent gets the folder and brief, and hears its answer is kept', () => {
  const ctx = { projectId: 'cc-p', tags: ['cc-t'] }
  const m = contextBlock('cc-m', ctx)!
  expect(m).toStartWith(CONTEXT_HEADER)
  expect(m).toContain('Project: Blog (id cc-p)')
  expect(m).toContain('Tags: SEO')
  expect(m).toContain('delegate_task')
  const w = contextBlock('cc-w', ctx)!
  expect(w).toContain('Folder: /tmp/cc-blog (work there)')
  expect(w).toContain('Running shoes for beginners.')
  expect(w).toContain("kept in the owner's Reports")
  expect(contextBlock('cc-w', {})).toBeNull()
  expect(withContext('Write the intro', w)).toStartWith('Write the intro\n\n[After Office context]')
})

test("a worker's answer to that message becomes a report with the project and tags; the next plain message doesn't", () => {
  const ctx = { projectId: 'cc-p', tags: ['cc-t'] }
  const sent = withContext('Write the intro\nAbout 200 words', contextBlock('cc-w', ctx))
  expectChatReport('cc-w', sent, 'Write the intro\nAbout 200 words', ctx)
  // its turn ending before the message was even seen (an earlier turn): not this answer
  onAgentStopped('cc-w', 'something earlier')
  expect(reportsRepo.latest(50).some((r) => r.kind === 'chat' && r.refId === 'cc-w')).toBe(false)
  onPromptSubmitted('cc-w', sent)
  onAgentStopped('cc-w', 'Here is the intro.')
  const r = reportsRepo.latest(50).find((x) => x.kind === 'chat' && x.refId === 'cc-w')!
  expect(r).toMatchObject({ title: 'Write the intro', text: 'Here is the intro.', projectId: 'cc-p', tags: ['cc-t'], ok: true })
  reportsRepo.remove(r.id)
  // a plain message afterwards: no report
  onPromptSubmitted('cc-w', 'thanks')
  onAgentStopped('cc-w', 'You are welcome.')
  expect(reportsRepo.latest(50).some((x) => x.kind === 'chat' && x.refId === 'cc-w')).toBe(false)
})
