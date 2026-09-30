import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { agentsRepo } from '../db'
import { AGENTS_DIR } from '../fsroots'
import { withEdits, type HireRequest } from './hires'

// The owner can change a hire before approving it: name (and with it the default folder), role, model, mode, character.

const proposal = (patch: Partial<HireRequest> = {}): HireRequest => ({
  id: 'hire-x',
  managerId: 'mgr',
  name: 'Cella',
  role: 'Secretary',
  model: 'sonnet',
  mode: 'auto',
  folder: join(AGENTS_DIR, 'cella'),
  createdAt: Date.now(),
  ...patch,
})

describe('hire edits', () => {
  test('a new name moves the default folder; other edits apply', () => {
    const h = withEdits(proposal(), { type: 'allow', hire: { name: 'Celine', role: 'Executive assistant', model: 'opus', mode: 'default', figure: 'woman' } })
    expect(h).toMatchObject({ name: 'Celine', role: 'Executive assistant', model: 'opus', mode: 'default', figure: 'woman', folder: join(AGENTS_DIR, 'celine') })
  })

  test("a folder the manager chose stays when the name changes; nothing changed: same proposal", () => {
    const repo = join(AGENTS_DIR, '..', 'some-repo')
    expect(withEdits(proposal({ folder: repo }), { type: 'allow', hire: { name: 'Celine' } }).folder).toBe(repo)
    const p = proposal()
    expect(withEdits(p, { type: 'allow' })).toBe(p)
  })

  test('a name another agent has is refused', () => {
    agentsRepo.insert({ id: 'hire-taken', name: 'Nova', tmux_session: 'ao-hire-taken', cwd: join(AGENTS_DIR, 'nova'), desk: 981, role: '', model: 'haiku', permission_mode: 'default', session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' })
    expect(() => withEdits(proposal(), { type: 'allow', hire: { name: 'nova' } })).toThrow('There is already an agent called nova')
    expect(() => withEdits(proposal(), { type: 'allow', hire: { name: '!!!' } })).toThrow()
    agentsRepo.remove('hire-taken')
  })
})

// Effort: the manager may suggest one; the owner keeps it, changes it, or goes back to Claude Code's default (null).
test('hire effort edits', () => {
  expect(withEdits(proposal({ effort: 'high' }), { type: 'allow', hire: { name: 'Cella' } }).effort).toBe('high')
  expect(withEdits(proposal({ effort: 'high' }), { type: 'allow', hire: { effort: 'low' } }).effort).toBe('low')
  expect(withEdits(proposal({ effort: 'high' }), { type: 'allow', hire: { effort: null } }).effort).toBeUndefined()
  // not a level: ignored
  expect(withEdits(proposal(), { type: 'allow', hire: { effort: 'turbo' as never } }).effort).toBeUndefined()
})
