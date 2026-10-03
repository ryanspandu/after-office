import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { LuArrowDown, LuArrowLeft, LuArrowRight, LuArrowUp, LuCheck, LuCopy, LuCornerDownLeft, LuPlugZap, LuRotateCw, LuSquareTerminal, LuTextSelect, LuX } from 'react-icons/lu'
import { MOBILE, useMediaQuery } from '../../state/useMediaQuery'
import { getParam, openUrl, setUrl, useParam } from '../../state/url'

// The real Claude Code TUI: xterm.js attached to the agent's tmux session through /api/agents/:id/term.
// Typing here is exactly like typing in the terminal on the server.
// Phones: it opens full screen, on its own layer (?tfull=1; Back closes it), at one size for as long as it's open: a
// sheet's drag or the keyboard never resize it (xterm loses its screen when resized there). The keys row and the
// command line float at the bottom, above the keyboard when it's up; the screen slides up so the cursor's row shows.

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
  const termRef = useRef<Terminal | null>(null)
  const redrawRef = useRef<(() => void) | null>(null)
  // touch screens can't select in xterm: its text as plain text instead (selected the phone's own way), or copied whole
  const [picking, setPicking] = useState<string | null>(null)
  const phone = useMediaQuery(MOBILE)
  const full = useParam('tfull') === '1'
  const fullPhone = phone && full
  // the full-screen layer's height: fixed when it opens (the keyboard coming up mustn't shrink it)
  const [fullH, setFullH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 0))
  const frameRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const openFull = () => (setFullH(window.innerHeight), openUrl({ tfull: '1' }))
  const closeFull = () => setUrl({ tfull: null })
  // phones: opening the Terminal tab opens the terminal (once; closed, the tab offers it again)
  useEffect(() => {
    if (phone && !offline && !getParam('tfull')) openFull()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, offline])
  // turned sideways: the layer takes the new height (and the terminal its new size, once)
  useEffect(() => {
    if (!fullPhone) return
    const turn = () => setTimeout(() => setFullH(window.innerHeight), 300)
    // opened with the keyboard up: it grows to the whole screen once the keyboard goes (never shrinks for it)
    const grow = () => setFullH((h) => Math.max(h, window.innerHeight))
    window.addEventListener('orientationchange', turn)
    window.addEventListener('resize', grow)
    return () => {
      window.removeEventListener('orientationchange', turn)
      window.removeEventListener('resize', grow)
    }
  }, [fullPhone])

  useEffect(() => {
    // (phones: only while the full-screen layer is open; host is there then)
    if (offline || !host.current || (phone && !full)) return
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
    termRef.current = term
    // phones: a tap on the screen focuses xterm's hidden field (in the tap itself, or the keyboard won't come up),
    // and that field takes keys as typed: no capitals, corrections or suggestions
    const ta = term.textarea
    if (ta) {
      ta.setAttribute('autocapitalize', 'off')
      ta.setAttribute('autocorrect', 'off')
      ta.setAttribute('autocomplete', 'off')
      ta.setAttribute('spellcheck', 'false')
    }
    const el = host.current
    const tapFocus = () => term.focus()
    el.addEventListener('click', tapFocus)
    // phones: a long press can't select in xterm (it only offers Paste), so it opens the terminal's text to select
    let press = 0
    let at: { x: number; y: number } | null = null
    const cancelPress = () => (clearTimeout(press), (at = null))
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return cancelPress()
      at = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      clearTimeout(press)
      press = window.setTimeout(() => {
        if (!at) return
        at = null
        term.blur()
        setPicking(termText(term))
      }, 450)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (at && Math.hypot(e.touches[0].clientX - at.x, e.touches[0].clientY - at.y) > 8) cancelPress()
    }
    // a tap (no long press, no scroll): the keyboard up, right away. Android won't bring it back for a field that's
    // still focused after the keyboard was put away, so the field lets go first and is focused again in the tap.
    const onTouchEnd = (e: TouchEvent) => {
      const tap = !!at
      cancelPress()
      if (!tap || !ta) return
      e.preventDefault() // no click after it (that would focus a second time)
      ta.blur()
      ta.focus()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', cancelPress)

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}${url ?? `/api/agents/${agentId}/term${session ? `?session=${session}` : ''}`}`)
    ws.binaryType = 'arraybuffer'
    const send = (m: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    ws.onopen = () => {
      setState('open')
      send({ t: 'resize', cols: term.cols, rows: term.rows })
      term.focus()
      // once tmux has attached (the first resize starts it): the whole screen, whatever the timing
      setTimeout(() => redrawRef.current?.(), 300)
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

    let redrawTimer = 0
    // the whole screen sent again by tmux (the server runs refresh-client): it otherwise only repaints what changed,
    // and a screen that missed a paint (a sheet still sliding up, a phone's keyboard) stays blank until something is typed
    const redraw = () => {
      clearTimeout(redrawTimer)
      redrawTimer = window.setTimeout(() => {
        send({ t: 'redraw' })
        // and painted once tmux's screen is in
        setTimeout(unscroll, 250)
      }, 150)
    }
    // a phone scrolls the box around xterm's hidden field into view when its keyboard opens: the screen slides out
    // of its frame (the cursor still blinking where it was). Put back, and every row painted again.
    const unscroll = () => {
      for (let n: HTMLElement | null = el; n && n !== el.parentElement?.parentElement; n = n.parentElement) if (n.scrollTop) n.scrollTop = 0
      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      if (screen?.parentElement?.scrollLeft) screen.parentElement.scrollLeft = 0
      term.refresh(0, term.rows - 1)
    }
    const refit = () => {
      try {
        const { cols, rows } = term
        fit.fit()
        send({ t: 'resize', cols: term.cols, rows: term.rows })
        unscroll()
        if (term.cols !== cols || term.rows !== rows) redraw()
      } catch {
        // element hidden
      }
    }
    redrawRef.current = redraw
    const ro = new ResizeObserver(refit)
    ro.observe(host.current)
    // measured again once the font is in and a sheet has finished sliding up (the first size can be off by a row),
    // then the whole screen once more
    const settle = () => (refit(), redraw())
    void document.fonts?.ready.then(settle)
    const late = setTimeout(settle, 450)
    // back to the app (a phone locks, another app): the screen may have missed a repaint
    const back = () => document.visibilityState === 'visible' && settle()
    document.addEventListener('visibilitychange', back)
    // the phone's keyboard opening or closing (the visible part of the page changes size): after it has finished
    let kbTimer = 0
    const onViewport = () => {
      clearTimeout(kbTimer)
      kbTimer = window.setTimeout(settle, 250)
    }
    // phones (full screen): the keyboard doesn't resize the terminal; the floating keys go above it, and the screen
    // slides up just enough for the cursor's row to show above them
    let placeFrame = 0
    const place = () => {
      cancelAnimationFrame(placeFrame)
      placeFrame = requestAnimationFrame(() => {
        const frame = frameRef.current
        const dock = dockRef.current
        if (!frame || !dock) return
        const vv = window.visualViewport
        const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
        dock.style.bottom = `${kb}px`
        frame.style.transform = ''
        const screen = el.querySelector<HTMLElement>('.xterm-screen')
        if (!screen) return
        const rowH = screen.clientHeight / term.rows
        const cursorBottom = screen.getBoundingClientRect().top + (term.buffer.active.cursorY + 1) * rowH
        const over = cursorBottom - (dock.getBoundingClientRect().top - 6)
        if (over > 0) frame.style.transform = `translateY(${-Math.ceil(over)}px)`
      })
    }
    const cursorMoved = fullPhone ? term.onCursorMove(place) : null
    if (fullPhone) {
      window.visualViewport?.addEventListener('resize', place)
      window.visualViewport?.addEventListener('scroll', place)
      window.addEventListener('resize', place)
    } else window.visualViewport?.addEventListener('resize', onViewport)
    // (only the frames around xterm: its own viewport scrolls through the scrollback)
    const frames = [el, el.parentElement].filter((n): n is HTMLElement => !!n)
    for (const f of frames) f.addEventListener('scroll', unscroll)

    return () => {
      clearTimeout(late)
      clearTimeout(redrawTimer)
      document.removeEventListener('visibilitychange', back)
      clearTimeout(kbTimer)
      window.visualViewport?.removeEventListener('resize', onViewport)
      cancelAnimationFrame(placeFrame)
      cursorMoved?.dispose()
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      for (const f of frames) f.removeEventListener('scroll', unscroll)
      el.removeEventListener('click', tapFocus)
      cancelPress()
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', cancelPress)
      termRef.current = null
      redrawRef.current = null
      sendRef.current = null
      ro.disconnect()
      input.dispose()
      ws.close()
      term.dispose()
    }
  }, [agentId, offline, attempt, session, url, phone, full])

  if (offline) return <div className="empty">The agent is offline. It restarts automatically, or use Restart in Overview.</div>

  const bar = (
    <div className="term__bar">
      <span className={`live-dot${state === 'open' ? ' live-dot--on' : ''}`} />
      <span className="muted term__state">{state === 'open' ? `Attached · ${label}` : state === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
      {state === 'closed' && (
        <button className="small" onClick={() => (setState('connecting'), setAttempt((n) => n + 1))}>
          <LuRotateCw /> Reconnect
        </button>
      )}
      <span className="grow" />
      <span className="muted term__hint">
        <LuPlugZap /> Closing this only detaches; it keeps running
      </span>
      {state === 'open' && (
        <button className="small term__select" onClick={() => setPicking(termText(termRef.current))} data-tip="The terminal's text, to select and copy">
          <LuTextSelect /> Select
        </button>
      )}
      {actions}
      {fullPhone && (
        <button className="icon-btn small term-full__close" onClick={closeFull} aria-label="Close the terminal (it keeps running)">
          <LuX />
        </button>
      )}
    </div>
  )
  // padding lives on the frame; xterm measures the inner box, so fit() doesn't count the padding as rows
  const screen = (
    <div className="term__screen" ref={frameRef}>
      <div className="term__host" ref={host} />
      {picking !== null && <TextPick text={picking} onClose={() => (setPicking(null), redrawRef.current?.(), termRef.current?.focus())} />}
    </div>
  )
  const keys = (touch || phone) && state === 'open' && <TouchKeys send={(d) => sendRef.current?.(d)} ctrl={ctrl} onCtrl={() => setCtrl((v) => !v)} />

  if (!phone)
    return (
      <div className="term">
        {bar}
        {screen}
        {keys}
      </div>
    )

  // phones: the tab only opens it; the terminal is a full-screen layer of its own
  return (
    <div className="term term--launch">
      <div className="term-launch">
        <LuSquareTerminal className="term-launch__icon" />
        <p className="muted">Opens full screen. Closing it only detaches; it keeps running.</p>
        <button className="primary" onClick={openFull}>
          <LuSquareTerminal /> Open terminal
        </button>
        {actions && <div className="term-launch__actions">{actions}</div>}
      </div>
      {fullPhone &&
        createPortal(
          <div className="term-full" style={{ height: fullH }} role="dialog" aria-modal="true" aria-label="Terminal">
            {bar}
            {screen}
            {/* floats at the bottom, above the keyboard when it's up (moved there by place()) */}
            <div className="term-full__dock" ref={dockRef}>
              {keys}
            </div>
          </div>,
          document.body,
        )}
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
 * needs) in one row that scrolls sideways, and a line to type a command and send it.
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
        {CONTROL.slice(0, 2).map(([l, d, n]) => key(l, d, n))}
        {/* one row, scrolled sideways: Ctrl, Esc, Tab, the arrows, then the shortcuts, the other moves and the symbols */}
        {MOVE.slice(0, 4).map(([l, d, n]) => key(l, d, n))}
        {CONTROL.slice(2).map(([l, d, n]) => key(l, d, n))}
        {MOVE.slice(4).map(([l, d, n]) => key(l, d, n))}
        {SYMBOLS.map((c) => (
          <span key={`sym-${c}`} className="tkeys__sym">
            {key(c, c, c)}
          </span>
        ))}
      </div>
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

/** What the terminal shows and keeps above (its scrollback), as plain text: trailing blank lines dropped. */
function termText(term: Terminal | null) {
  if (!term) return ''
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    // a wrapped row continues the one before it
    if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true)
    else lines.push(line.translateToString(true))
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join('\n')
}

/** The terminal's text over its screen: selected the phone's own way (long press, handles), or copied whole. */
function TextPick({ text, onClose }: { text: string; onClose: () => void }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  // opens at the end (the latest output), like the terminal
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [])
  const copy = async () => {
    const sel = window.getSelection()?.toString()
    try {
      await navigator.clipboard.writeText(sel && pre.current?.contains(window.getSelection()!.anchorNode) ? sel : text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // no clipboard (not a secure page): the text is still there to select
    }
  }
  return (
    <div className="term-pick ui-drop">
      <div className="term-pick__bar">
        <span className="muted">Long-press a word to select it, drag the handles, then Copy (or Copy for all of it)</span>
        <span className="grow" />
        <button type="button" className="small" onClick={() => void copy()}>
          {copied ? <LuCheck /> : <LuCopy />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Back to the terminal">
          <LuX />
        </button>
      </div>
      <pre ref={pre} className="term-pick__text">
        {text || ' '}
      </pre>
    </div>
  )
}
