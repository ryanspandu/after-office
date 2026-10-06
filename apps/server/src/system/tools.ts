import { agentsRepo } from '../db'
import { runAsAgent } from '../agents/asagent'
import { listSecrets } from '../agents/secrets'
import { AGENT_HOME } from '../fsroots'

// The Server window's Tools tab: the command-line tools the agents' user has (Claude Code, gh, railway, eas…), their
// versions, and whether they're signed in. Everything runs as the agents' user (that's whose tools and logins they are),
// never with an agent's own tokens: those show separately, per agent (their Secrets). Network checks (whoami) are slow,
// so the result is kept for a few minutes; "Check again" asks for a fresh one.

export type AuthState = 'ok' | 'none' | 'unknown' | 'na'

export interface ToolStatus {
  id: string
  name: string
  installed: boolean
  version?: string
  path?: string
  auth: AuthState
  /** who it's signed in as (an account, an email), when the tool says */
  account?: string
  /** what it said when it isn't signed in (one line) */
  note?: string
  /** how to install it (to copy: nothing is installed from the dashboard) */
  install: string
  /** how to sign in, in a terminal */
  login?: string
  /** the tokens (environment variables) that sign it in without a login: an agent's Secrets */
  tokens: string[]
  /** agents that have one of those tokens in their Secrets */
  agentTokens: { agentId: string; agent: string; name: string }[]
}

export interface ToolsReport {
  tools: ToolStatus[]
  /** other programs in the user's own bin folders (installed by hand or by an agent) */
  others: { name: string; path: string }[]
  checkedAt: number
}

interface ToolDef {
  id: string
  name: string
  bin: string
  version?: string[]
  /** a command that succeeds only when signed in (prints who, ideally) */
  whoami?: string[]
  /** pulls the account out of what whoami printed */
  account?: (out: string) => string | undefined
  install: string
  login?: string
  tokens?: string[]
}

const firstLine = (out: string) => out.split('\n').map((l) => l.trim()).find(Boolean)
const match = (re: RegExp) => (out: string) => out.match(re)?.[1]?.trim()
const email = match(/([\w.+-]+@[\w-]+\.[\w.-]+)/)

