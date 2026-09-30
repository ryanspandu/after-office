import { useEffect, useRef } from 'react'
import { useActivityLive } from './activity'
import { create } from 'zustand'
import type { AgentEffort, AgentInfo, AutomationStatus, BossMode, FollowUpDecision, LiveFollowUp, LiveMode, NotifyEvent, OfficeEvent, OfficeSettings, RateLimits, TaskArchivePage, TaskComment, TaskDiff, WorkState, Workspace, GitCommit } from '@after-office/shared'
import { api, useAuth } from './auth'
import { mergeServer, useDashboard, ymd } from './dashboard'
import { useOffice } from './store'
import { useClock } from './clock'

// Live mode: the office mirrors real Claude Code sessions on the server via SSE (/api/events).
// Everything visual is derived from those events; nothing here calls an LLM.

interface LiveStore {
  connected: boolean
  followUps: LiveFollowUp[]
  rateLimits: RateLimits | null
  system: { cpu: number; memUsedGb: number; memTotalGb: number } | null
  /** Prompts waiting for a busy agent (cron slots, task starts), by agent id. */
  queued: Record<string, number>
  /** agent id → until when to show the "just got a task from the manager" marker */
  briefings: Record<string, number>
  /** Done tasks archived on the server (not in the task lists; see ArchiveModal). */
  archivedTasks: number
  /** the first snapshot arrived: until then lists are empty because nothing loaded yet, not because there's nothing */
  ready: boolean
  /** office automation settings (notifications, quota brake) and what the server reports about them */
  settings: OfficeSettings | null
  automation: AutomationStatus
  /** Boss mode: the manager works without approvals until then (null: off) */
  bossMode: BossMode | null
}

export const useLive = create<LiveStore>(() => ({ connected: false, followUps: [], rateLimits: null, system: null, queued: {}, briefings: {}, archivedTasks: 0, ready: false, settings: null, automation: { channels: [], quotaPaused: null }, bossMode: null }))

/** Task timelines, loaded per task when one is opened (useTaskComments) and kept current by the SSE stream. */
export const useComments = create<{ byTask: Record<string, TaskComment[]> }>(() => ({ byTask: {} }))

/** Server-owned tasks, projects, cron jobs and office timezone replace the local copies. */
function applyWork(work: Partial<WorkState>) {
  const local = useDashboard.getState()
  const patch: Partial<typeof local> = {}
  if (work.tasks) patch.tasks = mergeServer(work.tasks, local.tasks)
  if (work.projects) patch.projects = mergeServer(work.projects, local.projects)
  if (work.crons) patch.crons = mergeServer(work.crons, local.crons)
  if (work.reports) patch.reports = mergeServer(work.reports, local.reports)
  if (work.tags) patch.tags = mergeServer(work.tags, local.tags)
  if (Object.keys(patch).length) useDashboard.setState(patch)
  // not setTimezone: that would echo the value back to the server
  if (work.timezone) useClock.getState().syncTimezone(work.timezone)
  if (work.queued) useLive.setState({ queued: work.queued })
  if (work.archivedTasks !== undefined) useLive.setState({ archivedTasks: work.archivedTasks })
  if (work.settings) useLive.setState({ settings: work.settings })
  if (work.automation) useLive.setState({ automation: work.automation })
  if (work.bossMode !== undefined) useLive.setState({ bossMode: work.bossMode })
}

const BRIEFING_MS = 8000

