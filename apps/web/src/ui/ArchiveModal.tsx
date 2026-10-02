import { useCallback, useEffect, useRef, useState } from 'react'
import { dateTime } from './when'
import { LuArchiveRestore, LuChevronDown, LuSearch, LuTrash2 } from 'react-icons/lu'
import type { ArchivedTask } from '@after-office/shared'
import { useClock } from '../state/clock'
import { useDashboard } from '../state/dashboard'
import { liveApi, useLive } from '../state/live'
import { useOffice } from '../state/store'
import { Modal } from './Modal'
import { confirm } from './Confirm'

// Done tasks that have been finished for a while (OFFICE_ARCHIVE_DAYS, default 30) are archived by the server: still
// in the database, but no longer sent to every dashboard. They are browsed here, a page at a time.

export function ArchiveModal({ onClose }: { onClose: () => void }) {
  const count = useLive((s) => s.archivedTasks)
  const [q, setQ] = useState('')
  const [tasks, setTasks] = useState<ArchivedTask[]>([])
  const [total, setTotal] = useState(0)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(async (query: string, offset: number) => {
    const id = ++request.current
    setLoading(true)
    try {
      const page = await liveApi.taskArchive(query, offset)
      if (id !== request.current) return // a newer search already started
      setTasks((prev) => (offset ? [...prev, ...page.tasks] : page.tasks))
      setTotal(page.total)
      setDays(page.archiveDays)
      setError(null)
    } catch (e) {
      if (id === request.current) setError((e as Error).message)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [])

  // search as you type (debounced); also reloads when the archive changes elsewhere
  useEffect(() => {
    const t = setTimeout(() => void load(q, 0), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, count, load])

  const drop = (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id))
    setTotal((n) => n - 1)
  }

  return (
    <Modal open onClose={onClose} title="Archived tasks" description={`Done tasks older than ${days} days · ${count} archived`} width={620}>
      <div className="modal__body archive">
        <label className="archive__search">
          <LuSearch />
          <input type="search" placeholder="Search by title" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search archived tasks" />
        </label>
        {error && <div className="row__error">{error}</div>}
        {!tasks.length && !loading && !error && <div className="empty">{q ? 'No archived task matches that.' : 'Nothing archived yet.'}</div>}
        <ul className="team-list">
          {tasks.map((t) => (
            <ArchivedRow key={t.id} task={t} onGone={() => drop(t.id)} onError={setError} />
          ))}
        </ul>
        {tasks.length < total && (
          <button className="small archive__more" disabled={loading} onClick={() => void load(q, tasks.length)}>
            {loading ? 'Loading…' : `Show more (${total - tasks.length})`}
          </button>
        )}
      </div>
    </Modal>
  )
}

function ArchivedRow({ task: t, onGone, onError }: { task: ArchivedTask; onGone: () => void; onError: (m: string) => void }) {
  const timezone = useClock((s) => s.timezone)
  const agent = useOffice((s) => s.agents.find((a) => a.id === t.agentId))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const date = dateTime(t.updatedAt, timezone)

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      onGone()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <li className="archive__row">
      <div className="archive__line">
        <button className="team-row" onClick={() => setOpen(!open)} aria-expanded={open}>
          <LuChevronDown className={`archive__chev${open ? ' archive__chev--open' : ''}`} />
          <span className="team-row__body">
            <span className="team-row__title truncate">{t.title}</span>
            <span className="team-row__meta truncate">
              Done {date} · {agent?.name ?? (t.agentId ? 'Removed agent' : 'Unassigned')}
            </span>
          </span>
        </button>
        <span className="archive__actions">
          <button className="icon-btn small ghost" data-tip="Back to the task list" aria-label="Restore task" disabled={busy} onClick={() => act(() => liveApi.restoreTask(t.id))}>
              <LuArchiveRestore />
            </button>
            <button
              className="icon-btn small ghost"
              data-tip="Delete for good"
              aria-label="Delete task"
              disabled={busy}
              onClick={async () => {
                if (await confirm({ title: 'Delete this task for good?', message: <>“{t.title}” and its timeline are deleted. This can't be undone.</> }))
                  act(() => liveApi.deleteTask(t.id))
              }}
            >
              <LuTrash2 />
            </button>
          </span>
      </div>
      {open && <p className="archive__desc">{t.description?.trim() || <span className="muted">No description.</span>}</p>}
    </li>
  )
}