const TOOLS: ToolDef[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', version: ['--version'], install: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'git', name: 'git', bin: 'git', version: ['--version'], install: 'sudo apt install git' },
  { id: 'gh', name: 'GitHub CLI', bin: 'gh', version: ['--version'], whoami: ['auth', 'status'], account: match(/account\s+(\S+)/i), install: 'sudo apt install gh', login: 'gh auth login', tokens: ['GH_TOKEN', 'GITHUB_TOKEN'] },
  { id: 'glab', name: 'GitLab CLI', bin: 'glab', version: ['--version'], whoami: ['auth', 'status'], account: match(/as\s+(\S+)/i), install: 'see gitlab.com/gitlab-org/cli', login: 'glab auth login', tokens: ['GITLAB_TOKEN'] },
  { id: 'railway', name: 'Railway', bin: 'railway', version: ['--version'], whoami: ['whoami'], account: (o) => email(o) ?? match(/Logged in as\s+(.+)/i)(o), install: 'npm install -g @railway/cli', login: 'railway login --browserless', tokens: ['RAILWAY_TOKEN', 'RAILWAY_API_TOKEN'] },
  { id: 'vercel', name: 'Vercel', bin: 'vercel', version: ['--version'], whoami: ['whoami'], account: (o) => o.split('\n').map((l) => l.trim()).filter((l) => l && !/vercel cli/i.test(l)).pop(), install: 'npm install -g vercel', login: 'vercel login', tokens: ['VERCEL_TOKEN'] },
  { id: 'netlify', name: 'Netlify', bin: 'netlify', version: ['--version'], whoami: ['status'], account: (o) => email(o) ?? match(/Name:\s*(.+)/i)(o), install: 'npm install -g netlify-cli', login: 'netlify login', tokens: ['NETLIFY_AUTH_TOKEN'] },
  { id: 'supabase', name: 'Supabase', bin: 'supabase', version: ['--version'], whoami: ['projects', 'list'], install: 'npm install -g supabase', login: 'supabase login', tokens: ['SUPABASE_ACCESS_TOKEN'] },
  { id: 'eas', name: 'Expo (EAS)', bin: 'eas', version: ['--version'], whoami: ['whoami'], account: firstLine, install: 'npm install -g eas-cli', login: 'eas login', tokens: ['EXPO_TOKEN'] },
  { id: 'fly', name: 'Fly.io', bin: 'fly', version: ['version'], whoami: ['auth', 'whoami'], account: (o) => email(o) ?? firstLine(o), install: 'curl -L https://fly.io/install.sh | sh', login: 'fly auth login', tokens: ['FLY_API_TOKEN'] },
  { id: 'wrangler', name: 'Cloudflare (wrangler)', bin: 'wrangler', version: ['--version'], whoami: ['whoami'], account: email, install: 'npm install -g wrangler', login: 'wrangler login', tokens: ['CLOUDFLARE_API_TOKEN'] },
  { id: 'firebase', name: 'Firebase', bin: 'firebase', version: ['--version'], whoami: ['login:list'], account: email, install: 'npm install -g firebase-tools', login: 'firebase login --no-localhost', tokens: ['FIREBASE_TOKEN'] },
  { id: 'shopify', name: 'Shopify', bin: 'shopify', version: ['version'], install: 'npm install -g @shopify/cli', login: 'shopify auth login', tokens: ['SHOPIFY_CLI_PARTNERS_TOKEN'] },
  { id: 'stripe', name: 'Stripe', bin: 'stripe', version: ['--version'], install: 'see docs.stripe.com/stripe-cli', login: 'stripe login', tokens: ['STRIPE_API_KEY'] },
  { id: 'sentry', name: 'Sentry', bin: 'sentry-cli', version: ['--version'], whoami: ['info'], account: match(/User:\s*(.+)/i), install: 'npm install -g @sentry/cli', login: 'sentry-cli login', tokens: ['SENTRY_AUTH_TOKEN'] },
  { id: 'render', name: 'Render', bin: 'render', version: ['--version'], whoami: ['whoami'], account: email, install: 'see render.com/docs/cli', login: 'render login', tokens: ['RENDER_API_KEY'] },
  { id: 'npm', name: 'npm', bin: 'npm', version: ['--version'], whoami: ['whoami'], account: firstLine, install: 'comes with Node.js', login: 'npm login', tokens: ['NPM_TOKEN'] },
  { id: 'docker', name: 'Docker', bin: 'docker', version: ['--version'], install: 'see docs.docker.com/engine/install' },
  { id: 'node', name: 'Node.js', bin: 'node', version: ['--version'], install: 'see nodejs.org (or nvm)' },
  { id: 'bun', name: 'Bun', bin: 'bun', version: ['--version'], install: 'curl -fsSL https://bun.sh/install | bash' },
  { id: 'python', name: 'Python', bin: 'python3', version: ['--version'], install: 'sudo apt install python3' },
]

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const CACHE_MS = 5 * 60_000
let cached: ToolsReport | null = null
let running: Promise<ToolsReport> | null = null

/** As the agents' user, in their home: their PATH, their logins. Never with an agent's tokens. */
async function sh(script: string, timeoutMs: number) {
  try {
    return await runAsAgent(['sh', '-lc', script], { cwd: AGENT_HOME, timeoutMs, mergeStderr: true })
  } catch {
    return { code: 1, out: '', timedOut: false }
  }
}

/** Lines that usually mean "not signed in", so a failed check reads that way instead of "unknown". */
const NOT_SIGNED_IN = /not logged in|not authenticated|log ?in|unauthori[sz]ed|no (?:access )?token|credentials|please run .*login|expired/i