function apply(e: OfficeEvent) {
  const office = useOffice.getState()
  switch (e.type) {
    case 'snapshot':
      office.setLiveAgents(e.agents)
      useLive.setState({ followUps: e.followUps, rateLimits: e.rateLimits, ready: true })
      // a snapshot is the whole truth: anything it leaves out is empty (never keep demo samples in live mode)
      applyWork({ ...e.work, reports: e.work.reports ?? [], queued: e.work.queued ?? {} })
      break
    case 'work':
      applyWork(e.work)
      break
    case 'briefing': {
      // the manager handed someone a task: show a marker on their name tag for a few seconds
      const until = Date.now() + BRIEFING_MS
      useLive.setState((s) => ({ briefings: { ...s.briefings, [e.to]: until } }))
      setTimeout(() => {
        useLive.setState((s) => {
          if ((s.briefings[e.to] ?? 0) > Date.now()) return s
          const { [e.to]: _, ...rest } = s.briefings
          return { briefings: rest }
        })
      }, BRIEFING_MS + 50)
      break
    }
    case 'agent':
      office.upsertLiveAgent(e.agent)
      break
    case 'remove':
      office.removeAgent(e.id)
      break
    case 'followup':
      useLive.setState((s) => ({ followUps: [...s.followUps.filter((f) => f.id !== e.followUp.id), e.followUp] }))
      break
    case 'followup-resolved':
      useLive.setState((s) => ({ followUps: s.followUps.filter((f) => f.id !== e.id) }))
      break
    case 'comment':
      useComments.setState((s) => {
        const list = s.byTask[e.comment.taskId]
        if (!list || list.some((c) => c.id === e.comment.id)) return s
        return { byTask: { ...s.byTask, [e.comment.taskId]: [...list, e.comment] } }
      })
      break
    case 'comment-removed':
      useComments.setState((s) => {
        const list = s.byTask[e.taskId]
        return list ? { byTask: { ...s.byTask, [e.taskId]: list.filter((c) => c.id !== e.id) } } : s
      })
      break
    case 'activity':
      useActivityLive.getState().push(e.entry)
      break
    case 'rate-limits':
      if (!same(useLive.getState().rateLimits, e.rateLimits)) useLive.setState({ rateLimits: e.rateLimits })
      break
    case 'usage':
      useDashboard.setState((s) => {
        const usage = [...s.usage]
        const i = usage.findIndex((u) => u.date === e.date && u.agentId === e.agentId)
        if (i === -1) usage.push({ date: e.date, agentId: e.agentId, input: e.input, output: e.output })
        else usage[i] = { ...usage[i], input: usage[i].input + e.input, output: usage[i].output + e.output }
        return { usage }
      })
      break
  }
}

