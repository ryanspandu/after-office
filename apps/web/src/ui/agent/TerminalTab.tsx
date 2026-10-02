import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { LuArrowDown, LuArrowLeft, LuArrowRight, LuArrowUp, LuCornerDownLeft, LuPlugZap, LuRotateCw } from 'react-icons/lu'

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
  onRefused,
}: {
  agentId: string
  offline: boolean
  session?: string
  url?: string
  /** what it's attached to, after "Attached" */
  label?: string
  /** buttons at the end of its bar */
  actions?: React.ReactNode
  /** the server turned the connection away before it opened (the terminals are locked again) */
  onRefused?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<State>('connecting')
  const [attempt, setAttempt] = useState(0)
  // what the keys row (touch screens) types into the open connection
  const sendRef = useRef<((d: string) => void) | null>(null)
  // Ctrl armed from the keys row: the next letter typed (in the terminal or the command line) goes as Ctrl+letter
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

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
    let opened = false
    ws.addEventListener('open', () => (opened = true))
    ws.onclose = () => {
      setState('closed')
      if (!opened) onRefused?.()
    }
    const withCtrl = (d: string) => {
      if (!ctrlRef.current || !/^[a-z@[\\\]^_ ]$/i.test(d)) return d
      setCtrl(false)
      return d === ' ' ? '\x00' : String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f)
    }
    const input = term.onData((d) => send({ t: 'in', d: withCtrl(d) }))
    sendRef.current = (d) => send({ t: 'in', d: withCtrl(d) })

    const refit = () => {
      try {
        fit.fit()
        send({ t: 'resize', cols: term.cols, rows: term.rows })
      } catch {
        // element hidden
      }
    }
    const ro = new ResizeObserver(refit)
    ro.observe(host.current)
    // measured again once the font is in and a sheet has finished sliding up (the first size can be off by a row)
    void document.fonts?.ready.then(refit)
    const late = setTimeout(refit, 350)

    return () => {
      clearTimeout(late)
      sendRef.current = null
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
      {touch && state === 'open' && <TouchKeys send={(d) => sendRef.current?.(d)} ctrl={ctrl} onCtrl={() => setCtrl((v) => !v)} />}
    </div>
  )
}

// the keys row on touch screens: what a phone keyboard lacks or hides on its second page
const CONTROL: [React.ReactNode, string, string][] = [
  ['Esc', '\x1b', 'Escape'],
  ['Tab', '\t', 'Tab'],
  ['^C', '\x03', 'Control C (stop)'],
  ['^D', '\x04', 'Control D (exit)'],
  ['^Z', '\x1a', 'Control Z (suspend)'],
  ['^L', '\x0c', 'Control L (clear)'],
  ['^R', '\x12', 'Control R (search history)'],
  ['^A', '\x01', 'Control A (line start)'],
  ['^E', '\x05', 'Control E (line end)'],
  ['^U', '\x15', 'Control U (clear line)'],
  ['^W', '\x17', 'Control W (delete word)'],
]
const MOVE: [React.ReactNode, string, string][] = [
  [<LuArrowUp key="u" />, '\x1b[A', 'Up'],
  [<LuArrowDown key="d" />, '\x1b[B', 'Down'],
  [<LuArrowLeft key="l" />, '\x1b[D', 'Left'],
  [<LuArrowRight key="r" />, '\x1b[C', 'Right'],
  ['Home', '\x1b[H', 'Home'],
  ['End', '\x1b[F', 'End'],
  ['PgUp', '\x1b[5~', 'Page up'],
  ['PgDn', '\x1b[6~', 'Page down'],
]
const SYMBOLS = ['|', '/', '~', '-', '_', '.', ':', ';', '=', '>', '<', '&', '*', '$', '!', '#', "'", '"', '`', '\\', '(', ')', '[', ']', '{', '}']

/**
 * Phones: the keys a touch keyboard lacks (Esc, Tab, Ctrl and its shortcuts, arrows, Home/End, the symbols a shell
 * needs), and a line to type a command and send it.
 */
function TouchKeys({ send, ctrl, onCtrl }: { send: (d: string) => void; ctrl: boolean; onCtrl: () => void }) {
  const [line, setLine] = useState('')
  const key = (label: React.ReactNode, d: string, name: string) => (
    <button key={name} type="button" className="tkeys__key" aria-label={name} onMouseDown={(e) => e.preventDefault()} onClick={() => send(d)}>
      {label}
    </button>
  )
  return (
    <div className="tkeys">
      <div className="tkeys__row">
        <button
          type="button"
          className={`tkeys__key${ctrl ? ' is-on' : ''}`}
          aria-label="Control: the next letter is sent with Ctrl"
          aria-pressed={ctrl}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCtrl}
        >
          Ctrl
        </button>
        {CONTROL.map(([l, d, n]) => key(l, d, n))}
      </div>
      <div className="tkeys__row">{MOVE.map(([l, d, n]) => key(l, d, n))}</div>
      <div className="tkeys__row tkeys__row--sym">{SYMBOLS.map((c) => key(c, c, c))}</div>
      <form
        className="tkeys__line"
        onSubmit={(e) => {
          e.preventDefault()
          send(`${line}\r`)
          setLine('')
        }}
      >
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          placeholder="Type a command…"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
        />
        <button type="submit" className="icon-btn small" aria-label="Send">
          <LuCornerDownLeft />
        </button>
      </form>
    </div>
  )
}
