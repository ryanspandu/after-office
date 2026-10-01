import type { NotifyEvent, OfficeEvent, WorkReport } from '@after-office/shared'
import { agentsRepo, reportsRepo, settingsRepo, tasksRepo } from './db'
import { seal, unseal } from './totp'
import { pushDevices, sendPush } from './push'
import { subscribe } from './agents/registry'
import { officeSettings } from './work/settings'

// Push notifications to the owner's phone when something needs them: an agent asking for permission, work ready for
// review, a failed cron run, a note from the manager, the quota brake. Channels are set up in the dashboard
// (Automation → Notifications; saving one asks for the 2FA code), kept in the database with their secrets encrypted
// (SESSION_SECRET) and never sent back to the browser. The server's .env can set them too, and then wins:
//
//   OFFICE_NTFY_URL=https://ntfy.sh/<your-topic>      (+ OFFICE_NTFY_TOKEN for a protected topic / self-hosted server)
//   OFFICE_TELEGRAM_BOT_TOKEN=…  OFFICE_TELEGRAM_CHAT_ID=…
//   OFFICE_WEBHOOK_URL=https://…                      (POST JSON: { event, title, text, url, at })
//   OFFICE_PUBLIC_URL=https://office.example.com      (link opened from the notification)

interface Channel {
  name: string
  send: (n: { event: NotifyEvent | 'test'; title: string; text: string }) => Promise<void>
}

const env = (k: string) => process.env[k]?.trim() || ''
const PUBLIC_URL = () => env('OFFICE_PUBLIC_URL')

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
}

// ── the channels as set in the dashboard ──
export type ChannelName = 'ntfy' | 'telegram' | 'webhook'
const CHANNELS_KEY = 'notifyChannels'
/** stored: every value sealed (a topic URL or webhook URL is as good as a password) */
type Stored = Partial<Record<ChannelName, Record<string, string>>>

const secret = () => process.env.SESSION_SECRET ?? ''
function stored(): Stored {
  try {
    return JSON.parse(settingsRepo.get(CHANNELS_KEY) ?? '{}') as Stored
  } catch {
    return {}
  }
}
/** One stored channel's values, opened (empty when it can't be read, e.g. SESSION_SECRET changed). */
function opened(name: ChannelName): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(stored()[name] ?? {})) {
    const plain = unseal(v, secret())
    if (plain) out[k] = plain
  }
  return out
}

const FROM_ENV: Record<ChannelName, () => boolean> = {
  ntfy: () => !!env('OFFICE_NTFY_URL'),
  telegram: () => !!(env('OFFICE_TELEGRAM_BOT_TOKEN') && env('OFFICE_TELEGRAM_CHAT_ID')),
  webhook: () => !!env('OFFICE_WEBHOOK_URL'),
}

/** Check and save a channel from the dashboard. Throws a readable message when something is off. */
export function saveChannel(name: ChannelName, input: Record<string, unknown>) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const https = (v: string, what: string) => {
    let u: URL
    try {
      u = new URL(v)
    } catch {
      throw new Error(`${what}: not a valid URL`)
    }
    if (u.protocol !== 'https:') throw new Error(`${what} must start with https://`)
    return u
  }
  let values: Record<string, string>
  if (name === 'ntfy') {
    const u = https(str('url'), 'ntfy topic URL')
    if (!u.pathname.replace(/\//g, '')) throw new Error('Add the topic to the URL, e.g. https://ntfy.sh/your-secret-topic')
    const token = str('token')
    if (token.length > 200) throw new Error('That access token is too long')
    // keep the saved token when the field was left empty (it isn't shown again)
    values = { url: u.toString(), ...(token ? { token } : input.keepToken === true && opened('ntfy').token ? { token: opened('ntfy').token } : {}) }
  } else if (name === 'telegram') {
    const token = str('token') || (input.keepToken === true ? (opened('telegram').token ?? '') : '')
    const chatId = str('chatId')
    if (!/^\d{5,}:[\w-]{30,}$/.test(token)) throw new Error('The bot token looks like 123456789:AA… (from @BotFather)')
    if (!/^(-?\d{3,20}|@[\w]{4,64})$/.test(chatId)) throw new Error('The chat ID is a number (e.g. 123456789, or -100… for a group) or @channelname')
    values = { token, chatId }
  } else {
    values = { url: https(str('url'), 'Webhook URL').toString() }
  }
  const all = stored()
  all[name] = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, seal(v, secret())]))
  settingsRepo.set(CHANNELS_KEY, JSON.stringify(all))
}

