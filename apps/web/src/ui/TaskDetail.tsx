import { useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LuCheck, LuCrown, LuMessageSquareReply, LuPlay, LuRotateCcw, LuSend, LuSplit, LuTrash2, LuUser, LuCirclePause, LuStepForward } from 'react-icons/lu'
import type { OfficeTask } from '@after-office/shared'
import { useNow } from '../state/clock'
import { hasUnsaved, useDashboard } from '../state/dashboard'
import { liveApi, useLive } from '../state/live'
import { useOffice } from '../state/store'
import { Field, Modal } from './Modal'
import { confirm } from './Confirm'
import { DateTimeField } from './pickers'
import { TaskReports } from './Reports'
import { TaskRunFields } from './TaskRun'
import { Select } from './Select'
import { AgentSelect, assigneeOf, assigneePatch, dueInfo, PRIORITY_OPTIONS, FolderSelect, StatusSelect, statusDefOf, useStatuses, WaitsForSelect, waitingOn } from './taskMeta'
import { flushTaskNote, TaskTimeline } from './TaskTimeline'
import { TaskDiff } from './TaskDiff'
import { TagPicker } from './tags'

/** The task's title: wraps onto as many lines as it needs (a long one isn't cut off on a phone); Enter doesn't add a line. */
function TitleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className="task-detail__title"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      aria-label="Title"
      autoComplete="off"
      data-1p-ignore
    />
  )
}

const BUSY_OPTIONS = [
  { value: 'queue', label: 'Wait in its queue' },
  { value: 'parallel', label: 'Run in a parallel session' },
]

// One task, fully editable. Changes apply immediately (no save step), like the board and list controls.

