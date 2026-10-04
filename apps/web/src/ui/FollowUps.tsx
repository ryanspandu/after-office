import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { dateTime } from './when'
import { useShallow } from 'zustand/react/shallow'
import ReactMarkdown, { type Components } from 'react-markdown'
import { create } from 'zustand'
import remarkGfm from 'remark-gfm'
import { FILE_HREF, FileLinkButton, remarkFileLinks, useFileLinks } from './fileLinks'
import { LuUserPlus, LuCrown, LuCheck, LuCircleHelp, LuClipboardList, LuEye, LuMaximize2, LuSend, LuShieldAlert, LuX, LuCalendarClock, LuUser, LuMessageSquareReply } from 'react-icons/lu'
import { DEFAULT_MODEL, defaultRulePacks, isEffort, isModelChoice, MODELS, type AgentEffort, type AgentFigure, type FollowUp, type FollowUpDecision, type HireEdits, type LiveFollowUp } from '@after-office/shared'
import { EFFORT_OPTIONS } from './effort'
import { liveApi, useLive, useWorkReady } from '../state/live'
import { useNow } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { useOffice } from '../state/store'
import { Field, Modal } from './Modal'
import { DockSheet } from './DockSheet'
import { Select } from './Select'
import { FigurePicker } from './FigurePicker'
import { useConnectors } from './agent/ConnectorsTab'
import { useLaunch } from '../pwa/launch'
import { MOBILE } from '../state/useMediaQuery'
import { useBranding } from '../state/branding'
import { RulesPicker } from './RulesPicker'
import { openUrl } from '../state/url'

// Human-in-the-loop queue: live permission prompts from waiting agents, plan approvals, questions and reviews.

const KIND: Record<FollowUp['kind'], { label: string; icon: ReactNode }> = {
  plan: { label: 'Plan', icon: <LuClipboardList /> },
  permission: { label: 'Permission', icon: <LuShieldAlert /> },
  question: { label: 'Question', icon: <LuCircleHelp /> },
  review: { label: 'Review', icon: <LuEye /> },
  delegation: { label: 'New task', icon: <LuCrown /> },
  hire: { label: 'Hire', icon: <LuUserPlus /> },
  check: { label: 'Check', icon: <LuShieldAlert /> },
  daily: { label: 'Daily job', icon: <LuCalendarClock /> },
}

/** Things the manager asked the owner to approve. */
const APPROVAL = new Set<FollowUp['kind']>(['delegation', 'hire', 'check', 'daily'])

/** How the human answered. Phase 2 turns this into keystrokes/text for the agent's tmux session. */
export type Decision =
  | { type: 'approve'; mode?: 'auto' | 'manual' | 'always'; note?: string; hire?: HireEdits }
  | { type: 'reject'; note?: string }
  | { type: 'reply'; text: string }
  | { type: 'answers'; answers: Record<string, string | string[]> }
  | { type: 'plan-option'; option: string; note?: string }

