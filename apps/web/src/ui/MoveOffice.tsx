import { useEffect, useRef, useState } from 'react'
import { LuDownload, LuFileArchive, LuLoader, LuTriangleAlert, LuUpload } from 'react-icons/lu'
import { api } from '../state/auth'
import { confirm } from './Confirm'
import { Modal } from './Modal'

// Office settings → Move this office: everything in one file (the database, the dashboard's files, the agents' folders
// and their conversations), and that file imported on another server (replacing what's there). Both need a fresh
// two-factor code; the file's secrets (2FA, push, notification tokens) are locked with a passphrase. (server:
// work/migrate.ts)

interface Job {
  kind: 'export' | 'import'
  step: string
  done: boolean
  error?: string
  size?: number
  name?: string
  restarting?: boolean
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await api(path, { method: 'POST', body: JSON.stringify(body) })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data as T
}

/** The running export / import, asked every second until it's done. */
function useJob(active: boolean) {
  const [job, setJob] = useState<Job | null>(null)
  useEffect(() => {
    if (!active) return
    let stop = false
    const tick = async () => {
      try {
        const res = await api('/api/migrate/status')
        if (res.ok) setJob(((await res.json()) as { job: Job | null }).job)
      } catch {
        // the server is restarting (after an import): keep asking
      }
      if (!stop) setTimeout(tick, 1000)
    }
    void tick()
    return () => void (stop = true)
  }, [active])
  return job
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field__label">Two-factor code</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        className="move-office__code"
        aria-label="Two-factor code"
      />
      <span className="field__hint">From your authenticator app.</span>
    </label>
  )
}

export function ExportOfficeModal({ onClose }: { onClose: () => void }) {
  const [folders, setFolders] = useState(true)
  const [conversations, setConversations] = useState(true)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [started, setStarted] = useState(false)
  const job = useJob(started)
  const running = started && !(job?.kind === 'export' && job.done)
  const ready = job?.kind === 'export' && job.done && !job.error

  const start = async () => {
    setError('')
    if (pass.length < 8) return setError('The passphrase needs at least 8 characters.')
    if (pass !== pass2) return setError("The passphrases don't match.")
    try {
      await post('/api/migrate/export', { code, passphrase: pass, folders, conversations })
      setStarted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start')
    }
  }

  return (
    <Modal open onClose={onClose} title="Export this office" description="Everything in one file, to import on another server (or keep as a full backup)." width={500}>
      <form
        className="modal__body move-office"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void start()
        }}
      >
        {!started ? (
          <>
            <div className="move-office__what">
              <span className="field__label">What goes in</span>
              <label className="check is-fixed">
                <input type="checkbox" checked disabled /> The database and the dashboard’s files (agents, tasks, reports, notes, settings, logo)
              </label>
              <label className="check">
                <input type="checkbox" checked={folders} onChange={(e) => setFolders(e.target.checked)} /> The agents’ and projects’ folders (without node_modules, virtualenvs, caches)
              </label>
              <label className="check">
                <input type="checkbox" checked={conversations} onChange={(e) => setConversations(e.target.checked)} /> The agents’ Claude Code conversations
              </label>
            </div>
            <label className="field">
              <span className="field__label">Passphrase</span>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
            </label>
            <label className="field">
              <span className="field__label">Passphrase again</span>
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
              <span className="field__hint">Locks the file’s secrets (two-factor, push, notification tokens). You’ll need it to import; it can’t be recovered.</span>
            </label>
            <CodeField value={code} onChange={setCode} />
            <p className="move-office__note muted">
              <LuTriangleAlert /> The file holds your whole office, including the agents’ files: keep it somewhere safe. The agents’ Claude login isn’t in it: sign them in again on the new server.
            </p>
          </>
        ) : (
          <div className="move-office__progress">
            {job?.error ? (
              <p className="danger-text">Export failed: {job.error}</p>
            ) : ready ? (
              <>
                <LuFileArchive className="move-office__icon" />
                <p>
                  <b>{job?.name}</b>
                  <br />
                  <span className="muted">{size(job?.size ?? 0)}</span>
                </p>
                <button type="button" className="primary" onClick={() => location.assign('/api/migrate/download')}>
                  <LuDownload /> Download
                </button>
                <span className="muted move-office__hint">Kept here until the next export.</span>
              </>
            ) : (
              <>
                <LuLoader className="spin move-office__icon" />
                <p>{job?.step ?? 'Starting'}…</p>
                <span className="muted move-office__hint">Big folders take a while. You can close this; the file is made anyway.</span>
              </>
            )}
          </div>
        )}
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            {started ? 'Close' : 'Cancel'}
          </button>
          {!started && (
            <button className="primary" disabled={running || !pass || !pass2 || code.length !== 6}>
              <LuDownload /> Export
            </button>
          )}
        </footer>
      </form>
    </Modal>
  )
}