export function TaskDetailModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useDashboard((s) => s.tasks.find((t) => t.id === taskId))
  const { updateTask, removeTask } = useDashboard(useShallow((s) => ({ updateTask: s.updateTask, removeTask: s.removeTask })))
  const now = useNow(60_000).getTime()
  const live = useOffice((s) => s.source === 'live')
  const agentOnline = useOffice((s) => s.agents.some((a) => a.id === task?.agentId && a.status !== 'offline'))
  const [starting, setStarting] = useState(false)
  const [startMsg, setStartMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const tasks = useDashboard((s) => s.tasks)
  const parallelAllowed = useLive((s) => (s.settings?.parallelSessions ?? 0) > 0)
  const statusDefs = useStatuses()
  if (!task) return null
  const waiting = waitingOn(task, tasks)
  const blocks = tasks.filter((t) => t.blockedBy?.includes(task.id))

  const inReview = live && task.status === 'review'
  const revise = async () => {
    if (!feedback.trim() || sending) return
    setSending(true)
    setStartMsg(null)
    try {
      while (hasUnsaved(task.id)) await new Promise((r) => setTimeout(r, 150))
      const { result } = await liveApi.reviseTask(task.id, feedback.trim())
      setFeedback('')
      setRevising(false)
      setStartMsg({ ok: true, text: result === 'queued' ? 'Agent is busy: feedback queued.' : 'Feedback sent. The task is back in progress.' })
    } catch (e) {
      setStartMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not send' })
    } finally {
      setSending(false)
    }
  }

  const start = async () => {
    setStarting(true)
    setStartMsg(null)
    try {
      // edits are saved with a short delay; make sure the agent gets the latest description
      while (hasUnsaved(task.id)) await new Promise((r) => setTimeout(r, 150))
      const { result } = await liveApi.startTask(task.id)
      setStartMsg({ ok: true, text: result === 'queued' ? 'Agent is busy: queued, it starts when the agent is free.' : result === 'parallel' ? 'Agent is busy: started in a parallel session.' : 'Sent to the agent.' })
    } catch (e) {
      setStartMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not start' })
    } finally {
      setStarting(false)
    }
  }

  // stopped partway (the owner's Stop, the manager's interrupt): its agent can take it up again where it stopped
  const stopped = !!task.stoppedAt && task.status === 'todo'
  const resume = async () => {
    setStarting(true)
    setStartMsg(null)
    try {
      const { result } = await liveApi.resumeTask(task.id)
      setStartMsg({ ok: true, text: result === 'queued' ? 'Agent is busy: queued, it picks this up when it is free.' : 'Sent: the agent continues where it stopped.' })
    } catch (e) {
      setStartMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not resume' })
    } finally {
      setStarting(false)
    }
  }

  const set = (patch: Partial<OfficeTask>) => updateTask(task.id, patch)
  // done (Mark done, Accept): a note still typed in the box is sent first, so it goes with the task (and the manager
  // reads it when it hears the task is done); if it can't be sent, the task stays as it is
  const finish = async () => {
    try {
      await flushTaskNote(task.id)
    } catch {
      return
    }
    set({ status: 'done' })
    // done with it: the task closes (Reopen stays in the list's task, should it be needed)
    onClose()
  }
  const done = task.status === 'done'
  const due = dueInfo(task.deadline, now)
  const statusDef = statusDefOf(task, statusDefs)
  const status = statusDef
  // the owner's own task (done by them, never sent to an agent)
  const mine = !!task.forOwner

  return (
    <Modal open onClose={onClose} title="Task" width={640}>
      <div className="modal__body task-detail">
        <TitleField value={task.title} onChange={(title) => set({ title })} />
        <div className="task-detail__badges">
          <span className="status-pill" style={{ ['--c' as string]: status.color }}>
            {status.label}
          </span>
          {!done && <span className={`due due--${due.level}`}>{due.text}</span>}
          {mine && (
            <span className="check-pill check-pill--approval">
              <LuUser /> Your task
            </span>
          )}
          {stopped && (
            <span className="check-pill check-pill--stopped" data-tip={`Stopped partway, ${new Date(task.stoppedAt!).toLocaleString()}: Resume continues it where it stopped`}>
              <LuCirclePause /> Stopped
            </span>
          )}
          {task.sessionKey && (
            <span className="check-pill check-pill--approval" data-tip="Running in a separate session of the agent, next to its other work; it closes when this is done">
              <LuSplit /> Parallel session
            </span>
          )}
          {task.delegatedBy && (
            <span className="by-manager by-manager--label">
              <LuCrown /> Delegated by the manager
            </span>
          )}
          {task.awaitingApproval && <span className="check-pill check-pill--approval">Waiting for your approval</span>}
          {task.pendingCheck && (
            <span className="check-pill check-pill--approval" data-tip={task.pendingCheck}>
              Manager proposed a check: waiting for you
            </span>
          )}
          {task.checkState === 'running' && <span className="check-pill">Running the quality check…</span>}
          {task.checkState === 'passed' && <span className="check-pill check-pill--passed">Check passed</span>}
          {task.checkState === 'failed' && (
            <span className="check-pill check-pill--failed">{task.status === 'in_progress' ? `Check failed · fixing (round ${task.checkAttempts ?? 1})` : 'Check failed'}</span>
          )}
        </div>

        <div className="task-detail__grid">
          <Field label="Status">
            <StatusSelect value={statusDef.id} onChange={(p) => set(p)} />
          </Field>
          <Field label="Priority">
            <Select ariaLabel="Priority" value={task.priority} options={PRIORITY_OPTIONS} onChange={(v) => set({ priority: v })} />
          </Field>
          {!mine && (
            <Field label="Folder">
            <FolderSelect value={task.folder} onChange={(folder) => set({ folder })} />
          </Field>
          )}
          <Field label="Who does it">
            <AgentSelect withOwner value={assigneeOf(task)} onChange={(v) => set(assigneePatch(v))} />
          </Field>
          <Field label="Deadline">
            <DateTimeField value={task.deadline} onChange={(deadline) => set({ deadline })} ariaLabel="Deadline" />
          </Field>
          <Field label="Tags">
            <TagPicker value={task.tags ?? []} onChange={(tags) => set({ tags })} />
          </Field>
          {!mine && (parallelAllowed || task.parallel) && (
            <Field label="If the agent is busy">
              <Select
                ariaLabel="If the agent is busy"
                value={task.parallel ? 'parallel' : 'queue'}
                options={BUSY_OPTIONS}
                onChange={(v) => set({ parallel: v === 'parallel' || undefined })}
              />
            </Field>
          )}
        </div>

        {/* your own task: no agent to start it, no mode or check of an agent's run */}
        {!mine && <TaskRunFields value={task} onChange={set} />}
        {live && !mine && (
          <Field
            label="Waits for"
            hint={
              waiting.length
                ? `Waiting for ${waiting.map((t) => `"${t.title}"`).join(', ')}. It starts on its own when ${waiting.length > 1 ? 'they are' : 'it is'} finished (review or done).`
                : task.blockedBy?.length
                  ? 'Everything it waits for is finished.'
                  : 'Chain tasks: this one starts on its own once the ones you pick are finished.'
            }
          >
            <WaitsForSelect taskId={task.id} value={task.blockedBy ?? []} onChange={(ids) => set({ blockedBy: ids.length ? ids : undefined })} />
          </Field>
        )}
        {live && !mine && (
          <Field
            label="Quality check"
            hint="Optional. Runs in the task's folder when the agent finishes; a failure goes back to the agent to fix (twice) before review."
          >
            <input className="mono" value={task.check ?? ''} maxLength={1000} onChange={(e) => set({ check: e.target.value || undefined })} placeholder="e.g. npm test" />
          </Field>
        )}
        {live && blocks.length > 0 && (
          <p className="field__hint">
            Next after this: {blocks.map((t) => `"${t.title}"`).join(', ')}.
          </p>
        )}
        {live && !mine && task.autoStart && task.status === 'todo' && !task.autoStartedAt && !waiting.length && (
          <p className="field__hint">
            {!task.agentId
              ? 'Pick an agent so it can start automatically.'
              : task.startAt
                ? `Starts automatically ${new Date(task.startAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.`
                : 'Starts as soon as the agent is free.'}
          </p>
        )}

        <TaskReports taskId={task.id} />
        {live && task.status !== 'todo' && <TaskDiff taskId={task.id} status={task.status} />}
        <Field label={mine ? 'Notes' : 'Description'} hint={mine ? undefined : 'Context, acceptance criteria, links. Sent to the agent along with the task.'}>
          <textarea
            rows={6}
            value={task.description ?? ''}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="What does done look like?"
          />
        </Field>
        {/* the timeline and the note box under the task's own text: read it, then answer */}
        {live && <TaskTimeline taskId={task.id} />}

        {inReview && revising && (
          <div className="revise ui-drop">
            <Field label="What should change?" hint="Sent to the agent as a revision of this task; its answer becomes a new report.">
              <textarea
                rows={3}
                autoFocus
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="e.g. Also include the US market, and keep it to 5 bullet points."
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void revise()
                }}
              />
            </Field>
            <div className="revise__actions">
              <button className="small" onClick={() => setRevising(false)}>
                Cancel
              </button>
              <button className="small primary" onClick={revise} disabled={!feedback.trim() || sending}>
                <LuSend /> Send feedback
              </button>
            </div>
          </div>
        )}

        {/* a tap here keeps the focus where it is: on a phone the footer is slimmer while you type (styles: tasks.css),
            and the field losing focus first would grow it back under your finger before the tap lands */}
        <footer className="modal__foot task-detail__foot" onMouseDown={(e) => e.preventDefault()}>
          <button
            className="ghost"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete this task?', message: <>“{task.title}”, its timeline and reports go. This can't be undone.</> }))) return
              removeTask(task.id)
              onClose()
            }}
          >
            <LuTrash2 /> Delete
          </button>
          <span className="grow" />
          {startMsg && <span className={`task-detail__msg${startMsg.ok ? '' : ' danger-text'}`}>{startMsg.text}</span>}
          {live && !mine && !done && !inReview && (
            <button
              onClick={start}
              disabled={starting || !agentOnline}
              data-tip={
                !task.agentId
                    ? 'Assign an agent first'
                    : !agentOnline
                      ? 'Agent is offline'
                      : waiting.length
                        ? 'It is still waiting for other tasks; start it anyway'
                        : "Type this task into the agent's session"
              }
            >
              <LuPlay /> {task.status === 'in_progress' ? 'Send again' : stopped ? 'Start over' : 'Start on agent'}
            </button>
          )}
          {live && !mine && stopped && (
            <button className="primary" onClick={resume} disabled={starting || !agentOnline} data-tip={agentOnline ? 'The same agent continues from where it stopped' : 'Agent is offline'}>
              <LuStepForward /> Resume
            </button>
          )}
          {inReview ? (
            <>
              <button onClick={() => setRevising((v) => !v)} aria-expanded={revising} disabled={!agentOnline} data-tip={agentOnline ? 'Send feedback to the agent' : 'Agent is offline'}>
                <LuMessageSquareReply /> Request changes
              </button>
              <button className="accent" onClick={() => void finish()} data-tip="Looks good: mark it done">
                <LuCheck /> Accept
              </button>
            </>
          ) : (
            <button className={done ? 'task-detail__main' : 'primary task-detail__main'} onClick={() => (done ? set({ status: 'todo' }) : void finish())} data-tip={done ? undefined : 'A note still in the box is sent with it'}>
              {done ? (
                <>
                  <LuRotateCcw /> Reopen
                </>
              ) : (
                <>
                  <LuCheck /> Mark done
                </>
              )}
            </button>
          )}
          {/* changes are saved as they're made: this only closes it */}
          <button onClick={onClose}>Close</button>
        </footer>
      </div>
    </Modal>
  )
}
