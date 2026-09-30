import { useMemo, useState } from 'react'
import { LuBot, LuCheck, LuCrown, LuInfo, LuMessageSquareReply, LuSend, LuTrash2, LuTriangleAlert, LuUser } from 'react-icons/lu'
import type { TaskComment } from '@after-office/shared'
import { useNow } from '../state/clock'
import { liveApi, useTaskComments } from '../state/live'
import { useOffice } from '../state/store'
import { ago, Markdown } from './FollowUps'
import { confirm } from './Confirm'

// A task's timeline: your notes, revision requests, the agent's reports (as one-liners: the full report is shown
// above), what the manager said about it, and office events such as "started after its dependencies finished".

export function TaskTimeline({ taskId }: { taskId: string }) {
  const comments = useTaskComments(taskId)
  const agents = useOffice((s) => s.agents)
  const now = useNow(60_000).getTime()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useMemo(() => comments ?? [], [comments])

  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await liveApi.addComment(taskId, text.trim())
      setText('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const who = (c: TaskComment) => {
    if (c.author === 'user') return 'You'
    if (c.author === 'system') return 'Office'
    return agents.find((a) => a.id === c.agentId)?.name ?? (c.author === 'manager' ? 'Manager' : 'Agent')
  }

  return (
    <div className="field timeline">
      <span className="field__label">
        Activity {list.length > 0 && <span className="muted">· {list.length}</span>}
      </span>
      {comments === undefined ? (
        <div className="muted timeline__empty">Loading…</div>
      ) : !list.length ? (
        <div className="muted timeline__empty">Nothing yet. Notes, revision requests and reports show up here.</div>
      ) : (
        <ol className="timeline__list">
          {list.map((c) => (
            <li key={c.id} className={`timeline__item timeline__item--${c.author}${c.kind ? ` timeline__item--${c.kind}` : ''}`}>
              <span className="timeline__icon" aria-hidden>
                <Icon c={c} />
              </span>
              <div className="timeline__body">
                <div className="timeline__head">
                  <b>{who(c)}</b>
                  <span className="muted">
                    {c.kind === 'revision' ? 'requested changes' : c.kind === 'report' ? (c.ok === false ? 'stopped without finishing' : 'reported back') : ''}
                  </span>
                  <span className="muted timeline__time" data-tip={new Date(c.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}>
                    {ago(now - c.createdAt)}
                  </span>
                  {c.author === 'user' && c.kind === 'note' && (
                    <button
                      className="icon-btn small ghost timeline__del"
                      data-tip="Delete note"
                      aria-label="Delete note"
                      onClick={async () => {
                        if (await confirm({ title: 'Delete this note?', message: "It's removed from the task's timeline." })) void liveApi.deleteComment(c.id).catch((e) => setError(e.message))
                      }}
                    >
                      <LuTrash2 />
                    </button>
                  )}
                </div>
                {c.kind === 'report' ? (
                  <p className="timeline__text timeline__text--clip">{firstLine(c.text)}</p>
                ) : c.author === 'user' || c.author === 'system' ? (
                  <p className="timeline__text">{c.text}</p>
                ) : (
                  <div className="timeline__text">
                    <Markdown text={c.text} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="timeline__composer">
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note (the manager sees it on this task)"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
          aria-label="Add a note"
        />
        <button className="small" onClick={send} disabled={!text.trim() || busy} data-tip="Add note (⌘/Ctrl + Enter)">
          <LuSend /> Add
        </button>
      </div>
      {error && <div className="row__error">{error}</div>}
    </div>
  )
}

const firstLine = (t: string) => t.replace(/[#*_`>]/g, '').split('\n').find((l) => l.trim())?.trim() ?? ''

function Icon({ c }: { c: TaskComment }) {
  if (c.kind === 'revision') return <LuMessageSquareReply />
  if (c.kind === 'report') return c.ok === false ? <LuTriangleAlert /> : <LuCheck />
  if (c.author === 'manager') return <LuCrown />
  if (c.author === 'agent') return <LuBot />
  if (c.author === 'system') return <LuInfo />
  return <LuUser />
}
