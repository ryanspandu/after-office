import { isRulePack, RULE_PACKS, type RulePackId } from '@after-office/shared'

// Office rules in an agent's CLAUDE.md. Each set sits between its own markers:
//   <!-- after-office:rules:<id> -->
//   …
//   <!-- /after-office:rules:<id> -->
// so the dashboard can add, update or remove it (CLAUDE.md tab → Office rules) without touching anything else in the
// file. "office" is always kept.

const BODIES: Record<RulePackId, string> = {
  office: `## Working in After Office
- Work reaches you as messages: \`New task: …\` from the owner or the manager, and \`[From the manager] …\` follow-ups.
- Your final message on a task is its report: it goes to the owner's Reports and to the manager. Write it as the
  result: what you did, what you found, the files you made (full paths), and open questions. Not "working on it".
- Finish the task within your turn. If you hand parts to subagents, wait for all of them, combine their results
  (in the file and in your final message), then end your turn.
- Save deliverables in your folder, or in the folder the task names, and mention their paths.
- Stuck or unsure? Ask instead of guessing. Never publish, deploy, delete data or spend money without the owner's
  approval.`,
  engineering: `## Software engineering
- Each project keeps its own setup, so they can differ: runtime versions in \`.mise.toml\` (e.g. \`node = "18"\`, then
  \`mise install\`), and databases/services (MySQL, Postgres, Redis…) in the project's \`docker-compose.yml\`, started
  with \`docker compose up -d\`. Publish container ports on 127.0.0.1 only. Only development credentials, in the
  project's \`.env\` (never production ones).
- Run an app you're working on (a dev server) on a free preview port, 3000–3009, on localhost (other agents use them
  too: check with \`ss -ltn\` or \`lsof -i\` first); the owner opens it from the dashboard (Folders → Running now).
  Say which port in your report.
- Anything that must keep running after your turn (a dev server, a worker) goes in the project's
  \`docker-compose.yml\` (\`restart: unless-stopped\`) or runs with \`nohup … &\` and a log file; stop what you no
  longer need.
- You have no sudo. A system tool that isn't installed (e.g. a converter or library): use it from a Docker image
  (\`docker run --rm -v "$PWD":/w -w /w <image> …\`), or ask the owner to install it; don't work around it silently.
- Commit on a branch and open a pull request; don't push to main. Your git identity and SSH key are set for you.`,
}

const open = (id: string) => `<!-- after-office:rules:${id} -->`
const close = (id: string) => `<!-- /after-office:rules:${id} -->`
const block = (id: RulePackId) => `${open(id)}\n${BODIES[id]}\n${close(id)}`
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const blockRe = (id: string) => new RegExp(`\\n*${esc(open(id))}[\\s\\S]*?${esc(close(id))}\\n*`, 'g')

/** "office" first, then the rest in their catalogue order; unknown ids dropped. */
export function cleanPacks(v: unknown): RulePackId[] {
  const wanted = new Set(Array.isArray(v) ? v.filter(isRulePack) : [])
  return RULE_PACKS.filter((p) => ('always' in p && p.always) || wanted.has(p.id)).map((p) => p.id)
}

/** The office rules as text, for a new CLAUDE.md. */
export const renderRules = (packs: RulePackId[]) => cleanPacks(packs).map(block).join('\n\n') + '\n'

/** Which sets a CLAUDE.md has (by their markers). */
export const rulesIn = (text: string): RulePackId[] => RULE_PACKS.filter((p) => text.includes(open(p.id))).map((p) => p.id)

/**
 * The CLAUDE.md with exactly these sets: each one's block replaced by its current text, missing ones added at the
 * end, unchecked ones removed. An older file without markers has its old "## Working in After Office" section (the
 * rules as they were written before) taken out first, so the rules aren't there twice.
 */
export function applyRules(text: string, packs: RulePackId[]) {
  const want = cleanPacks(packs)
  let out = text
  if (!rulesIn(out).length) out = out.replace(/\n*## Working in After Office\n[\s\S]*?(?=\n## (?!Working in After Office)|$)/, '\n')
  // blocks not wanted, including sets that are no longer offered (e.g. an old "marketing" one)
  for (const id of new Set([...out.matchAll(/<!-- after-office:rules:([\w-]+) -->/g)].map((m) => m[1])))
    if (!(want as string[]).includes(id)) out = out.replace(blockRe(id), '\n\n')
  for (const id of want) {
    if (out.includes(open(id))) out = out.replace(blockRe(id), `\n\n${block(id)}\n\n`)
    else out = `${out.trimEnd()}\n\n${block(id)}\n`
  }
  return out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
