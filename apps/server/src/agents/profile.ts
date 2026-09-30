import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSkill } from '@after-office/shared'
import { agentsRepo } from '../db'
import { AgentError } from './manager'
import { readInFolder, writeInFolder } from './safefs'
import { updateRuntime } from './registry'

// The agent's CLAUDE.md and .claude/skills/*/SKILL.md, read from and written to its folder, so the drawer always
// shows what Claude Code will actually load.

export interface ProfileDoc {
  name: string
  role: string
  claudeMd: string
  skills: AgentSkill[]
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

function parseSkill(dir: string, text: string): AgentSkill {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  const front = m?.[1] ?? ''
  const field = (k: string) => front.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')
  return {
    id: dir,
    name: field('name') ?? dir,
    description: field('description') ?? '',
    body: (m ? text.slice(m[0].length) : text).replace(/^\n+/, '').replace(/\n+$/, ''),
    enabled: field('disable-model-invocation') !== 'true',
  }
}

export function readProfile(id: string): ProfileDoc {
  const row = agentsRepo.get(id)
  if (!row) throw new AgentError('No such agent', 404)
  const claudePath = join(row.cwd, 'CLAUDE.md')
  const skillsDir = join(row.cwd, '.claude', 'skills')
  const skills: AgentSkill[] = []
  if (existsSync(skillsDir))
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      const file = join(skillsDir, d.name, 'SKILL.md')
      const text = d.isDirectory() && !d.name.startsWith('.') ? readInFolder(row.cwd, file) : null
      if (text !== null) skills.push(parseSkill(d.name, text))
    }
  return { name: row.name, role: row.role, claudeMd: readInFolder(row.cwd, claudePath) ?? '', skills }
}

export function writeProfile(id: string, doc: ProfileDoc) {
  const row = agentsRepo.get(id)
  if (!row) throw new AgentError('No such agent', 404)
  const name = doc.name?.trim()
  if (!name || name.length > 32) throw new AgentError('Name is required (max 32 characters)')
  if ((doc.claudeMd ?? '').length > 200_000) throw new AgentError('CLAUDE.md is too large')

  agentsRepo.update(id, { name, role: (doc.role ?? '').slice(0, 60) })
  writeInFolder(row.cwd, join(row.cwd, 'CLAUDE.md'), doc.claudeMd ?? '')

  const skillsDir = join(row.cwd, '.claude', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  const keep = new Set<string>()
  for (const s of doc.skills ?? []) {
    const dir = slug(s.name)
    if (!dir) continue
    keep.add(dir)
    // a renamed skill leaves its old folder behind; it's handled by the removal pass below
    mkdirSync(join(skillsDir, dir), { recursive: true })
    const front = [`name: ${dir}`, `description: ${(s.description ?? '').replace(/\n/g, ' ')}`, ...(s.enabled ? [] : ['disable-model-invocation: true'])]
    writeInFolder(row.cwd, join(skillsDir, dir, 'SKILL.md'), `---\n${front.join('\n')}\n---\n\n${(s.body ?? '').trim()}\n`)
  }
  // Skills removed in the dashboard are moved aside, not deleted, so nothing is lost by accident.
  for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || keep.has(d.name)) continue
    if (!existsSync(join(skillsDir, d.name, 'SKILL.md'))) continue
    const trash = join(row.cwd, '.claude', 'skills-removed')
    mkdirSync(trash, { recursive: true })
    renameSync(join(skillsDir, d.name), join(trash, `${d.name}-${Date.now()}`))
  }
  // name/role changed → push to dashboards
  updateRuntime(id, (rt) => ({ ...rt }))
  return readProfile(id)
}