async function loadUsage() {
  const from = ymd(new Date(Date.now() - 90 * 86_400_000))
  const res = await api(`/api/usage?from=${from}`)
  if (!res.ok) return
  const rows: { date: string; agent_id: string; input: number; output: number }[] = await res.json()
  useDashboard.setState({ usage: rows.map((r) => ({ date: r.date, agentId: r.agent_id, input: r.input, output: r.output })) })
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * CPU / RAM for the navbar (plan usage also arrives over SSE). Only changes are stored: an identical poll must not
 * re-render anything. Skipped while the tab is hidden.
 */
async function loadSystem() {
  if (document.visibilityState === 'hidden') return
  const res = await api('/api/system')
  if (!res.ok) return
  const { rateLimits, ...raw } = await res.json()
  // rounded so tiny wobbles don't count as changes
  const system = { cpu: Math.round(raw.cpu), memUsedGb: Math.round(raw.memUsedGb * 10) / 10, memTotalGb: raw.memTotalGb }
  const live = useLive.getState()
  if (!same(live.system, system)) {
    useLive.setState({ system })
    useDashboard.getState().setMetrics(system)
  }
  if (rateLimits && !same(live.rateLimits, rateLimits)) useLive.setState({ rateLimits })
}

/** Connects to the server while the dashboard is in live mode; reconnects on drop. */
export function useLiveSync() {
  const source = useOffice((s) => s.source)
  const signedIn = useAuth((s) => s.status === 'signed-in')
  const prevSource = useRef(source)

  useEffect(() => {
    // leaving live mode: put the sample tasks/crons back so demo mode never shows (or edits) server data
    if (prevSource.current === 'live' && source === 'demo') useDashboard.getState().loadDemoWork()
    prevSource.current = source
  }, [source])

  useEffect(() => {
    if (source !== 'live' || !signedIn) return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout>
    let closed = false
    // The server pings every 10 s. A stream that goes quiet is dead even if it looks open (e.g. the dev proxy keeps
    // it open across a server restart): drop it and reconnect, which brings a fresh snapshot.
    let lastHeard = Date.now()
    const fail = (src: EventSource) => {
      if (es !== src) return // already handled
      useLive.setState({ connected: false })
      src.close()
      es = null
      scheduleRetry()
    }
    const scheduleRetry = () => {
      if (closed) return
      retry = setTimeout(async () => {
        try {
          // a 401 means the session expired: go back to the login page instead of retrying forever
          const me = await fetch('/api/auth/me')
          if (me.status === 401) useAuth.getState().expire()
          else if (me.ok) connect()
          else scheduleRetry()
        } catch {
          scheduleRetry() // server unreachable: keep trying
        }
      }, 3000)
    }
    const watchdog = setInterval(() => {
      if (es && Date.now() - lastHeard > 35_000) fail(es)
    }, 5_000)
    const connect = () => {
      lastHeard = Date.now()
      const src = new EventSource('/api/events')
      es = src
      src.addEventListener('office', (m) => {
        lastHeard = Date.now()
        apply(JSON.parse((m as MessageEvent).data))
      })
      src.addEventListener('ping', () => (lastHeard = Date.now()))
      src.onopen = () => {
        useLive.setState({ connected: true })
        loadUsage()
      }
      src.onerror = () => fail(src)
    }
    connect()
    loadSystem()
    const sys = setInterval(loadSystem, 5000)

    // Back in the foreground (phones suspend background tabs and installed apps): a stream that went quiet is
    // replaced right away instead of waiting for the watchdog, and the snapshot brings everything up to date.
    const onResume = () => {
      if (closed || document.visibilityState !== 'visible') return
      if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastHeard > 10_000) {
        clearTimeout(retry)
        if (es) {
          const old = es
          es = null
          old.close()
        }
        useLive.setState({ connected: false })
        connect()
      }
      void loadSystem()
    }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('pageshow', onResume)
    return () => {
      closed = true
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('pageshow', onResume)
      clearTimeout(retry)
      clearInterval(watchdog)
      clearInterval(sys)
      es?.close()
      useLive.setState({ connected: false })
    }
  }, [source, signedIn])
}

// ── actions (all go to the server; the SSE stream brings the result back) ──

