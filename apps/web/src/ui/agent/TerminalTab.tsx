import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { LuPlugZap, LuRotateCw } from 'react-icons/lu'

// The real Claude Code TUI: xterm.js attached to the agent's tmux session through /api/agents/:id/term.
// Typing here is exactly like typing in the terminal on the server.

type State = 'connecting' | 'open' | 'closed'

/** `session`: one of its side sessions (s2, s3…; unset: its main session). */
/** `url`: another terminal to attach to (a folder's shell: /api/workspaces/shell/term?root=…) instead of the agent's. */
export function TerminalTab({
  agentId,
  offline,
  session,
  url,
  label = 'keys go straight to Claude Code',
  actions,
}: {
  agentId: string
  offline: boolean
  session?: string
  url?: string
  /** what it's attached to, after "Attached" */
  label?: string
  /** buttons at the end of its bar */
  actions?: React.ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<State>('connecting')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (offline || !host.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      allowProposedApi: false,
      theme: { background: '#111111', foreground: '#e9e9e6', cursor: '#f5b914', selectionBackground: '#3a3a3a' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}${url ?? `/api/agents/${agentId}/term${session ? `?session=${session}` : ''}`}`)
    ws.binaryType = 'arraybuffer'
    const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    ws.onopen = () => {
      setState('open')
      send({ t: 'resize', cols: term.cols, rows: term.rows })
      term.focus()
    }
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
    ws.onclose = () => setState('closed')
    const input = term.onData((d) => send({ t: 'in', d }))

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        send({ t: 'resize', cols: term.cols, rows: term.rows })
      } catch {
        // element hidden
      }
    })
    ro.observe(host.current)

    return () => {
      ro.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [agentId, offline, attempt, session, url])

  if (offline) return <div className="empty">The agent is offline. It restarts automatically, or use Restart in Overview.</div>

  return (
    <div className="term">
      <div className="term__bar">
        <span className={`live-dot${state === 'open' ? ' live-dot--on' : ''}`} />
        <span className="muted">{state === 'open' ? `Attached · ${label}` : state === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
        {state === 'closed' && (
          <button className="small" onClick={() => (setState('connecting'), setAttempt((n) => n + 1))}>
            <LuRotateCw /> Reconnect
          </button>
        )}
        <span className="grow" />
        <span className="muted term__hint">
          <LuPlugZap /> Closing this only detaches; it keeps running
        </span>
        {actions}
      </div>
      {/* padding lives on the frame; xterm measures the inner box, so fit() doesn't count the padding as rows */}
      <div className="term__screen">
        <div className="term__host" ref={host} />
      </div>
    </div>
  )
}