/** AskUserQuestion input (live questions come with Claude's own options). */
export interface Question {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** planOptions: the live plan dialog's own choices, read from the agent's screen by the server. */
export type Item = FollowUp & { sessionKey?: string; questions?: Question[]; live?: boolean; planOptions?: string[]; hire?: Required<Omit<HireEdits, 'figure'>> & { figure?: AgentFigure } }

/** Server follow-up → the card/modal shape. */
/** "mcp__claude_ai_Apify_Trending_Now__get-dataset-items" → "Apify Trending Now · get-dataset-items". */
export function toolLabel(tool: string) {
  const m = tool.match(/^mcp__(.+?)__(.+)$/)
  if (!m) return tool
  const server = m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')
  return `${server} · ${m[2]}`
}

/** "Marcus · session 2" for a prompt asked in one of its side sessions. */
const withSession = (name: string, key?: string) => (key ? `${name} · session ${key.slice(1)}` : name)

export function fromLive(f: LiveFollowUp): Item {
  const input = f.input as Record<string, unknown>
  const base = { id: f.id, agentId: f.agentId, ...(f.sessionKey ? { sessionKey: f.sessionKey } : {}), message: f.message, createdAt: f.createdAt, tool: toolLabel(f.tool), live: true }
  if (f.kind === 'plan')
    return { ...base, kind: 'plan', detail: String(input.plan ?? ''), planOptions: Array.isArray(input.options) ? (input.options as string[]) : undefined }
  if (f.kind === 'question') return { ...base, kind: 'question', questions: (input.questions as Question[]) ?? [] }
  if (f.kind === 'hire') {
    const brief = String(input.brief ?? '').trim()
    return {
      ...base,
      kind: 'hire',
      tool: undefined,
      // name, role, model, mode and character are editable in the details (the owner can change them before hiring)
      hire: {
        name: String(input.name ?? ''),
        role: String(input.role ?? ''),
        model: isModelChoice(input.model) ? input.model : DEFAULT_MODEL,
        mode: (['default', 'acceptEdits', 'plan', 'auto'].includes(String(input.mode)) ? input.mode : 'auto') as 'default' | 'acceptEdits' | 'plan' | 'auto',
        ...(input.figure === 'man' || input.figure === 'woman' ? { figure: input.figure as AgentFigure } : {}),
        connectors: Array.isArray(input.connectors) ? (input.connectors as unknown[]).filter((c): c is string => typeof c === 'string') : [],
        effort: isEffort(input.effort) ? input.effort : null,
        rules: Array.isArray(input.rules) ? (input.rules as unknown[]).filter((r): r is string => typeof r === 'string') : defaultRulePacks(String(input.role ?? '')),
      },
      detail: [
        `**Folder:** \`${String(input.folder)}\` (follows the name if you change it)`,
        brief ? `**Brief (CLAUDE.md):**\n\n${brief}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  }
  if (f.kind === 'check') {
    return {
      ...base,
      kind: 'check',
      tool: undefined,
      command: String(input.command ?? ''),
      detail: [
        `**Task:** ${String(input.title ?? '')}`,
        input.previous ? `**Replaces:** \`${String(input.previous)}\`` : '',
        "Runs on the server in the agent's folder every time it finishes this task, without asking again. Approve only a command you'd run yourself.",
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  }
  if (f.kind === 'daily') {
    // the manager's daily job change: what it sets up (a recurring prompt) and, for an edit, the prompt it replaces
    return {
      ...base,
      kind: 'daily',
      tool: undefined,
      detail: [
        typeof input.reason === 'string' ? `⚠️ **${input.reason}**` : '',
        `**Agent:** ${String(input.agent ?? '')} · **When:** ${String(input.schedule ?? '')}`,
        input.action === 'delete' ? '' : `**Prompt, every run:**\n\n${String(input.prompt ?? '')}`,
        typeof input.previousPrompt === 'string' ? `**Replaces:**\n\n${input.previousPrompt}` : '',
        input.action === 'delete' ? 'It stops running and is removed.' : 'Typed into the agent\'s session on this schedule, without asking again.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }
  }
  if (f.kind === 'delegation') {
    const after = Array.isArray(input.after) && input.after.length ? `\n\n**Starts after:** ${(input.after as string[]).join(', ')}` : ''
    return {
      ...base,
      kind: 'delegation',
      tool: undefined,
      // why it waits for you when approval is off: the manager asked for it right after reading an agent's report
      detail: `${typeof input.reason === 'string' ? `⚠️ **${input.reason}**\n\n` : ''}**For:** ${String(input.agentName ?? 'unassigned')}${after}\n\n${String(input.description ?? '')}`,
    }
  }
  const detail =
    f.tool === 'Bash'
      ? typeof input.description === 'string'
        ? input.description
        : undefined
      : '```\n' + JSON.stringify(input, null, 2).slice(0, 4000) + '\n```'
  return { ...base, kind: 'permission', command: f.tool === 'Bash' ? String(input.command ?? '') : f.message, detail }
}

/** UI decision → what the server needs. */
export function toServer(item: Item, d: Decision): FollowUpDecision {
  if (item.kind === 'plan') {
    if (d.type === 'plan-option') return { type: 'plan', option: d.option, feedback: d.note }
    throw new Error('Pick one of the plan options')
  }
  if (item.kind === 'question') {
    if (d.type === 'answers') return { type: 'answer', answers: d.answers }
    if (d.type === 'reply') return { type: 'answer', answers: { [item.questions?.[0]?.question ?? '']: d.text } }
    return { type: 'deny', note: d.type === 'reject' ? d.note : undefined }
  }
  if (APPROVAL.has(item.kind))
    return d.type === 'approve' ? { type: 'allow', note: d.note, ...(d.hire ? { hire: d.hire } : {}) } : { type: 'deny', note: d.type === 'reject' ? d.note : undefined }
  if (d.type === 'approve') return { type: 'allow', always: d.mode === 'always', ...(d.note?.trim() ? { note: d.note } : {}) }
  return { type: 'deny', note: d.type === 'reject' ? d.note : undefined }
}

/**
 * When something happened, from how long ago (ms): "just now" and "15m ago" within the hour, then its date and time
 * ("30 Sep, 14:05"; the year only when it isn't this one: "28 Dec 2025, 09:10").
 */
export function ago(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return dateTime(Date.now() - ms)
}

/** How many items wait on the user (for the mobile dock badge). Written by FollowUps. */
export const useAttentionCount = create<number>(() => 0)

/**
 * The "For you" queue (what waits on the owner). Desktop: the bottom panel. Phones: pass `sheet` and it renders inside a modal
 * opened from the dock; the component stays mounted either way (it keeps the tab title count up to date).
 */
export function FollowUps({ sheet }: { sheet?: { open: boolean; onClose: () => void } } = {}) {
  const agents = useOffice((s) => s.agents)
  const setStatus = useOffice((s) => s.setStatus)
  const { reviews, resolveReview } = useDashboard(useShallow((s) => ({ reviews: s.reviews, resolveReview: s.resolveReview })))
  const now = useNow(30_000).getTime()
  const [viewAll, setViewAll] = useState(false)
  const ready = useWorkReady()
  // app shortcut "For you" on a desktop (phones: the dock opens its sheet)
  const launch = useLaunch((s) => s.open)
  useEffect(() => {
    if (sheet || launch !== 'attention' || window.matchMedia(MOBILE).matches) return
    setViewAll(true)
    useLaunch.getState().done()
  }, [launch, sheet])
  const [filter, setFilter] = useState<FollowUp['kind'] | 'all'>('all')
  const [detailId, setDetailId] = useState<string | null>(null)

  const source = useOffice((s) => s.source)
  const liveFollowUps = useLive((s) => s.followUps)
  const [error, setError] = useState('')

  // demo: derived from "waiting" agents + canned reviews; live: held Claude Code prompts from the server
  const demoWaiting: Item[] = agents
    .filter((a) => a.status === 'waiting')
    .map((a) => ({
      id: `demo-${a.id}`,
      agentId: a.id,
      kind: 'permission',
      message: a.task ?? 'Waiting for input',
      createdAt: a.updatedAt,
      tool: a.tool ?? 'Bash',
      command: a.task?.match(/`([^`]+)`/)?.[1],
      detail: a.cwd ? `Working folder: ${a.cwd}` : undefined,
    }))
  const items: Item[] = (source === 'live' ? liveFollowUps.map(fromLive) : [...demoWaiting, ...reviews]).sort((a, b) => a.createdAt - b.createdAt)
  const detail = items.find((i) => i.id === detailId) ?? null
  // the rest of what waits on the owner (live): work to review, their own tasks, the manager's notes that need them
  const todos = useForYou(source === 'live')
  const total = items.length + todos.length

  // "(2) After Office": the count shows on the browser tab, so waiting agents are noticed from other tabs (the
  // office's own name from Project settings)
  const brandName = useBranding((s) => s.name)
  useEffect(() => {
    document.title = total ? `(${total}) ${brandName}` : brandName
    useAttentionCount.setState(total, true)
  }, [total, brandName])
  useEffect(() => () => void (document.title = useBranding.getState().name), [])

  const resolve = async (item: Item, decision: Decision) => {
    setError('')
    if (item.live) {
      try {
        // the server answers the held hook (or presses the plan dialog keys); the feed then removes the card
        await liveApi.decide(item.id, toServer(item, decision))
        if (detailId === item.id) setDetailId(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not send the answer')
      }
      return
    }
    const ok = decision.type !== 'reject'
    if (item.id.startsWith('demo-')) {
      setStatus(item.agentId, ok ? 'working' : 'idle', ok ? { task: 'Continuing after approval', tool: 'Bash' } : { task: undefined, tool: undefined })
    } else {
      resolveReview(item.id)
      if (item.kind === 'plan' && decision.type === 'approve') setStatus(item.agentId, 'working', { task: item.message.replace(/^Plan: /, ''), tool: 'Edit' })
    }
    if (detailId === item.id) setDetailId(null)
  }

  const agentOf = (id: string) => agents.find((a) => a.id === id)
  const card = (item: Item) => (
    <FollowUpCard
      key={item.id}
      item={item}
      agentName={withSession(agentOf(item.agentId)?.name ?? 'Unknown', item.sessionKey)}
      agentColor={agentOf(item.agentId)?.look.shirt ?? '#aaa'}
      age={ago(now - item.createdAt)}
      onResolve={(d) => resolve(item, d)}
      onOpen={() => setDetailId(item.id)}
    />
  )
  const filtered = filter === 'all' ? items : items.filter((i) => i.kind === filter)

  const panel = (
    <section className="card bottom">
      <header className="card__head">
        <h2>For you</h2>
        {total > 0 && <span className="badge badge--accent">{total}</span>}
        {error ? (
          <span className="grow danger-text truncate">{error}</span>
        ) : (
          <span className="muted grow">What waits on you: agents' questions and approvals, work to review, your own tasks</span>
        )}
        {total > 0 && (
          <button className="small" onClick={() => setViewAll(true)}>
            View all
          </button>
        )}
      </header>
      <div className="followups">
        {items.map(card)}
        {todos.map((t) => (
          <ForYouCard key={t.id} item={t} now={now} />
        ))}
        {!total && ready && <div className="empty">Nothing waiting on you.</div>}
      </div>

      <Modal open={viewAll} onClose={() => setViewAll(false)} title="For you" description={`${total} open items`} width={880}>
        <div className="modal__body">
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            {(['all', 'plan', 'permission', 'question', 'delegation', 'hire', 'check', 'daily', 'review'] as const).map((k) => (
              <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                {k === 'all' ? 'All' : KIND[k].label}
                <span className="seg__count">{k === 'all' ? items.length : items.filter((i) => i.kind === k).length}</span>
              </button>
            ))}
          </div>
          <div className="followups-grid">
            {filtered.map(card)}
            {filter === 'all' &&
              todos.map((t) => (
                <ForYouCard key={t.id} item={t} now={now} />
              ))}
            {!filtered.length && !(filter === 'all' && todos.length) && <div className="empty">Nothing here.</div>}
          </div>
        </div>
      </Modal>

      {detail && (
        <FollowUpDetail
          item={detail}
          agentName={withSession(agentOf(detail.agentId)?.name ?? 'Unknown', detail.sessionKey)}
          agentColor={agentOf(detail.agentId)?.look.shirt ?? '#aaa'}
          age={ago(now - detail.createdAt)}
          onResolve={(d) => resolve(detail, d)}
          onClose={() => setDetailId(null)}
          error={error}
        />
      )}
    </section>
  )

  if (!sheet) return panel
  return (
    <DockSheet open={sheet.open} onClose={sheet.onClose} title="For you">
      {panel}
    </DockSheet>
  )
}

/** One more thing that waits on the owner, besides the agents' prompts. */
interface ForYou {
  id: string
  kind: 'to-review' | 'mine' | 'note'
  title: string
  /** who it's from: an agent, or the manager */
  agentId?: string
  at: number
  open: () => void
  /** the quick answer: accept the work, tick your task off, or "got it"; unset: answered inside (the manager asked) */
  done?: () => void
}

const FOR_YOU: Record<ForYou['kind'], { label: string; icon: ReactNode; done: string }> = {
  'to-review': { label: 'To review', icon: <LuEye />, done: 'Accept' },
  mine: { label: 'Your task', icon: <LuUser />, done: 'Done' },
  note: { label: 'Manager', icon: <LuCrown />, done: 'Got it' },
}

/** Work finished and waiting for the owner's review, and their own open tasks (the manager's asked to be answered). */
function useForYou(on: boolean): ForYou[] {
  const tasks = useDashboard((s) => s.tasks)
  const updateTask = useDashboard((s) => s.updateTask)
  if (!on) return []
  const review: ForYou[] = tasks
    // the manager's tasks are its to review (it sums them up for you); yours and the agents' you started are yours
    .filter((t) => t.status === 'review' && !t.forOwner && !t.delegatedBy && t.checkState !== 'running')
    .map((t) => ({ id: `review-${t.id}`, kind: 'to-review', title: t.title, agentId: t.agentId ?? undefined, at: t.startedAt ?? 0, open: () => openUrl({ task: t.id }), done: () => updateTask(t.id, { status: 'done' }) }))
  const mine: ForYou[] = tasks
    .filter((t) => t.forOwner && t.status !== 'done')
    .sort((a, b) => a.deadline - b.deadline)
    .map((t) => ({
      id: `mine-${t.id}`,
      kind: 'mine',
      title: t.title,
      agentId: t.delegatedBy,
      at: t.createdAt ?? 0,
      // the manager asked: answered in the task (its note box), then done there; your own ones tick off here
      open: () => openUrl({ task: t.id, ...(t.delegatedBy ? { tnote: '1' } : {}) }),
      ...(t.delegatedBy ? {} : { done: () => updateTask(t.id, { status: 'done' }) }),
    }))
  // (the manager's "needs you" notes stay in Reports, marked there: not here a second time)
  return [...review, ...mine]
}

function ForYouCard({ item, now }: { item: ForYou; now: number }) {
  const agent = useOffice((s) => s.agents.find((a) => a.id === item.agentId))
  const kind = FOR_YOU[item.kind]
  return (
    <article className={`fu fu--${item.kind}`}>
      <div className="fu__head">
        <span className="fu__kind">
          {kind.icon} {kind.label}
        </span>
        {item.at > 0 && <span className="muted">{ago(now - item.at)}</span>}
      </div>
      <button className="fu__msg" onClick={item.open} data-tip="Open">
        {item.title}
      </button>
      <div className="fu__agent">
        {item.kind === 'mine' ? (
          <>
            <span className="chip__dot" style={{ background: 'var(--hl)' }} />
            {agent ? `Asked by ${agent.name}` : 'You'}
          </>
        ) : (
          <>
            <span className="chip__dot" style={{ background: agent?.look.shirt ?? '#aaa' }} />
            {agent?.name ?? 'An agent'}
          </>
        )}
      </div>
      <div className="fu__actions">
        {item.done ? (
          <>
            <button className="primary" onClick={item.done}>
              <LuCheck /> {kind.done}
            </button>
            <button onClick={item.open}>Open</button>
          </>
        ) : (
          <button className="primary fu__answer" onClick={item.open} data-tip="Open it and answer in its note box; mark it done there">
            <LuMessageSquareReply /> Answer
          </button>
        )}
      </div>
    </article>
  )
}

function FollowUpCard({
  item,
  agentName,
  agentColor,
  age,
  onResolve,
  onOpen,
}: {
  item: Item
  agentName: string
  agentColor: string
  age: string
  onResolve: (d: Decision) => void
  onOpen: () => void
}) {
  const [reply, setReply] = useState('')
  const kind = KIND[item.kind]
  return (
    <article className={`fu fu--${item.kind}`}>
      <div className="fu__head">
        <span className="fu__kind">
          {kind.icon} {kind.label}
        </span>
        <span className="muted">{age}</span>
        <button className="icon-btn small ghost fu__open" data-tip="Details" aria-label="Open details" onClick={onOpen}>
          <LuMaximize2 />
        </button>
      </div>
      <button className="fu__msg" onClick={onOpen} data-tip="Open details">
        {item.message}
      </button>
      <div className="fu__agent">
        <span className="chip__dot" style={{ background: agentColor }} />
        {agentName}
      </div>
      {item.kind === 'question' && item.questions?.length === 1 && !item.questions[0].multiSelect ? (
        <div className="fu__options">
          {item.questions[0].options.map((o) => (
            <button key={o.label} className="small" data-tip={o.description} onClick={() => onResolve({ type: 'answers', answers: { [item.questions![0].question]: o.label } })}>
              {o.label}
            </button>
          ))}
        </div>
      ) : item.kind === 'question' ? (
        <form
          className="fu__reply"
          onSubmit={(e) => {
            e.preventDefault()
            if (reply.trim()) onResolve({ type: 'reply', text: reply.trim() })
          }}
        >
          <input placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} autoComplete="off" data-1p-ignore />
          <button type="submit" className="icon-btn primary" data-tip="Send reply" aria-label="Send reply">
            <LuSend />
          </button>
        </form>
      ) : item.kind === 'plan' ? (
        <div className="fu__actions">
          <button className="primary" onClick={onOpen}>
            <LuClipboardList /> Review plan
          </button>
        </div>
      ) : (
        <div className="fu__actions">
          <button className="primary" onClick={() => onResolve({ type: 'approve' })}>
            <LuCheck /> {item.kind === 'review' || APPROVAL.has(item.kind) ? 'Approve' : 'Allow'}
          </button>
          <button onClick={() => (APPROVAL.has(item.kind) ? onOpen() : onResolve({ type: 'reject' }))}>
            <LuX /> {item.kind === 'review' ? 'Dismiss' : APPROVAL.has(item.kind) ? 'Reject…' : 'Deny'}
          </button>
        </div>
      )}
    </article>
  )
}

/** Full view of one item: the whole plan / context, and every answer Claude Code offers. */
export function FollowUpDetail({
  item,
  agentName,
  agentColor,
  age,
  onResolve,
  onClose,
  error,
}: {
  item: Item
  agentName: string
  agentColor: string
  age: string
  onResolve: (d: Decision) => void
  onClose: () => void
  /** why the last answer didn't go through (shown here, not only behind the modal) */
  error?: string
}) {
  const [note, setNote] = useState('')
  // a hire: the manager's proposal, editable before approving
  const [hire, setHire] = useState(item.hire)
  const kind = KIND[item.kind]
  const noteLabel =
    item.kind === 'question'
      ? 'Your answer'
      : item.kind === 'plan'
        ? 'Feedback (sent if you keep planning)'
        : item.kind === 'delegation'
          ? 'Note (optional): with Approve it goes to the agent with the task, with Reject to the manager'
          : APPROVAL.has(item.kind)
            ? 'Note to the manager (optional, sent with your decision)'
          : 'Note to the agent (optional: with Deny it is the reason, with Allow it follows as a message)'

  return (
    <Modal open onClose={onClose} title={item.message} width={760}>
      <div className="modal__body fu-detail">
        <div className="fu-detail__meta">
          <span className={`fu__kind fu--${item.kind}`}>
            {kind.icon} {kind.label}
          </span>
          <span className="chip">
            <span className="chip__dot" style={{ background: agentColor }} />
            {agentName}
          </span>
          <span className="muted">{age}</span>
        </div>

        {item.kind === 'check' && (
          <div className="fu-detail__cmd">
            <span className="muted">The manager wants this quality check to run</span>
            <pre className="mono">{item.command}</pre>
          </div>
        )}

        {item.kind === 'permission' && (
          <div className="fu-detail__cmd">
            <span className="muted">{item.tool ?? 'Tool'} wants to run</span>
            <pre className="mono">{item.command ?? item.message}</pre>
          </div>
        )}

        {item.kind === 'hire' && hire && (
          <div className="fu-hire">
            <div className="field-row">
              <Field label="Name">
                <input value={hire.name} maxLength={32} onChange={(e) => setHire({ ...hire, name: e.target.value })} autoComplete="off" data-1p-ignore />
              </Field>
              <Field label="Role / division">
                <input value={hire.role} maxLength={60} onChange={(e) => setHire({ ...hire, role: e.target.value })} autoComplete="off" data-1p-ignore />
              </Field>
            </div>
            <div className="field-row">
              <div className="field">
                <span className="field__label">Model</span>
                <Select
                  ariaLabel="Model"
                  value={hire.model}
                  options={MODELS.map((m) => ({ value: m.value, label: m.label }))}
                  onChange={(model) => setHire({ ...hire, model })}
                />
              </div>
              <div className="field" data-tip="How hard it thinks. Higher uses your plan faster; Default suits most work.">
                <span className="field__label">Effort</span>
                <Select
                  ariaLabel="Effort"
                  value={hire.effort ?? ''}
                  options={EFFORT_OPTIONS}
                  onChange={(e) => setHire({ ...hire, effort: e ? (e as AgentEffort) : null })}
                />
              </div>
              <div className="field">
                <span className="field__label">Permission mode</span>
                <Select
                  ariaLabel="Permission mode"
                  value={hire.mode}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'acceptEdits', label: 'Accept edits' },
                    { value: 'default', label: 'Ask' },
                    { value: 'plan', label: 'Plan' },
                  ]}
                  onChange={(mode) => setHire({ ...hire, mode })}
                />
              </div>
            </div>
            <div className="field">
              <span className="field__label">Character</span>
              <FigurePicker value={hire.figure} onChange={(figure) => setHire({ ...hire, figure })} />
            </div>
            <div className="field">
              <span className="field__label">Office rules</span>
              <RulesPicker value={hire.rules} onChange={(rules) => setHire({ ...hire, rules })} />
            </div>
            <HireConnectors value={hire.connectors} onChange={(connectors) => setHire({ ...hire, connectors })} />
          </div>
        )}

        {item.questions?.length ? (
          <QuestionForm questions={item.questions} onSubmit={(answers) => onResolve({ type: 'answers', answers })} onSkip={() => onResolve({ type: 'reject' })} />
        ) : item.detail ? (
          <div className="fu-detail__body">
            <Markdown text={item.detail} />
          </div>
        ) : (
          item.kind !== 'permission' && <p className="muted">No extra details were sent with this item.</p>
        )}

        {!item.questions?.length && (
        <Field label={noteLabel}>
          <textarea
            rows={item.kind === 'question' ? 4 : 3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={item.kind === 'plan' ? 'e.g. Skip the cookie fallback, we can force re-login.' : ''}
            autoFocus={item.kind === 'question'}
          />
        </Field>
        )}

        {error && <div className="row__error">{error}</div>}

        {!item.questions?.length && (
        <footer className="modal__foot fu-detail__actions">
          {item.kind === 'plan' && item.live && (
            <>
              {!item.planOptions && <span className="muted grow">Reading the plan dialog…</span>}
              {item.planOptions?.map((label, i) => {
                const feedback = /tell claude|change|feedback/i.test(label)
                return (
                  <button
                    key={label}
                    className={i === 0 ? 'primary' : ''}
                    disabled={feedback && !note.trim()}
                    data-tip={feedback ? 'Sends your feedback so the agent revises the plan' : undefined}
                    onClick={() => onResolve({ type: 'plan-option', option: label, note: feedback ? note : undefined })}
                  >
                    {i === 0 && <LuCheck />} {label}
                  </button>
                )
              })}
            </>
          )}
          {item.kind === 'plan' && !item.live && (
            <>
              <button onClick={() => onResolve({ type: 'reject', note })} disabled={!note.trim()} data-tip="Send your feedback and let the agent revise the plan">
                Keep planning
              </button>
              <button onClick={() => onResolve({ type: 'approve', mode: 'manual', note })}>Approve, ask before edits</button>
              <button className="primary" onClick={() => onResolve({ type: 'approve', mode: 'auto', note })}>
                <LuCheck /> Approve & auto-accept edits
              </button>
            </>
          )}
          {item.kind === 'permission' && (
            <>
              <button onClick={() => onResolve({ type: 'reject', note })}>
                <LuX /> Deny
              </button>
              <button onClick={() => onResolve({ type: 'approve', mode: 'always', note })}>Allow always</button>
              <button className="primary" onClick={() => onResolve({ type: 'approve', note })}>
                <LuCheck /> Allow once
              </button>
            </>
          )}
          {item.kind === 'question' && (
            <>
              <button onClick={onClose}>Later</button>
              <button className="primary" disabled={!note.trim()} onClick={() => onResolve({ type: 'reply', text: note.trim() })}>
                <LuSend /> Send answer
              </button>
            </>
          )}
          {APPROVAL.has(item.kind) && (
            <>
              <button onClick={() => onResolve({ type: 'reject', note })}>
                <LuX /> Reject
              </button>
              <button
                className="primary"
                disabled={item.kind === 'hire' && !!hire && (!hire.name.trim() || !hire.role.trim())}
                onClick={() => onResolve({ type: 'approve', note, ...(item.kind === 'hire' && hire ? { hire } : {}) })}
              >
                <LuCheck /> {item.kind === 'hire' ? 'Approve & hire' : item.kind === 'check' ? 'Approve check' : item.kind === 'daily' ? 'Approve' : 'Approve & start'}
              </button>
            </>
          )}
          {item.kind === 'review' && (
            <>
              <button onClick={() => onResolve({ type: 'reject', note })}>Dismiss</button>
              <button disabled={!note.trim()} onClick={() => onResolve({ type: 'reject', note })}>
                Request changes
              </button>
              <button className="primary" onClick={() => onResolve({ type: 'approve', note })}>
                <LuCheck /> Approve
              </button>
            </>
          )}
        </footer>
        )}
      </div>
    </Modal>
  )
}

/** Claude's AskUserQuestion: 1–4 questions, each with 2–4 options, plus an "Other" free-text answer. */
function QuestionForm({ questions, onSubmit, onSkip }: { questions: Question[]; onSubmit: (a: Record<string, string | string[]>) => void; onSkip: () => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? []
      if (!q.multiSelect) return { ...p, [q.question]: [label] }
      return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  const answerOf = (q: Question) => {
    const text = other[q.question]?.trim()
    const labels = picked[q.question] ?? []
    if (text) return q.multiSelect ? [...labels, text] : text
    return q.multiSelect ? labels : labels[0]
  }
  const complete = questions.every((q) => {
    const a = answerOf(q)
    return Array.isArray(a) ? a.length > 0 : !!a
  })

  return (
    <div className="qform">
      {questions.map((q) => (
        <fieldset key={q.question} className="qform__q">
          <legend>
            {q.header && <span className="qform__header">{q.header}</span>}
            {q.question}
            {q.multiSelect && <span className="muted"> · pick any</span>}
          </legend>
          <div className="qform__options">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label)
              return (
                <button type="button" key={o.label} className={`qform__opt${on ? ' active' : ''}`} aria-pressed={on} onClick={() => toggle(q, o.label)}>
                  <b>{o.label}</b>
                  {o.description && <span>{o.description}</span>}
                </button>
              )
            })}
          </div>
          <input
            placeholder="Other answer…"
            value={other[q.question] ?? ''}
            onChange={(e) => {
              const v = e.target.value
              setOther((o) => ({ ...o, [q.question]: v }))
              if (v && !q.multiSelect) setPicked((p) => ({ ...p, [q.question]: [] }))
            }}
            autoComplete="off"
            data-1p-ignore
          />
        </fieldset>
      ))}
      <footer className="modal__foot">
        <button onClick={onSkip}>Skip question</button>
        <button
          className="primary"
          disabled={!complete}
          onClick={() => onSubmit(Object.fromEntries(questions.map((q) => [q.question, answerOf(q)!])))}
        >
          <LuSend /> Send answer
        </button>
      </footer>
    </div>
  )
}

// One set of element renderers for every Markdown block. Defined once: new functions on each render would make
// React rebuild those elements (tables, links, code) every time the chat refreshes, losing text selection and the
// chat search's highlights on them.
const MD_COMPONENTS: Components = {
  a: ({ href, children }) =>
    href?.startsWith(FILE_HREF) ? (
      <FileLinkButton path={decodeURIComponent(href.slice(FILE_HREF.length))}>{children}</FileLinkButton>
    ) : (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => <pre className="md-code">{children}</pre>,
  // agent text is untrusted: an image would be fetched on sight (and could carry data out in its URL),
  // so show it as a link the owner can choose to open
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer noopener" className="md-img">
      [image{alt ? `: ${alt}` : ''}]
    </a>
  ),
}

/** Tiny Markdown renderer for plans: headings, ordered/unordered lists, **bold** and `code`. */
/** Markdown from Claude (GitHub flavour: tables, task lists, code). Links open in a new tab; raw HTML is not rendered. */
export function Markdown({ text }: { text: string }) {
  // inside a chat message or report with attachments: file paths in the text open / download them
  const files = useFileLinks()
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={files ? [remarkGfm, [remarkFileLinks, { find: files.find }]] : [remarkGfm]}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}


/** Connectors a new hire may use (none unless picked): the manager's request, changeable before approving. */
function HireConnectors({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { list, load } = useConnectors()
  useEffect(() => {
    if (!list) void load()
  }, [list, load])
  const name = (prefix: string) => (list ?? []).find((c) => c.prefix === prefix)?.name.replace(/^claude\.ai /, '') ?? prefix
  const offered = (list ?? []).filter((c) => c.status === 'connected' || value.includes(c.prefix))
  return (
    <div className="field">
      <span className="field__label">Connectors</span>
      {!list ? (
        <span className="muted">Checking the account's connectors…</span>
      ) : !offered.length ? (
        <span className="muted">None connected on this account.</span>
      ) : (
        <div className="hire-connectors">
          {offered.map((c) => {
            const on = value.includes(c.prefix)
            return (
              <button
                key={c.prefix}
                type="button"
                className={`chip-toggle${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => onChange(on ? value.filter((p) => p !== c.prefix) : [...value, c.prefix])}
              >
                {name(c.prefix)}
              </button>
            )
          })}
        </div>
      )}
      <span className="field__hint">{value.length ? `On: ${value.map(name).join(', ')}.` : 'None: it starts without connectors.'} More can be turned on later in its profile.</span>
    </div>
  )
}
