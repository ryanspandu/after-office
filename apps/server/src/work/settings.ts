import type { NotifyEvent, OfficeSettings } from '@after-office/shared'
import { settingsRepo } from '../db'

// Office-wide automation settings (notifications, quota brake), kept in the settings table as one JSON value.

export const NOTIFY_EVENTS: NotifyEvent[] = ['permission', 'review', 'cronFailed', 'managerNote', 'quota', 'stuck', 'security']

export const DEFAULT_SETTINGS: OfficeSettings = {
  notify: { permission: true, review: true, cronFailed: true, managerNote: true, quota: true, stuck: true, security: true },
  notifyDetail: 'minimal',
  quota: { enabled: true, threshold: 80 },
  managerApproval: false,
  autoAssign: false,
  parallelSessions: 0,
}

/** Most parallel sessions per agent the owner can allow. */
export const MAX_PARALLEL_SESSIONS = 10
const cleanParallel = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_PARALLEL_SESSIONS, Math.max(0, Math.round(v))) : undefined)

const KEY = 'office'

export function officeSettings(): OfficeSettings {
  const saved = (() => {
    try {
      return JSON.parse(settingsRepo.get(KEY) ?? '{}') as Partial<OfficeSettings>
    } catch {
      return {}
    }
  })()
  return {
    notify: { ...DEFAULT_SETTINGS.notify, ...saved.notify },
    quota: { ...DEFAULT_SETTINGS.quota, ...saved.quota },
    notifyDetail: saved.notifyDetail === 'full' ? 'full' : 'minimal',
    managerApproval: saved.managerApproval ?? DEFAULT_SETTINGS.managerApproval,
    autoAssign: saved.autoAssign ?? DEFAULT_SETTINGS.autoAssign,
    parallelSessions: cleanParallel(saved.parallelSessions) ?? DEFAULT_SETTINGS.parallelSessions,
  }
}

/** Validate and store a partial update; returns the full new settings. */
export function updateSettings(patch: {
  notify?: Partial<Record<NotifyEvent, unknown>>
  quota?: { enabled?: unknown; threshold?: unknown }
  managerApproval?: unknown
  autoAssign?: unknown
  notifyDetail?: unknown
  parallelSessions?: unknown
}) {
  const cur = officeSettings()
  const notify = { ...cur.notify }
  for (const k of NOTIFY_EVENTS) if (typeof patch.notify?.[k] === 'boolean') notify[k] = patch.notify[k] as boolean
  const quota = { ...cur.quota }
  if (typeof patch.quota?.enabled === 'boolean') quota.enabled = patch.quota.enabled
  const th = Number(patch.quota?.threshold)
  if (patch.quota?.threshold !== undefined && Number.isFinite(th)) quota.threshold = Math.min(99, Math.max(10, Math.round(th)))
  const next: OfficeSettings = {
    notify,
    notifyDetail: patch.notifyDetail === 'full' || patch.notifyDetail === 'minimal' ? patch.notifyDetail : cur.notifyDetail,
    quota,
    managerApproval: typeof patch.managerApproval === 'boolean' ? patch.managerApproval : cur.managerApproval,
    autoAssign: typeof patch.autoAssign === 'boolean' ? patch.autoAssign : cur.autoAssign,
    parallelSessions: cleanParallel(patch.parallelSessions) ?? cur.parallelSessions,
  }
  settingsRepo.set(KEY, JSON.stringify(next))
  return next
}

// ── Boss mode ──
// For a night of work the owner trusts the manager with: it delegates, messages agents and sends work back without
// asking (no approvals, no injection guard), until the time the owner picked. Turned on only with a fresh 2FA code
// (routes/work.ts), never through updateSettings. Hires, connector writes, quality checks and the agents' own
// permission prompts stay as they are.

const BOSS_KEY = 'bossMode'
export interface BossModeState {
  since: number
  until: number
  /** what the manager did while it was on, for the report when it ends */
  tasks: number
  messages: number
  sendBacks: number
}

/** The saved state, even past its end (tickTasks ends it and reports). */
export function bossModeState(): BossModeState | null {
  try {
    const b = JSON.parse(settingsRepo.get(BOSS_KEY) ?? 'null') as BossModeState | null
    return b && typeof b.until === 'number' ? b : null
  } catch {
    return null
  }
}

/** On right now? */
export const bossMode = (now = Date.now()) => {
  const b = bossModeState()
  return b && b.until > now ? b : null
}

export function saveBossMode(b: BossModeState | null) {
  if (b) settingsRepo.set(BOSS_KEY, JSON.stringify(b))
  else settingsRepo.delete(BOSS_KEY)
}

/** Count one thing the manager did in Boss mode. */
export function countBoss(what: 'tasks' | 'messages' | 'sendBacks') {
  const b = bossMode()
  if (b) saveBossMode({ ...b, [what]: b[what] + 1 })
}