export function removeChannel(name: ChannelName) {
  const all = stored()
  delete all[name]
  settingsRepo.set(CHANNELS_KEY, JSON.stringify(all))
}

const tail = (v: string, n = 4) => (v.length > n ? `••••${v.slice(-n)}` : '••••')
/** What the dashboard may see: where each channel comes from and a hint of it, never a secret. */
export function channelStatus() {
  const one = (name: ChannelName) => {
    if (FROM_ENV[name]()) return { source: 'env' as const }
    const v = opened(name)
    if (!Object.keys(v).length) return { source: null }
    const preview =
      name === 'ntfy'
        ? `${new URL(v.url).host}/${tail(new URL(v.url).pathname.replace(/^\/+/, ''))}${v.token ? ' · token saved' : ''}`
        : name === 'telegram'
          ? `bot ${tail(v.token)} → chat ${v.chatId}`
          : `${new URL(v.url).host}/…`
    return { source: 'dashboard' as const, preview }
  }
  return { ntfy: one('ntfy'), telegram: one('telegram'), webhook: one('webhook') }
}

/** Where a tap on an app notification leads. */
const PUSH_URL: Partial<Record<NotifyEvent | 'test', string>> = {
  permission: '/?open=attention',
  review: '/?open=tasks',
  stuck: '/?open=tasks',
  cronFailed: '/?reports=1',
  managerNote: '/?reports=1',
  quota: '/?automation=1',
  security: '/?activity=1',
}

function channels(): Channel[] {
  const out: Channel[] = []
  const dash = { ntfy: opened('ntfy'), telegram: opened('telegram'), webhook: opened('webhook') }
  const ntfyEnv = FROM_ENV.ntfy()
  const ntfy = ntfyEnv ? env('OFFICE_NTFY_URL') : dash.ntfy.url
  if (ntfy) {
    const u = new URL(ntfy)
    const topic = u.pathname.replace(/^\/+|\/+$/g, '')
    const token = ntfyEnv ? env('OFFICE_NTFY_TOKEN') : (dash.ntfy.token ?? '')
    out.push({
      name: 'ntfy',
      // JSON publishing (POST to the server root) keeps titles UTF-8 safe
      send: (n) =>
        post(
          `${u.origin}/`,
          { topic, title: n.title, message: n.text, click: PUBLIC_URL() || undefined, tags: [n.event === 'permission' ? 'raised_hand' : 'office'] },
          token ? { authorization: `Bearer ${token}` } : {},
        ),
    })
  }
  const tgEnv = FROM_ENV.telegram()
  const tgToken = tgEnv ? env('OFFICE_TELEGRAM_BOT_TOKEN') : dash.telegram.token
  const tgChat = tgEnv ? env('OFFICE_TELEGRAM_CHAT_ID') : dash.telegram.chatId
  if (tgToken && tgChat) {
    out.push({
      name: 'telegram',
      send: (n) =>
        post(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          chat_id: tgChat,
          text: [n.title, n.text, PUBLIC_URL()].filter(Boolean).join('\n\n').slice(0, 4000),
          disable_web_page_preview: true,
        }),
    })
  }
  // the dashboard app itself, on the devices that turned notifications on (Web Push): a tap opens what it's about
  const devices = pushDevices().length
  if (devices)
    out.push({
      name: devices === 1 ? 'this app (1 device)' : `this app (${devices} devices)`,
      send: async (n) => {
        const res = await sendPush({ title: n.title, body: n.text, url: PUSH_URL[n.event] ?? '/', tag: n.event })
        const failed = res.filter((r) => !r.ok)
        if (failed.length === res.length && failed.length) throw new Error(failed.map((f) => `${f.device}: ${f.error}`).join('; '))
      },
    })
  const hook = FROM_ENV.webhook() ? env('OFFICE_WEBHOOK_URL') : dash.webhook.url
  if (hook) out.push({ name: 'webhook', send: (n) => post(hook, { event: n.event, title: n.title, text: n.text, url: PUBLIC_URL() || null, at: Date.now() }) })
  return out
}