async function check(t: ToolDef): Promise<Omit<ToolStatus, 'agentTokens'>> {
  const base = { id: t.id, name: t.name, install: t.install, login: t.login, tokens: t.tokens ?? [] }
  const where = await sh(`command -v ${q(t.bin)}`, 8000)
  const path = where.code === 0 ? firstLine(where.out) : undefined
  if (!path) return { ...base, installed: false, auth: 'na' }
  const ver = t.version ? await sh(`${q(t.bin)} ${t.version.map(q).join(' ')} 2>&1 | head -n 3`, 15000) : null
  const version = ver ? firstLine(ver.out)?.replace(/\s+/g, ' ').slice(0, 80) : undefined
  if (!t.whoami) return { ...base, installed: true, path, version, auth: t.tokens?.length ? 'unknown' : 'na' }
  // CI=1: no prompts, no colours, no update notices; its exit code printed after what it said (the output is cut short)
  const run = await sh(`out=$(CI=1 NO_COLOR=1 ${q(t.bin)} ${t.whoami.map(q).join(' ')} 2>&1 </dev/null); c=$?; printf '%s\n' "$out" | head -n 40; echo "__exit=$c"`, 20000)
  if (run.timedOut) return { ...base, installed: true, path, version, auth: 'unknown', note: 'The check took too long (offline?)' }
  const code = Number(run.out.match(/__exit=(\d+)/)?.[1] ?? 1)
  const said = run.out.replace(/__exit=\d+\s*$/, '').trim()
  if (code !== 0) return { ...base, installed: true, path, version, auth: 'none', note: (said.split('\n').find((l) => NOT_SIGNED_IN.test(l)) ?? firstLine(said))?.slice(0, 160) }
  const account = t.account?.(said)?.slice(0, 80)
  return { ...base, installed: true, path, version, auth: 'ok', ...(account ? { account } : {}) }
}

/** A few at a time: some checks go over the network. */
async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>) {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** Programs in the user's own bin folders that aren't in the list above. */
async function otherBins(): Promise<ToolsReport['others']> {
  const r = await sh('for d in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/.npm-global/bin" "$(npm prefix -g 2>/dev/null)/bin"; do [ -d "$d" ] && for f in "$d"/*; do [ -x "$f" ] && [ ! -d "$f" ] && echo "$f"; done; done 2>/dev/null', 10000)
  const known = new Set(TOOLS.map((t) => t.bin))
  const seen = new Set<string>()
  const out: ToolsReport['others'] = []
  for (const path of r.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const name = path.split('/').pop()!
    if (known.has(name) || seen.has(name) || /^(npx?|corepack|bunx)$/.test(name)) continue
    seen.add(name)
    out.push({ name, path: path.replace(AGENT_HOME, '~') })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80)
}

/** Which agents carry a token for each tool (their Secrets). */
function agentTokensFor(tokens: string[]): ToolStatus['agentTokens'] {
  if (!tokens.length) return []
  const out: ToolStatus['agentTokens'] = []
  for (const a of agentsRepo.all()) for (const s of listSecrets(a.id)) if (tokens.includes(s.name)) out.push({ agentId: a.id, agent: a.name, name: s.name })
  return out
}

export async function toolsReport(fresh = false): Promise<ToolsReport> {
  // the tokens agents have change without a check: always current
  const withTokens = (r: ToolsReport): ToolsReport => ({ ...r, tools: r.tools.map((t) => ({ ...t, agentTokens: agentTokensFor(t.tokens) })) })
  if (!fresh && cached && Date.now() - cached.checkedAt < CACHE_MS) return withTokens(cached)
  if (!running)
    running = (async () => {
      const [tools, others] = await Promise.all([inBatches(TOOLS, 4, check), otherBins()])
      cached = { tools: tools.map((t) => ({ ...t, agentTokens: [] })), others, checkedAt: Date.now() }
      return cached
    })().finally(() => (running = null))
  return withTokens(await running)
}
