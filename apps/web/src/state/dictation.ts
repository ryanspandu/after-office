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

/** The language it listens for, remembered in this browser (Indonesian to start with). */
export const useDictationLang = create<{ lang: string; set: (lang: string) => void }>((set) => ({
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

/**
 * Listen while `listening`: `text` is what was said so far (settled), `interim` the words still being heard. Stops by
 * itself after a pause on some browsers; `stop()` ends it, `onDone` gets the whole text once it has ended.
 */
export function useDictation(onDone?: (text: string) => void) {
  const lang = useDictationLang((s) => s.lang)
  const [listening, setListening] = useState(false)
  const [text, setText] = useState('')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const finalText = useRef('')
  const done = useRef(onDone)
  done.current = onDone

  const stop = () => rec.current?.stop()
  const cancel = () => {
    done.current = undefined
    rec.current?.abort()
  }
  const start = () => {
    const R = Ctor()
    if (!R || rec.current) return
    const r = new R()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    finalText.current = ''
    setText('')
    setInterim('')
    setError(null)
    done.current = onDone
    r.onresult = (e) => {
      let heard = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText.current = `${finalText.current} ${piece}`.replace(/\s+/g, ' ').trim()
        else heard += piece
      }
      setText(finalText.current)
      setInterim(heard.trim())
    }
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(ERRORS[e.error] ?? `Could not listen (${e.error})`)
    }
    r.onend = () => {
      rec.current = null
      setListening(false)
      setInterim('')
      const said = finalText.current.trim()
      if (said) done.current?.(said)
    }
    rec.current = r
    try {
      r.start()
      setListening(true)
    } catch (e) {
      rec.current = null
      setError(e instanceof Error ? e.message : 'Could not listen')
    }
  }
  // gone (window closed): stop listening
  useEffect(() => () => rec.current?.abort(), [])
  return { supported: dictationSupported(), listening, text, interim, error, start, stop, cancel, setError }
}