export const channelNames = () => channels().map((c) => c.name)

// the same message twice within a minute is sent once; and never more than 30 in 10 minutes
const recent = new Map<string, number>()
const sentAt: number[] = []

/** Push to every configured channel, if the event is switched on. Never throws. */
export async function notify(event: NotifyEvent, title: string, text: string) {
  if (!officeSettings().notify[event]) return
  const list = channels()
  if (!list.length) return
  const now = Date.now()
  const key = `${title}\n${text}`
  if (now - (recent.get(key) ?? 0) < 60_000) return
  recent.set(key, now)
  for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k)
  while (sentAt.length && now - sentAt[0] > 600_000) sentAt.shift()
  if (sentAt.length >= 30) return
  sentAt.push(now)
  // minimal (default): commands, report text and such stay on the server; the push only says what happened
  const body = officeSettings().notifyDetail === 'full' ? (text.length > 600 ? `${text.slice(0, 600)}…` : text) : 'Open After Office for the details.'
  await Promise.all(list.map((c) => c.send({ event, title, text: body }).catch((e) => console.warn(`[notify] ${c.name}:`, e.message))))
}

/** "Send test" in the dashboard: every channel, whatever the event switches say. */
export async function sendTest() {
  const list = channels()
  return Promise.all(
    list.map((c) =>
      c
        .send({ event: 'test', title: 'After Office', text: 'Test notification: this channel works.' })
        .then(() => ({ channel: c.name, ok: true as const }))
        .catch((e: Error) => ({ channel: c.name, ok: false as const, error: e.message })),
    ),
  )
}

// ── what triggers them ──

const name = (agentId: string) => agentsRepo.get(agentId)?.name ?? 'An agent'

function onReport(r: WorkReport) {
  // a chat answer the owner asked to keep: they're in that chat, no push for it
  if (r.kind === 'chat') return
  if (r.kind === 'note') return void notify('managerNote', `${name(r.agentId)}: ${r.title}`, r.text)
  // with a quality gate, the notification comes when the check is done (work.ts runGate)
  if (r.kind === 'task' && tasksRepo.get(r.refId)?.checkState === 'running') return
  if (r.kind === 'task') return void notify('review', r.ok ? `${name(r.agentId)} finished "${r.title}"` : `${name(r.agentId)} did not finish "${r.title}"`, r.text)
  if (!r.ok) void notify('cronFailed', `Daily job "${r.title}" did not run`, r.text)
}

export function startNotifications() {
  const seenFollowUps = new Set<string>()
  const seenReports = new Set(reportsRepo.latest(1000).map((r) => r.id))
  subscribe((e: OfficeEvent) => {
    if (e.type === 'followup') {
      if (seenFollowUps.has(e.followUp.id)) return // re-broadcast of the same prompt
      seenFollowUps.add(e.followUp.id)
      if (seenFollowUps.size > 500) seenFollowUps.delete(seenFollowUps.values().next().value!)
      const f = e.followUp
      const what =
        f.kind === 'plan' ? 'has a plan for you to approve' : f.kind === 'question' ? 'has a question' : f.kind === 'delegation' ? 'wants to hand out a task' : f.kind === 'daily' ? 'wants to change a daily job' : `wants to use ${f.tool}`
      void notify('permission', `${name(f.agentId)} ${what}`, f.message)
    } else if (e.type === 'work' && e.work.reports) {
      for (const r of e.work.reports) {
        if (seenReports.has(r.id)) continue
        seenReports.add(r.id)
        onReport(r)
      }
    }
  })
}
