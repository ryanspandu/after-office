import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { AccountSkill } from '@after-office/shared'
import { AGENT_HOME, CLAUDE_CONFIG_DIR } from '../fsroots'

// Skills the agents already get from their Claude account's config folder (the same one for every agent):
//   <config>/skills/**/SKILL.md                         your own skills, and the ones synced from claude.ai
//   <config>/plugins/synced/<id>/<plugin>/skills/…      plugins synced from claude.ai
//   <config>/plugins/installed_plugins.json → installs   plugins installed with /plugin
// The marketplaces folder is only a catalogue (nothing there is installed), so it is left out. Read-only.

const configDir = () => CLAUDE_CONFIG_DIR ?? join(AGENT_HOME, '.claude')
const MAX_DEPTH = 6
const MAX_SKILLS = 400

type Found = AccountSkill & { file: string }

function frontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  const field = (k: string) => m?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')
  return { name: field('name'), description: field('description'), body: m ? text.slice(m[0].length) : text }
}

/** SKILL.md files under `dir` (plain folders only, no symlinks), with the folder each sits in. */
function findSkills(dir: string, depth = 0, out: string[] = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_SKILLS) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isFile() && e.name === 'SKILL.md') out.push(full)
    else if (e.isDirectory()) findSkills(full, depth + 1, out)
  }
  return out
}

function describe(file: string, source: AccountSkill['source'], plugin?: string): Found | null {
  try {
    if (!lstatSync(file).isFile()) return null
    const text = readFileSync(file, 'utf8').slice(0, 200_000)
    const fm = frontmatter(text)
    const folder = file.split(sep).slice(-2, -1)[0]
    return {
      id: createHash('sha256').update(file).digest('hex').slice(0, 16),
      name: fm.name || folder,
      description: (fm.description ?? '').slice(0, 1000),
      source,
      plugin,
      file,
    }
  } catch {
    return null
  }
}

let cache: { at: number; list: Found[] } | null = null

export function accountSkills(): Found[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.list
  const root = configDir()
  const list: Found[] = []
  const add = (f: Found | null) => f && !list.some((x) => x.file === f.file) && list.push(f)

  // your skills; "synced" ones come from claude.ai
  for (const file of findSkills(join(root, 'skills'))) add(describe(file, relative(join(root, 'skills'), file).startsWith(`synced${sep}`) ? 'claude.ai' : 'user'))
  // plugins synced from claude.ai: …/synced/<org>/<plugin>/skills/<skill>/SKILL.md
  for (const file of findSkills(join(root, 'plugins', 'synced'))) {
    const parts = relative(join(root, 'plugins', 'synced'), file).split(sep)
    add(describe(file, 'plugin', parts[1]))
  }
  // plugins installed with /plugin
  try {
    const installed = JSON.parse(readFileSync(join(root, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, { installPath?: string }[]> }
    for (const [key, installs] of Object.entries(installed.plugins ?? {}))
      for (const i of installs ?? [])
        if (i.installPath && existsSync(i.installPath)) for (const file of findSkills(join(i.installPath, 'skills'))) add(describe(file, 'plugin', key.split('@')[0]))
  } catch {
    // no plugins installed
  }
  list.sort((a, b) => a.name.localeCompare(b.name))
  cache = { at: Date.now(), list }
  return list
}

/** One account skill's instructions (the SKILL.md body), for reading or copying into an agent. */
export function accountSkill(id: string) {
  const s = accountSkills().find((x) => x.id === id)
  if (!s) return null
  // still inside the config folder, still a plain file
  const root = realpathSync(configDir())
  const real = realpathSync(s.file)
  if (!real.startsWith(root + sep) || !lstatSync(s.file).isFile()) return null
  const fm = frontmatter(readFileSync(s.file, 'utf8').slice(0, 200_000))
  const { file: _file, ...info } = s
  return { ...info, body: fm.body.replace(/^\n+/, '').replace(/\n+$/, '') }
}

/** The list for the dashboard (no file paths). */
export const accountSkillList = (): AccountSkill[] => accountSkills().map(({ file: _f, ...s }) => s)
