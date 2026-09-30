import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicAccess } from '@after-office/shared'
import { AgentError } from '../agents/manager'
import { agentsRepo } from '../db'
import { notify } from '../notify'
import { notifyUser } from './reports'
import { publishWork, timezone } from './work'

// Public access: the dashboard also on the open internet for a while (a server on a domain on the tailnet: setup-vps.sh
// --tailscale --domain … --dns cloudflare). This process has no root: it leaves a request in a folder, and a root
// helper run by systemd (deploy/after-office-access) opens the ports and points the domain at the public IP, or back.
// That helper also turns it off once its time is up, whether this server runs or not. Tailscale stays on throughout.

const dir = () => process.env.OFFICE_ACCESS_DIR ?? '/var/lib/after-office-access'
const REQUEST = () => join(dir(), 'in', 'request')
const STATUS = () => join(dir(), 'out', 'status.json')

/** The longest it may stay on (the helper checks the same). */
export const PUBLIC_MAX_MS = 7 * 24 * 3_600_000

interface HelperStatus {
  supported: boolean
  domain: string | null
  public: boolean
  since: number | null
  until: number | null
  id: string | null
  reason: 'owner' | 'expired' | null
  error: string | null
  at: number
}

function readStatus(): HelperStatus | null {
  try {
    return JSON.parse(readFileSync(STATUS(), 'utf8')) as HelperStatus
  } catch {
    return null
  }
}

/** For the dashboard: can it be switched here, and is it on (until when). */
export function publicAccess(): PublicAccess {
  const s = readStatus()
  if (!s?.supported) return { supported: false, public: false }
  return { supported: true, domain: s.domain ?? undefined, public: s.public, since: s.since ?? undefined, until: s.until ?? undefined }
}

/** Leave a request for the helper and wait for its answer (the status with the same id). */
export async function ask(action: string, timeoutMs = 90_000): Promise<HelperStatus> {
  const id = crypto.randomUUID()
  const line = `${action} ${id}`
  if (!existsSync(join(dir(), 'in'))) throw new AgentError('Public access can be switched only on a server set up with --tailscale --domain … --dns cloudflare', 409)
  // one short write: the .path unit starts the helper when it's closed
  try {
    writeFileSync(REQUEST(), `${line}\n`, { mode: 0o600 })
  } catch (e) {
    // read-only: the dashboard started before the folder existed (systemd only lets it write there if it did)
    const why = e instanceof Error ? e.message : String(e)
    throw new AgentError(`The dashboard can't leave the request (${why.split(',')[0]}). On the VPS: sudo systemctl restart after-office, then try again.`, 500)
  }
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await Bun.sleep(500)
    const s = readStatus()
    if (s?.id === id) return s
  }
  throw new AgentError('The server did not answer in time: check `systemctl status after-office-access.path` on the VPS', 500)
}

const clock = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone(), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms)

/** A report (if there's a manager to file it under) and a security notification, for every change. */
function tell(title: string, text: string) {
  const manager = agentsRepo.manager()
  if (manager) notifyUser(manager.id, title, text)
  void notify('security', title, text)
}

let known: boolean | null = null

/** On until `until` (the route checked the owner's 2FA code). */
export async function startPublicAccess(until: number) {
  const now = Date.now()
  if (!Number.isFinite(until) || until <= now + 60_000 || until > now + PUBLIC_MAX_MS) throw new AgentError('Pick an end between a minute and 7 days from now')
  const s = await ask(`on ${Math.round(until)}`)
  if (s.error) throw new AgentError(s.error, 500)
  known = s.public
  publishWork('publicAccess')
  tell(
    `Public access on until ${clock(until)}`,
    `The dashboard is open on the internet at https://${s.domain} until ${clock(until)}, then back to your tailnet only. Your password and two-factor code are what protect it meanwhile.`,
  )
  return publicAccess()
}

/** Off now (the owner). */
export async function stopPublicAccess() {
  const s = await ask('off')
  known = s.public
  publishWork('publicAccess')
  tell('Public access off', `The dashboard is back to your tailnet only.${s.error ? ` Note: ${s.error}` : ''}`)
  return { ...publicAccess(), warning: s.error ?? undefined }
}

/** Every tick: noticed that the helper turned it off (its time was up), tell the owner. */
export function watchPublicAccess() {
  const s = readStatus()
  if (!s?.supported) return
  if (known === true && !s.public && s.reason === 'expired') {
    publishWork('publicAccess')
    tell('Public access ended', 'Its time was up: the dashboard is back to your tailnet only.')
  } else if (known !== null && known !== s.public) publishWork('publicAccess')
  known = s.public
}
