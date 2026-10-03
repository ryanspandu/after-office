import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

// Talking instead of typing: the browser's own speech recognition (Web Speech API: Chrome, Edge, Safari, the phone's
// browser) turns what the owner says into text for a chat. No server or key; the browser's maker does the listening
// (Chrome sends the audio to Google, Safari to Apple). Not every browser has it (Firefox doesn't): no mic button there.

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

const Ctor = (): RecognitionCtor | undefined =>
  typeof window === 'undefined' ? undefined : ((window as unknown as Record<string, RecognitionCtor | undefined>).SpeechRecognition ?? (window as unknown as Record<string, RecognitionCtor | undefined>).webkitSpeechRecognition)

export const dictationSupported = () => !!Ctor()

export const DICTATION_LANGS = [
  { value: 'id-ID', label: 'Indonesia' },
  { value: 'en-US', label: 'English' },
]
const LANG_KEY = 'after-office:dictation-lang'
const AUTO_KEY = 'after-office:dictation-auto-send'

/** How long a pause ends it (no need to press stop), and how long it waits for a first word. */
export const SILENCE_MS = 1800
const NO_SPEECH_MS = 8000

/**
 * The language it listens for, and whether what was said goes out by itself when you stop talking (hands-free) or
 * waits in the box to be checked first. Remembered in this browser.
 */
export const useDictationLang = create<{ lang: string; set: (lang: string) => void; autoSend: boolean; setAutoSend: (on: boolean) => void }>((set) => ({
  autoSend: (() => {
    try {
      return localStorage.getItem(AUTO_KEY) === '1'
    } catch {
      return false
    }
  })(),
  setAutoSend: (autoSend) => {
    try {
      localStorage.setItem(AUTO_KEY, autoSend ? '1' : '0')
    } catch {
      // this visit only
    }
    set({ autoSend })
  },
  lang: (() => {
    try {
      const saved = localStorage.getItem(LANG_KEY)
      if (saved && DICTATION_LANGS.some((l) => l.value === saved)) return saved
    } catch {
      // storage unavailable
    }
    // the owner talks Indonesian; English is one tap away (and remembered)
    return 'id-ID'
  })(),
  set: (lang) => {
    try {
      localStorage.setItem(LANG_KEY, lang)
    } catch {
      // this visit only
    }
    set({ lang })
  },
}))

const ERRORS: Record<string, string> = {
  'not-allowed': 'The microphone is blocked for this site: allow it in the browser',
  'service-not-allowed': 'Speech recognition is not allowed in this browser',
  'audio-capture': 'No microphone found',
  // Chrome sends the audio to Google; Brave, Arc, Opera and other Chromium browsers (and apps built on it) have that
  // part switched off, and say "network" whatever the connection
  network: "This browser can't reach its speech service (Brave, Arc and some other Chromium browsers turn it off). Try Chrome, Edge or Safari",
}

/** How a run of listening ended: the words, and whether they should go out now (held to talk, or hands-free). */
export interface Heard {
  text: string
  send: boolean
}

/**
 * Listen: `text` is what was said so far (settled), `interim` the words still being heard. It ends by itself after a
 * pause (or when nothing is said at all); `stop()` ends it now, `cancel()` drops it. `onDone` gets the words once it has
 * ended, with `send` when they should go out right away: held to talk (`start({ hold: true })`, ends on `stop()`
 * only), or hands-free (the owner's auto-send).
 */
export function useDictation(onDone?: (heard: Heard) => void) {
  const lang = useDictationLang((s) => s.lang)
  const [listening, setListening] = useState(false)
  const [holding, setHolding] = useState(false)
  const [text, setText] = useState('')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const finalText = useRef('')
  const done = useRef(onDone)
  done.current = onDone
  const cancelled = useRef(false)
  const hold = useRef(false)
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearQuiet = () => {
    if (quiet.current) clearTimeout(quiet.current)
    quiet.current = null
  }
  /** a pause (or no word at all) ends it, unless it's held */
  const armQuiet = (ms: number) => {
    clearQuiet()
    if (!hold.current) quiet.current = setTimeout(() => rec.current?.stop(), ms)
  }

  const stop = () => {
    clearQuiet()
    rec.current?.stop()
  }
  /** a press that turned out to be a tap: it keeps listening, and a pause ends it */
  const unhold = () => {
    if (!hold.current) return
    hold.current = false
    setHolding(false)
    if (rec.current) armQuiet(SILENCE_MS)
  }
  const cancel = () => {
    cancelled.current = true
    clearQuiet()
    rec.current?.abort()
  }
  const start = (opts: { hold?: boolean } = {}) => {
    const R = Ctor()
    if (!R || rec.current) return
    const r = new R()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    finalText.current = ''
    cancelled.current = false
    hold.current = !!opts.hold
    setHolding(!!opts.hold)
    setText('')
    setInterim('')
    setError(null)
    r.onresult = (e) => {
      let heard = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText.current = `${finalText.current} ${piece}`.replace(/\s+/g, ' ').trim()
        else heard += piece
      }
      setText(finalText.current)
      setInterim(heard.trim())
      // still talking: the pause that ends it starts over (words still being heard count as finished once it ends)
      if (heard.trim()) finalPending.current = heard.trim()
      else finalPending.current = ''
      armQuiet(SILENCE_MS)
    }
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      // Brave has the API but turns off the service behind it: it says "not allowed" / "network" whatever the settings
      if ((navigator as Navigator & { brave?: unknown }).brave && (e.error === 'not-allowed' || e.error === 'network'))
        return setError("Brave turns off the browser's speech recognition (even with the microphone allowed). Use Chrome, Edge or Safari for voice")
      setError(ERRORS[e.error] ?? `Could not listen (${e.error})`)
    }
    r.onend = () => {
      clearQuiet()
      rec.current = null
      setListening(false)
      setHolding(false)
      setInterim('')
      // words heard but not settled when it stopped (Safari leaves the last phrase so) still count
      const said = `${finalText.current} ${finalPending.current}`.replace(/\s+/g, ' ').trim()
      finalPending.current = ''
      if (said && !cancelled.current) done.current?.({ text: said, send: hold.current || useDictationLang.getState().autoSend })
    }
    rec.current = r
    try {
      r.start()
      setListening(true)
      armQuiet(NO_SPEECH_MS)
    } catch (e) {
      rec.current = null
      setError(e instanceof Error ? e.message : 'Could not listen')
    }
  }
  const finalPending = useRef('')
  // gone (window closed): stop listening
  useEffect(
    () => () => {
      cancelled.current = true
      clearQuiet()
      rec.current?.abort()
    },
    [],
  )
  return { supported: dictationSupported(), listening, holding, text, interim, error, start, stop, cancel, unhold, setError }
}
