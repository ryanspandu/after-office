import { useEffect, useState } from 'react'
import { LuChevronDown, LuFileDiff, LuRefreshCw } from 'react-icons/lu'
import type { DiffFile, TaskDiff as Diff } from '@after-office/shared'
import { liveApi } from '../state/live'

// "Changes": what the agent changed in its folder since the task was handed over (git, read-only on the server).

export function TaskDiff({ taskId, status }: { taskId: string; status: string }) {
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    liveApi
      .taskDiff(taskId)
      .then((d) => {
        setDiff(d)
        setError(null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }
  // reload when the task moves on (e.g. the agent finished)
  useEffect(load, [taskId, status])

  const files = diff?.files
  const adds = files?.reduce((n, f) => n + f.additions, 0) ?? 0
  const dels = files?.reduce((n, f) => n + f.deletions, 0) ?? 0

  return (
    <div className="field diff">
      <span className="field__label diff__label">
        <LuFileDiff /> Changes
        {files && files.length > 0 && (
          <span className="muted">
            · {files.length} file{files.length === 1 ? '' : 's'} <span className="diff__add">+{adds}</span> <span className="diff__del">−{dels}</span>
          </span>
        )}
        <button type="button" className="icon-btn small ghost diff__reload" data-tip="Reload" aria-label="Reload changes" onClick={load} disabled={loading}>
          <LuRefreshCw className={loading ? 'spin' : ''} />
        </button>
      </span>
      {error ? (
        <div className="row__error">{error}</div>
      ) : !diff ? (
        <div className="muted diff__note">Loading…</div>
      ) : !files ? (
        <div className="muted diff__note">{diff.reason ?? 'No changes to show.'}</div>
      ) : !files.length ? (
        <div className="muted diff__note">No changes since the task started.</div>
      ) : (
        <ul className="diff__files">
          {files.map((f) => (
            <li key={f.path}>
              <button type="button" className="diff__file" onClick={() => setOpen(open === f.path ? null : f.path)} aria-expanded={open === f.path}>
                <LuChevronDown className={`archive__chev${open === f.path ? ' archive__chev--open' : ''}`} />
                <span className={`diff__status diff__status--${f.status}`}>{f.status[0].toUpperCase()}</span>
                <span className="truncate diff__path">{f.path}</span>
                <span className="diff__add">+{f.additions}</span>
                <span className="diff__del">−{f.deletions}</span>
              </button>
              {open === f.path && <Patch file={f} />}
            </li>
          ))}
        </ul>
      )}
      {diff?.truncated && <div className="muted diff__note">Only part of the changes is shown (too large).</div>}
    </div>
  )
}

function Patch({ file }: { file: DiffFile }) {
  // skip git's header lines; keep hunks
  const lines = file.patch.split('\n')
  const start = lines.findIndex((l) => l.startsWith('@@'))
  const body = start === -1 ? lines.slice(1) : lines.slice(start)
  return (
    <pre className="diff__patch">
      {body.map((l, i) => (
        <span key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>
          {l || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
