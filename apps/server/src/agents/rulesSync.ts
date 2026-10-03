import { join } from 'node:path'
import { agentsRepo } from '../db'
import { applyRules, rulesIn } from './rules'
import { readInFolder, writeInFolder } from './safefs'
import { restartWhenIdle } from './reconciler'

// The office rules change with After Office (a new rule, a folder that moved). At start, each agent whose CLAUDE.md
// has the office's marked blocks gets them as they are now: only those blocks, nothing else in the file. An agent whose
// file changed is restarted once it's idle (Claude Code reads CLAUDE.md at session start; the conversation stays).

export function refreshOfficeRules() {
  let changed = 0
  for (const row of agentsRepo.all()) {
    if (row.kind === 'manager') continue
    const file = join(row.cwd, 'CLAUDE.md')
    let text: string | null
    try {
      text = readInFolder(row.cwd, file)
    } catch {
      continue
    }
    if (!text) continue
    const packs = rulesIn(text)
    if (!packs.length) continue
    const next = applyRules(text, packs)
    if (next === text) continue
    try {
      writeInFolder(row.cwd, file, next)
      restartWhenIdle(row.id)
      changed++
    } catch (e) {
      console.warn(`[rules] could not update ${row.name}'s CLAUDE.md:`, e instanceof Error ? e.message : e)
    }
  }
  if (changed) console.log(`[rules] office rules updated for ${changed} agent(s)`)
  return changed
}