async function call(path: string, body?: unknown, method = 'POST') {
  const res = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`)
  return res.json()
}

/** A file attached in the chat, kept on the server until the message is sent. */
export interface StagedUpload {
  id: string
  name: string
  size: number
  image?: boolean
}

export const liveApi = {
  setPinned: (id: string, pinned: boolean) => call(`/api/agents/${id}/pin`, { pinned }, 'PUT'),
  setFigure: (id: string, figure: 'man' | 'woman') => call(`/api/agents/${id}/figure`, { figure }, 'PUT'),
  /** a new random look for its character (hair, hat, glasses…), same figure */
  shuffleStyle: (id: string) => call(`/api/agents/${id}/style`, {}) as Promise<{ style: number }>,
  createAgent: (a: { name: string; cwd: string; tmuxSession?: string; model?: string; permissionMode?: LiveMode; role?: string; profile?: unknown; kind?: 'worker' | 'manager'; figure?: 'man' | 'woman'; rules?: string[] }) =>
    call('/api/agents', a) as Promise<AgentInfo>,
  deleteAgent: (id: string, opts?: { folder?: boolean }) => call(`/api/agents/${id}${opts?.folder ? '?folder=1' : ''}`, undefined, 'DELETE'),
  /** Whether an agent's folder can be deleted with it (its own one in the agents' folder), and how much is in it. */
  agentFolder: async (id: string): Promise<{ folder: string; deletable: boolean; entries: number }> => {
    const r = await api(`/api/agents/${id}/folder`)
    return r.ok ? r.json() : { folder: '', deletable: false, entries: 0 }
  },
  /** `uploads`: ids of files attached (staged) for this message; the server moves them into the agent's folder */
  prompt: (id: string, text: string, uploads: string[] = []) => call(`/api/agents/${id}/prompt`, { text, ...(uploads.length ? { uploads } : {}) }),
  /** Attach a file in the chat: staged on the server until the message is sent (then it goes into the agent's folder). */
  upload: async (id: string, file: File): Promise<StagedUpload> => {
    // raw bytes + the name in a header (the server's one exception to JSON-only writes, see auth.ts)
    const res = await api(`/api/agents/${id}/uploads`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } })
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status})`)
    return res.json()
  },
  /** A staged attachment removed from the message (or the message never sent): deleted on the server. */
  discardUpload: (id: string, upload: string, keepalive = false) =>
    api(`/api/agents/${id}/uploads/${upload}`, { method: 'DELETE', keepalive }).catch(() => undefined),
  setMode: (id: string, mode: LiveMode) => call(`/api/agents/${id}/mode`, { mode }) as Promise<{ mode: LiveMode; deferred?: boolean }>,
  setModel: (id: string, model: string) => call(`/api/agents/${id}/model`, { model }),
  /** thinking effort (null: Claude Code's default); restarts the session, conversation kept */
  setEffort: (id: string, effort: AgentEffort | null) => call(`/api/agents/${id}/effort`, { effort }),
  changeFolder: (id: string, cwd: string) => call(`/api/agents/${id}/folder`, { cwd }) as Promise<AgentInfo>,
  restart: (id: string) => call(`/api/agents/${id}/restart`, {}),
  /** who the agent's commits are by ('' clears) */
  setGit: (id: string, git: { name: string; email: string }) => call(`/api/agents/${id}/git`, git, 'PUT'),
  /** an SSH key for the agent's default identity, or for one of its extra identities (only the public half comes back) */
  generateSshKey: (id: string, identity?: string) => call(`/api/agents/${id}/ssh/generate${identity ? `?identity=${identity}` : ''}`, {}) as Promise<{ publicKey: string; fingerprint: string }>,
  uploadSshKey: (id: string, privateKey: string, identity?: string) => call(`/api/agents/${id}/ssh${identity ? `?identity=${identity}` : ''}`, { privateKey }, 'PUT') as Promise<{ publicKey: string; fingerprint: string }>,
  removeSshKey: (id: string, identity?: string) => call(`/api/agents/${id}/ssh${identity ? `?identity=${identity}` : ''}`, undefined, 'DELETE'),
  /** extra git identities: each for the folders / repos in `match` */
  addGitIdentity: (id: string, g: { label: string; name: string; email: string; match: string[] }) => call(`/api/agents/${id}/git/identities`, g),
  updateGitIdentity: (id: string, gid: string, g: { label: string; name: string; email: string; match: string[] }) => call(`/api/agents/${id}/git/identities/${gid}`, g, 'PUT'),
  removeGitIdentity: (id: string, gid: string) => call(`/api/agents/${id}/git/identities/${gid}`, undefined, 'DELETE'),
  /** Can the agents' tmux server still start sessions? (isolated: the VPS setup, restarted with systemd instead) */
  agentServer: () => api('/api/agents-server').then((r) => (r.ok ? (r.json() as Promise<{ canStartSessions: boolean; isolated: boolean }>) : null)),
  /** Restart every agent (their tmux server): each resumes its conversation. */
  restartAgentServer: () => call('/api/agents-server/restart', {}) as Promise<{ restarted: number }>,
  revokeDir: (id: string, dir: string) => call(`/api/agents/${id}/dirs`, { dir }, 'DELETE'),
  interrupt: (id: string) => call(`/api/agents/${id}/interrupt`, {}),
  markChatRead: (id: string) => call(`/api/agents/${id}/read`, {}),
  reviseTask: (taskId: string, feedback: string) => call(`/api/tasks/${taskId}/revise`, { feedback }) as Promise<{ result: 'sent' | 'queued' }>,
  startTask: (taskId: string, agentId?: string) => call(`/api/tasks/${taskId}/start`, { agentId }) as Promise<{ result: 'sent' | 'queued' }>,
  taskArchive: async (q: string, offset = 0): Promise<TaskArchivePage> => {
    const res = await api(`/api/tasks/archive?${new URLSearchParams({ q, offset: String(offset) })}`)
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`)
    return res.json()
  },
  comments: async (taskId: string): Promise<TaskComment[]> => {
    const res = await api(`/api/tasks/${taskId}/comments`)
    if (!res.ok) throw new Error(`Could not load the timeline (${res.status})`)
    return res.json()
  },
  addComment: (taskId: string, text: string) => call(`/api/tasks/${taskId}/comments`, { text }) as Promise<TaskComment>,
  deleteComment: (id: string) => call(`/api/comments/${id}`, undefined, 'DELETE'),
  saveAutomation: (patch: {
    notify?: Partial<Record<NotifyEvent, boolean>>
    quota?: Partial<OfficeSettings['quota']>
    managerApproval?: boolean
    autoAssign?: boolean
  }) => call('/api/automation', patch, 'PUT'),
  taskDiff: async (taskId: string): Promise<TaskDiff> => {
    const res = await api(`/api/tasks/${taskId}/diff`)
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Could not load changes (${res.status})`)
    return res.json()
  },
  cronTrigger: async (cronId: string): Promise<{ url: string; token: string | null } | null> => {
    const res = await api(`/api/crons/${cronId}/trigger`)
    return res.ok ? res.json() : null
  },
  createCronTrigger: (cronId: string) => call(`/api/crons/${cronId}/trigger`, {}) as Promise<{ url: string; token: string }>,
  removeCronTrigger: (cronId: string) => call(`/api/crons/${cronId}/trigger`, undefined, 'DELETE'),
  /** Turn Boss mode on: the authenticator code, how long, and whether the tasks waiting for approval start too. */
  startBossMode: (body: { code: string; hours?: number; until?: number; runWaiting?: boolean }) => call('/api/boss-mode', body) as Promise<{ until: number; started: number }>,
  stopBossMode: () => call('/api/boss-mode', undefined, 'DELETE'),
  testNotifications: () => call('/api/automation/test', {}) as Promise<{ results: { channel: string; ok: boolean; error?: string }[] }>,
  workspaces: async (fresh = false): Promise<Workspace[]> => {
    const res = await api(`/api/workspaces${fresh ? '?fresh=1' : ''}`)
    if (!res.ok) throw new Error(`Could not read the agents' folders (${res.status})`)
    return res.json()
  },
  /** Whether a project's folder can be deleted with it (one the office made), and how many entries it holds. */
  projectFolder: async (id: string): Promise<{ folder: string | null; deletable: boolean; entries: number }> => {
    const r = await api(`/api/projects/${id}/folder`)
    if (!r.ok) return { folder: null, deletable: false, entries: 0 }
    return r.json()
  },
  commits: async (path: string): Promise<GitCommit[]> => {
    const res = await api(`/api/workspaces/commits?${new URLSearchParams({ path })}`)
    return res.ok ? res.json() : []
  },
  restoreTask: (taskId: string) => call(`/api/tasks/${taskId}/restore`, {}),
  deleteTask: (taskId: string) => call(`/api/tasks/${taskId}`, undefined, 'DELETE'),
  decide: (followUpId: string, d: FollowUpDecision) => call(`/api/followups/${encodeURIComponent(followUpId)}/decision`, d),
}

if (import.meta.env.DEV) Object.assign(window, { __live: useLive })

/** A task's timeline: fetched once when first shown, then updated live. */
export function useTaskComments(taskId: string) {
  const list = useComments((s) => s.byTask[taskId])
  const live = useOffice((s) => s.source === 'live')
  useEffect(() => {
    if (!live) return
    let gone = false
    liveApi
      .comments(taskId)
      .then((c) => !gone && useComments.setState((s) => ({ byTask: { ...s.byTask, [taskId]: c } })))
      .catch(() => {})
    return () => void (gone = true)
  }, [taskId, live])
  return list
}

/** Empty-state texts ("All clear", "No daily jobs yet") only once there's data to judge by (demo: always). */
export function useWorkReady() {
  const demo = useOffice((s) => s.source === 'demo')
  const ready = useLive((s) => s.ready)
  return demo || ready
}