export function ImportOfficeModal({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [pass, setPass] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState<number | null>(null)
  const [started, setStarted] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const job = useJob(started)
  const busy = sent !== null && !job?.error

  // the import done: the server restarts; once it answers again, the page reloads (sign in again)
  useEffect(() => {
    if (!job?.restarting) return
    let stop = false
    const wait = async () => {
      await new Promise((r) => setTimeout(r, 4000))
      for (; !stop; await new Promise((r) => setTimeout(r, 1500))) {
        const ok = await fetch('/api/branding', { cache: 'no-store' })
          .then((r) => r.ok)
          .catch(() => false)
        if (ok) return location.assign('/')
      }
    }
    void wait()
    return () => void (stop = true)
  }, [job?.restarting])

  const start = async () => {
    if (!file) return
    setError('')
    const ok = await confirm({
      title: 'Replace this office?',
      message:
        'Everything here is replaced by the file: agents, tasks, reports, notes, settings and the agents’ folders. This server’s database is backed up first and the agents’ current folders go to the trash. The agents here stop, and the server restarts (sign in again after).',
      confirmLabel: 'Replace and import',
    })
    if (!ok) return
    try {
      setSent(0)
      const { id, chunk } = await post<{ id: string; chunk: number }>('/api/migrate/upload', { code })
      for (let at = 0; at < file.size; at += chunk) {
        const res = await fetch(`/api/migrate/upload/${id}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'office.tar', 'x-offset': String(at) },
          body: file.slice(at, at + chunk),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status})`)
        setSent(Math.min(file.size, at + chunk))
      }
      await post('/api/migrate/import', { id, passphrase: pass })
      setStarted(true)
    } catch (e) {
      setSent(null)
      setError(e instanceof Error ? e.message : 'Could not import')
    }
  }

  const pct = file && sent !== null ? Math.round((sent / Math.max(1, file.size)) * 100) : 0
  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Import an office" description="A file exported from After Office (this server or another): it replaces everything here." width={500}>
      <form
        className="modal__body move-office"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void start()
        }}
      >
        {sent === null ? (
          <>
            <div className="field">
              <span className="field__label">Export file</span>
              <input ref={input} type="file" accept=".tar,application/x-tar" hidden onChange={(e) => (setFile(e.target.files?.[0] ?? null), (e.target.value = ''))} />
              {/* drop the file here, or click to pick it */}
              <button
                type="button"
                className={`move-office__drop${dragging ? ' is-over' : ''}${file ? ' has-file' : ''}`}
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragging(false)
                  const f = e.dataTransfer.files?.[0]
                  if (f) setFile(f)
                }}
              >
                {file ? (
                  <>
                    <LuFileArchive className="move-office__drop-icon" />
                    <b className="move-office__drop-name">{file.name}</b>
                    <span className="muted">{size(file.size)} · click or drop to change</span>
                  </>
                ) : (
                  <>
                    <LuUpload className="move-office__drop-icon" />
                    <b>Drop the export file here</b>
                    <span className="muted">or click to choose it (after-office-export-….tar)</span>
                  </>
                )}
              </button>
            </div>
            <label className="field">
              <span className="field__label">Passphrase</span>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" placeholder="The one set when it was exported" />
            </label>
            <CodeField value={code} onChange={setCode} />
            <p className="move-office__note danger-text">
              <LuTriangleAlert /> Replaces everything on this server. Its database is backed up first and the agents’ current folders go to the trash.
            </p>
          </>
        ) : (
          <div className="move-office__progress">
            {job?.error ? (
              <p className="danger-text">Import failed: {job.error}. Nothing was replaced; the agents here start again.</p>
            ) : job?.restarting ? (
              <>
                <LuLoader className="spin move-office__icon" />
                <p>Imported. The server is restarting…</p>
                <span className="muted move-office__hint">The page reloads by itself; sign in again. (Running it yourself in development? Start the server again.)</span>
              </>
            ) : !started ? (
              <>
                <p>Uploading… {pct}%</p>
                <div className="move-office__bar">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="muted move-office__hint">{file ? `${size(sent)} of ${size(file.size)}` : ''}</span>
              </>
            ) : (
              <>
                <LuLoader className="spin move-office__icon" />
                <p>{job?.step ?? 'Starting'}…</p>
              </>
            )}
          </div>
        )}
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose} disabled={busy && !job?.error}>
            {job?.error ? 'Close' : 'Cancel'}
          </button>
          {sent === null && (
            <button className="primary danger" disabled={!file || pass.length < 8 || code.length !== 6}>
              <LuUpload /> Import
            </button>
          )}
        </footer>
      </form>
    </Modal>
  )
}
