import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LuCheck, LuLoader, LuMic, LuMicOff, LuSend, LuSquare, LuX } from 'react-icons/lu'
import { DICTATION_LANGS, dictationSupported, useDictation, useDictationLang } from '../state/dictation'
import { liveApi } from '../state/live'
import { useManager, useManagerPanel } from './ManagerPanel'
import { tip } from './Tooltip'

// Voice: the owner talks, the words go to an agent as a chat message (state/dictation.ts does the listening). In every
// chat's message box (a mic next to Send), and next to the navbar's Manager button for the manager without opening
// its chat. The agents only listen for now: they still answer in text.

type Dictation = ReturnType<typeof useDictation>

/** Start / stop listening. */
export function MicButton({ dict, disabled }: { dict: Dictation; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`icon-btn ghost mic-btn${dict.listening ? ' is-listening' : ''}`}
      onClick={() => (dict.listening ? dict.stop() : dict.start())}
      disabled={disabled}
      aria-pressed={dict.listening}
      {...tip(dict.listening ? 'Stop listening' : 'Talk instead of typing')}
    >
      {dict.listening ? <LuSquare /> : <LuMic />}
    </button>
  )
}

/** The language it listens for. */
export function LangPick() {
  const { lang, set } = useDictationLang()
  return (
    <span className="voice-lang" role="radiogroup" aria-label="Language">
      {DICTATION_LANGS.map((l) => (
        <button key={l.value} type="button" role="radio" aria-checked={lang === l.value} className={lang === l.value ? 'is-on' : ''} onClick={() => set(l.value)}>
          {l.value.slice(0, 2).toUpperCase()}
        </button>
      ))}
    </span>
  )
}

/** Above the message box while listening: what's being heard, live. */
export function ListeningBar({ dict }: { dict: Dictation }) {
  if (dict.error)
    return (
      <div className="voice-bar voice-bar--error" role="alert">
        <LuMicOff /> <span className="grow">{dict.error}</span>
        <button className="icon-btn small ghost" aria-label="Dismiss" onClick={() => dict.setError(null)}>
          <LuX />
        </button>
      </div>
    )
  return (
    <div className="voice-bar" role="status">
      <span className="voice-dot" aria-hidden />
      <span className="voice-bar__text grow">
        {dict.text || dict.interim ? (
          <>
            {dict.text} <span className="muted">{dict.interim}</span>
          </>
        ) : (
          <span className="muted">Listening… talk, then press ■ (or pause)</span>
        )}
      </span>
      <LangPick />
    </div>
  )
}

/**
 * Navbar: talk to the manager without opening its chat. Opens listening; when you stop, the words are there to check
 * (and fix) before they go, as a message in the manager's chat.
 */
export function ManagerVoiceButton() {
  const manager = useManager()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (!manager || !dictationSupported()) return null
  return (
    <>
      <button
        ref={btn}
        className={`icon-btn manager-voice${open ? ' is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...tip(`Talk to ${manager.name}`)}
      >
        <LuMic />
      </button>
      {open && <ManagerVoicePop anchor={btn.current} managerId={manager.id} name={manager.name} offline={manager.status === 'offline'} onClose={() => setOpen(false)} />}
    </>
  )
}

function ManagerVoicePop({ anchor, managerId, name, offline, onClose }: { anchor: HTMLElement | null; managerId: string; name: string; offline: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const dict = useDictation((said) => setDraft((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said)))
  const pop = useRef<HTMLDivElement>(null)
  // opening it starts listening
  useEffect(() => {
    if (!offline) dict.start()
    // once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // a click outside (not on its own button) or Esc closes it
  useEffect(() => {
    const away = (e: PointerEvent) => !pop.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && (dict.cancel(), onClose())
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (dict.cancel(), onClose())
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  })

  const send = async () => {
    const body = draft.trim()
    if (!body || state === 'sending') return
    setState('sending')
    setError(null)
    try {
      await liveApi.prompt(managerId, body)
      setState('sent')
      setDraft('')
      setTimeout(onClose, 1200)
    } catch (e) {
      setState('idle')
      setError(e instanceof Error ? e.message : 'Could not send')
    }
  }

  const r = anchor?.getBoundingClientRect()
  const width = Math.min(380, window.innerWidth - 16)
  const style = r ? { top: r.bottom + 8, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), width } : undefined
  return createPortal(
    <div className="voice-pop" ref={pop} style={style} role="dialog" aria-label={`Talk to ${name}`}>
      <div className="voice-pop__head">
        <b>Talk to {name}</b>
        <LangPick />
        <button className="icon-btn small ghost" aria-label="Close" onClick={() => (dict.cancel(), onClose())}>
          <LuX />
        </button>
      </div>
      {offline ? (
        <p className="muted voice-pop__note">{name} is offline right now.</p>
      ) : state === 'sent' ? (
        <p className="voice-pop__sent">
          <LuCheck /> Sent to {name}. The answer comes in its chat.
        </p>
      ) : (
        <>
          {dict.listening ? (
            <div className="voice-pop__live" role="status">
              <span className="voice-dot" aria-hidden />
              <span className="grow">
                {draft} {dict.text} <span className="muted">{dict.interim || (!dict.text && !draft ? 'Listening… talk now' : '')}</span>
              </span>
            </div>
          ) : (
            <textarea
              className="voice-pop__draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={3}
              placeholder="Press the mic and talk, or type here"
              autoFocus
            />
          )}
          {(dict.error || error) && <p className="danger-text voice-pop__note">{dict.error ?? error}</p>}
          <div className="voice-pop__foot">
            <MicButton dict={dict} />
            <span className="muted voice-pop__hint">{dict.listening ? 'Press ■ when you are done' : draft ? 'Check it, then send' : ''}</span>
            <span className="grow" />
            <button className="small" onClick={() => useManagerPanel.getState().setOpen(true)}>
              Open chat
            </button>
            <button className="small primary" onClick={() => void send()} disabled={!draft.trim() || dict.listening || state === 'sending'}>
              {state === 'sending' ? <LuLoader className="spin" /> : <LuSend />} Send
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
