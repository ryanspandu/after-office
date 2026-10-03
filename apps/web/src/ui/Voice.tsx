import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LuCheck, LuLoader, LuMic, LuMicOff, LuSend, LuSquare, LuVolume2, LuVolumeX, LuX } from 'react-icons/lu'
import { useOffice } from '../state/store'
import { DICTATION_LANGS, dictationSupported, useDictation, useDictationLang } from '../state/dictation'
import { liveApi } from '../state/live'
import { primeSpeech, speak, stopSpeaking, talkedByVoice, useSpeech, speechSupported, type ReadAloud } from '../state/speech'
import { useManager, useManagerPanel } from './ManagerPanel'
import { tip } from './Tooltip'

// Voice: the owner talks, the words go to an agent as a chat message (state/dictation.ts does the listening). In every
// chat's message box (a mic next to Send), and next to the navbar's Manager button for the manager without opening
// its chat. The agents only listen for now: they still answer in text.

type Dictation = ReturnType<typeof useDictation>

/** A press this long is "hold to talk": let go and it's sent. Shorter is a tap: listen until a pause (or ■). */
const HOLD_MS = 350

/** Tap: start (a pause, or another tap, ends it). Hold: talk while it's held, let go to send. */
export function MicButton({ dict, disabled }: { dict: Dictation; disabled?: boolean }) {
  const pressedAt = useRef(0)
  const wasListening = useRef(false)
  return (
    <button
      type="button"
      className={`icon-btn ghost mic-btn${dict.listening ? ' is-listening' : ''}${dict.holding ? ' is-holding' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return
        wasListening.current = dict.listening
        pressedAt.current = performance.now()
        // talking over an answer being read: it stops (and this tap lets the answer be read later: Safari)
        stopSpeaking()
        primeSpeech()
        // listening already: this press stops it (on release); else start now, as held until we know
        if (!dict.listening) dict.start({ hold: true })
      }}
      onPointerUp={() => {
        if (!pressedAt.current) return
        const held = performance.now() - pressedAt.current >= HOLD_MS
        pressedAt.current = 0
        if (wasListening.current) return dict.stop()
        if (held) dict.stop()
        else dict.unhold()
      }}
      onPointerCancel={() => {
        pressedAt.current = 0
        dict.cancel()
      }}
      onContextMenu={(e) => e.preventDefault()}
      // the keyboard: Enter / Space toggle it
      onClick={(e) => e.detail === 0 && (dict.listening ? dict.stop() : dict.start())}
      disabled={disabled}
      aria-pressed={dict.listening}
      {...tip(dict.listening ? (dict.holding ? 'Let go to send' : 'Stop listening') : 'Tap to talk · hold to talk and send')}
    >
      {dict.listening && !dict.holding ? <LuSquare /> : <LuMic />}
    </button>
  )
}

const READ_LABEL: Record<ReadAloud, string> = { voice: 'Read replies: when I talk', always: 'Read replies: always', off: 'Read replies: off' }
const READ_NEXT: Record<ReadAloud, ReadAloud> = { voice: 'always', always: 'off', off: 'voice' }

/** Whether answers are read out: after you talked (default), always (manager and the open chat), or never. */
export function ReadAloudToggle() {
  const { mode, setMode } = useSpeech()
  if (!speechSupported()) return null
  return (
    <button
      type="button"
      className={`voice-auto${mode !== 'off' ? ' is-on' : ''}`}
      onClick={() => {
        const next = READ_NEXT[mode]
        setMode(next)
        // a short sample, so you hear that (and how) it works; this click also lets later answers be read (Safari)
        if (next !== 'off') speak('', useDictationLang.getState().lang.startsWith('id') ? 'Oke, jawaban akan dibacakan.' : 'Okay, answers will be read out.')
      }}
      {...tip(mode === 'voice' ? 'Answers to what you said are read out' : mode === 'always' ? "Every answer from the manager and the open chat is read out" : 'Answers stay text only')}
    >
      {mode === 'off' ? <LuVolumeX /> : <LuVolume2 />} {READ_LABEL[mode].replace('Read replies: ', '')}
    </button>
  )
}

/** Navbar, while an answer is being read: who's talking, and stop. */
export function SpeakingChip() {
  const speaking = useSpeech((s) => s.speaking)
  const name = useOffice((s) => s.agents.find((a) => a.id === speaking)?.name)
  if (!speaking) return null
  return (
    <button className="speaking-chip" onClick={stopSpeaking} {...tip('Stop reading')}>
      <span className="speaking-chip__bars" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {name ?? 'Voice'} <LuSquare />
    </button>
  )
}

/** Send what was said as soon as you stop talking, or keep it in the box to check first. */
export function AutoSendToggle() {
  const { autoSend, setAutoSend } = useDictationLang()
  return (
    <button type="button" className={`voice-auto${autoSend ? ' is-on' : ''}`} aria-pressed={autoSend} onClick={() => setAutoSend(!autoSend)} {...tip(autoSend ? 'Sent as soon as you stop talking' : 'Kept in the box to check before sending')}>
      {autoSend ? 'Auto-send on' : 'Auto-send off'}
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
          <span className="muted">{dict.holding ? 'Listening… let go to send' : 'Listening… stop talking for a moment to finish'}</span>
        )}
      </span>
      {!dict.holding && <ReadAloudToggle />}
      {!dict.holding && <AutoSendToggle />}
      <LangPick />
    </div>
  )
}

/** The keys to hold for talking to the manager from anywhere (desktop): Alt+Space (⌥ Space on a Mac). */
const isTalkKey = (e: KeyboardEvent) => e.code === 'Space' && e.altKey && !e.ctrlKey && !e.metaKey

/**
 * Navbar: talk to the manager without opening its chat. A click opens it listening (a pause ends it); hold Alt+Space
 * anywhere to talk and let go to send. What was said is checked first, unless it was held or auto-send is on.
 */
export function ManagerVoiceButton() {
  const manager = useManager()
  // how it was opened: a click, or the held keys (let go: `released` goes up)
  const [open, setOpen] = useState<null | 'tap' | 'hold'>(null)
  const [released, setReleased] = useState(0)
  const btn = useRef<HTMLButtonElement>(null)
  const supported = dictationSupported()
  const holdingKeys = useRef(false)
  useEffect(() => {
    if (!manager || !supported) return
    const down = (e: KeyboardEvent) => {
      if (!isTalkKey(e)) return
      e.preventDefault()
      if (e.repeat || holdingKeys.current) return
      holdingKeys.current = true
      stopSpeaking()
      primeSpeech()
      setOpen('hold')
    }
    const up = (e: KeyboardEvent) => {
      if (!holdingKeys.current || (e.code !== 'Space' && e.key !== 'Alt')) return
      holdingKeys.current = false
      setReleased((n) => n + 1)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [manager, supported])
  if (!manager || !supported) return null
  return (
    <>
      <button
        ref={btn}
        className={`icon-btn manager-voice${open ? ' is-on' : ''}`}
        onClick={() => (primeSpeech(), setOpen((v) => (v ? null : 'tap')))}
        aria-expanded={!!open}
        {...tip(`Talk to ${manager.name} · or hold Alt+Space anywhere`)}
      >
        <LuMic />
      </button>
      {open && (
        <ManagerVoicePop
          key={open}
          anchor={btn.current}
          managerId={manager.id}
          name={manager.name}
          offline={manager.status === 'offline'}
          hold={open === 'hold'}
          released={released}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

function ManagerVoicePop({
  anchor,
  managerId,
  name,
  offline,
  hold,
  released,
  onClose,
}: {
  anchor: HTMLElement | null
  managerId: string
  name: string
  offline: boolean
  hold: boolean
  released: number
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  draftRef.current = draft
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const send = async (text?: string) => {
    const body = (text ?? draftRef.current).trim()
    if (!body || state === 'sending') return
    setState('sending')
    setError(null)
    try {
      await liveApi.prompt(managerId, body)
      // its answer is read out (state/speech.ts)
      talkedByVoice(managerId)
      setState('sent')
      setDraft('')
      setTimeout(onClose, 1200)
    } catch (e) {
      setState('idle')
      setDraft(body)
      setError(e instanceof Error ? e.message : 'Could not send')
    }
  }
  const dict = useDictation(({ text: said, send: now }) => {
    const body = draftRef.current.trim() ? `${draftRef.current.trimEnd()} ${said}` : said
    if (now) void send(body)
    else setDraft(body)
  })
  const pop = useRef<HTMLDivElement>(null)
  // opening it starts listening (held: until the keys are let go)
  useEffect(() => {
    if (!offline) dict.start({ hold })
    // once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const firstRelease = useRef(released)
  useEffect(() => {
    if (released !== firstRelease.current) dict.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [released])
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

  const r = anchor?.getBoundingClientRect()
  const width = Math.min(380, window.innerWidth - 16)
  const style = r ? { top: r.bottom + 8, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), width } : undefined
  return createPortal(
    <div className="voice-pop" ref={pop} style={style} role="dialog" aria-label={`Talk to ${name}`}>
      <div className="voice-pop__head">
        <b>Talk to {name}</b>
        <ReadAloudToggle />
        <AutoSendToggle />
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
          {dict.listening || state === 'sending' ? (
            <div className="voice-pop__live" role="status">
              {state === 'sending' ? <LuLoader className="spin" /> : <span className="voice-dot" aria-hidden />}
              <span className="grow">
                {draft} {dict.text}{' '}
                <span className="muted">
                  {dict.interim ||
                    (state === 'sending' ? 'Sending…' : !dict.text && !draft ? (dict.holding ? 'Listening… let go to send' : 'Listening… talk now') : '')}
                </span>
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
            <span className="muted voice-pop__hint">
              {dict.listening ? (dict.holding ? 'Let go to send' : 'Stop talking to finish') : draft ? 'Check it, then send' : 'Tap or hold the mic'}
            </span>
            <span className="grow" />
            <button className="small" onClick={() => useManagerPanel.getState().setOpen(true)}>
              Open chat
            </button>
            <button className="small primary" onClick={() => (primeSpeech(), void send())} disabled={!draft.trim() || dict.listening || state === 'sending'}>
              {state === 'sending' ? <LuLoader className="spin" /> : <LuSend />} Send
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
