import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentsRepo } from '../db'
import { AGENTS_DIR, PLANS_DIR } from '../fsroots'
import { refreshOfficeRules } from './rulesSync'

// At start, the office's marked blocks in each agent's CLAUDE.md are brought up to date (the plans rule, here);
// the owner's own text stays as it is, and a file without the blocks isn't touched.

test('old office rules get the new ones; the rest of the file stays', () => {
  const dir = join(AGENTS_DIR, 'rules-sync-a')
  const plain = join(AGENTS_DIR, 'rules-sync-b')
  mkdirSync(dir, { recursive: true })
  mkdirSync(plain, { recursive: true })
  const own = '# Nara\nMy own notes, kept.\n'
  writeFileSync(join(dir, 'CLAUDE.md'), `${own}\n<!-- after-office:rules:office -->\n## Working in After Office\n- an old rule\n<!-- /after-office:rules:office -->\n`)
  writeFileSync(join(plain, 'CLAUDE.md'), '# No office rules here\n')
  const row = (id: string, cwd: string) => ({ id, name: id, tmux_session: `ao-${id}`, cwd, desk: Math.floor(Math.random() * 1e6), role: '', model: 'haiku', permission_mode: 'default' as const, session_id: crypto.randomUUID(), created_at: Date.now(), kind: 'worker' as const })
  agentsRepo.insert(row('rs-a', dir))
  agentsRepo.insert(row('rs-b', plain))

  expect(refreshOfficeRules()).toBeGreaterThanOrEqual(1)
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
  expect(text.startsWith(own)).toBe(true)
  expect(text).toContain(`${PLANS_DIR}/`)
  expect(text).not.toContain('an old rule')
  expect(readFileSync(join(plain, 'CLAUDE.md'), 'utf8')).toBe('# No office rules here\n')
  // already up to date: nothing to do the next time
  expect(refreshOfficeRules()).toBe(0)
})
