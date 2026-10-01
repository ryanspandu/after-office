import { useEffect, useState } from 'react'
import { LuLoader, LuSquareTerminal, LuX } from 'react-icons/lu'
import { api } from '../state/auth'
import { confirm } from './Confirm'
import { TerminalTab } from './agent/TerminalTab'
import { CodeInput } from './TwoFactor'

// A terminal in a folder (the folder details): a shell on the server, run with the agents' rights. Opening one asks for
// the authenticator code; it keeps running (a dev server started in it stays up) until it's ended here.

export function FolderTerminal({ root }: { root: string }) {
  const [running, setRunning] = useState<boolean | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api(`/api/workspaces/shell?${new URLSearchParams({ root })}`)
      .then((r) => (r.ok ? r.json() : { running: false }))
      .then((r: { running: boolean }) => setRunning(r.running))
      .catch(() => setRunning(false))
  }, [root])

  const open = async (c = code) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api('/api/workspaces/shell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root, code: c }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not open the terminal')
      setRunning(true)
      setCode('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const end = async () => {
    const ok = await confirm({
      title: 'End this terminal?',
      message: 'The shell stops, with anything still running in it (a dev server started here, for example).',
      confirmLabel: 'End terminal',
    })
    if (!ok) return
    await api(`/api/workspaces/shell?${new URLSearchParams({ root })}`, { method: 'DELETE' }).catch(() => undefined)
    setRunning(false)
  }

  if (running === null)
    return (
      <div className="fterm__empty muted">
        <LuLoader className="spin" />
      </div>
    )
  if (!running)
    return (
      <div className="fterm__empty">
        <LuSquareTerminal className="fterm__icon" />
        <div className="fterm__title">A terminal in this folder</div>
        <p className="muted fterm__hint">
          A shell on the server, with the agents’ rights (not root). It keeps running when you close this, until you end it. Enter the code from your authenticator app to open it.
        </p>
        <CodeInput value={code} onChange={setCode} onComplete={(v) => void open(v)} autoFocus disabled={busy} />
        {error && <div className="row__error">{error}</div>}
        <button className="primary" onClick={() => void open()} disabled={busy || code.length < 6}>
          {busy ? <LuLoader className="spin" /> : <LuSquareTerminal />} Open terminal
        </button>
      </div>
    )
  return (
    <div className="fterm">
      <TerminalTab
        agentId=""
        offline={false}
        url={`/api/workspaces/shell/term?${new URLSearchParams({ root })}`}
        label={`a shell in ${root.replace(/^\/(Users|home)\/[^/]+/, '~')}`}
        actions={
          <button className="small danger-text" onClick={() => void end()}>
            <LuX /> End<span className="hide-phone"> terminal</span>
          </button>
        }
      />
    </div>
  )
}
