import webpush from 'web-push'
import { settingsRepo } from './db'
import { seal, unseal } from './totp'

// Web Push: notifications straight to the dashboard app on a phone or computer (Android, desktop browsers, and iOS
// 16.4+ once the app is on the Home Screen). No account anywhere: the server has its own VAPID key pair, made once;
// each device that turns notifications on leaves a subscription here. Messages go through the browser's push service
// (Google, Apple, Mozilla) encrypted for that device only: they can't read them.

const KEYS = 'webPushKeys'
const SUBS = 'webPushSubs'

export interface PushDevice {
  id: string
  /** "Chrome on Android" etc., from the browser that turned it on */
  label: string
  createdAt: number
  lastOkAt?: number
}
interface Sub extends PushDevice {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

const secret = () => process.env.SESSION_SECRET ?? ''

/** The server's key pair (the private half sealed with SESSION_SECRET); made on first use. */
function keys(): { publicKey: string; privateKey: string } {
  try {
    const k = JSON.parse(settingsRepo.get(KEYS) ?? 'null') as { publicKey: string; privateKey: string } | null
    const priv = k ? unseal(k.privateKey, secret()) : null
    if (k && priv) return { publicKey: k.publicKey, privateKey: priv }
  } catch {
    // made anew below (devices then turn notifications on again)
  }
  const fresh = webpush.generateVAPIDKeys()
  settingsRepo.set(KEYS, JSON.stringify({ publicKey: fresh.publicKey, privateKey: seal(fresh.privateKey, secret()) }))
  settingsRepo.delete(SUBS)
  return fresh
}

export const pushPublicKey = () => keys().publicKey

function subs(): Sub[] {
  try {
    return JSON.parse(settingsRepo.get(SUBS) ?? '[]') as Sub[]
  } catch {
    return []
  }
}
const saveSubs = (list: Sub[]) => settingsRepo.set(SUBS, JSON.stringify(list))

/** The devices notified (no endpoints or keys: those stay here). */
export const pushDevices = (): PushDevice[] => subs().map(({ id, label, createdAt, lastOkAt }) => ({ id, label, createdAt, ...(lastOkAt ? { lastOkAt } : {}) }))

// push services the browsers use; anything else is refused (the server would otherwise POST wherever it's told)
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.microsoft\.com$/]

/** Add (or refresh) a device's subscription. Returns its id. */
export function addPushDevice(input: unknown, label: string): string {
  const s = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
  const endpoint = typeof s?.endpoint === 'string' ? s.endpoint : ''
  const p256dh = typeof s?.keys?.p256dh === 'string' ? s.keys.p256dh : ''
  const auth = typeof s?.keys?.auth === 'string' ? s.keys.auth : ''
  let host = ''
  try {
    const u = new URL(endpoint)
    if (u.protocol === 'https:') host = u.hostname
  } catch {
    // not a URL
  }
  if (!host || !PUSH_HOSTS.some((re) => re.test(host))) throw new Error("That isn't a browser push subscription")
  if (!/^[\w-]{40,200}$/.test(p256dh) || !/^[\w-]{10,50}$/.test(auth)) throw new Error('Incomplete push subscription')
  const list = subs().filter((x) => x.endpoint !== endpoint)
  if (list.length >= 20) list.shift()
  const id = crypto.randomUUID()
  list.push({ id, label: label.slice(0, 80) || 'A browser', createdAt: Date.now(), endpoint, keys: { p256dh, auth } })
  saveSubs(list)
  return id
}

export function removePushDevice(id: string) {
  saveSubs(subs().filter((x) => x.id !== id))
}

/** Which device an endpoint belongs to (the dashboard asks "is this browser on?"). */
export const pushDeviceFor = (endpoint: string) => subs().find((x) => x.endpoint === endpoint)?.id ?? null

export interface PushMessage {
  title: string
  body: string
  /** opened when the notification is tapped (a path of the dashboard) */
  url?: string
  /** a newer one with the same tag replaces the older on the device */
  tag?: string
}

/**
 * Send to every device (or one). A subscription the push service says is gone (404/410: the app was removed, or
 * notifications turned off) is dropped. Returns per-device results; never throws.
 */
export async function sendPush(msg: PushMessage, onlyId?: string) {
  const list = subs().filter((s) => !onlyId || s.id === onlyId)
  if (!list.length) return []
  const k = keys()
  const subject = process.env.OFFICE_PUBLIC_URL?.startsWith('https://') ? process.env.OFFICE_PUBLIC_URL : 'mailto:after-office@localhost'
  const payload = JSON.stringify({ title: msg.title, body: msg.body.slice(0, 1000), url: msg.url ?? '/', tag: msg.tag })
  const gone: string[] = []
  const ok: string[] = []
  const results = await Promise.all(
    list.map(async (s) => {
      try {
        const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: s.keys }, payload, {
          vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey },
          TTL: 24 * 3600,
          urgency: 'high',
        })
        const res = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: new Uint8Array(d.body as Buffer), signal: AbortSignal.timeout(10_000) })
        if (res.status === 404 || res.status === 410) {
          gone.push(s.id)
          return { device: s.label, ok: false as const, error: 'no longer subscribed (removed)' }
        }
        if (!res.ok) return { device: s.label, ok: false as const, error: `${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}` }
        ok.push(s.id)
        return { device: s.label, ok: true as const }
      } catch (e) {
        return { device: s.label, ok: false as const, error: e instanceof Error ? e.message : 'failed' }
      }
    }),
  )
  if (gone.length || ok.length) {
    const now = Date.now()
    saveSubs(subs().filter((s) => !gone.includes(s.id)).map((s) => (ok.includes(s.id) ? { ...s, lastOkAt: now } : s)))
  }
  return results
}
