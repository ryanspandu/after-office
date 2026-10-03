import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChatItem } from '@after-office/shared'
import { api } from './auth'
import { useOffice } from './store'
import { useDictationLang } from './dictation'
import { chatOnScreen } from './replyAlerts'
import { speakable } from './speakable'
export { speakable }

// Agents answering out loud: the browser's own voices (speechSynthesis: on the device, free; works in Brave too) read
// an agent's reply. By default only when the owner talked to it (a message sent by voice); or every reply from the
// manager and from the chat that's open; or never. The words only: code, tables and paths are left to the chat.

export type ReadAloud = 'voice' | 'always' | 'off'
const MODE_KEY = 'after-office:read-aloud'
/** Talked to an agent this long ago: its answer is still read out. */
const ANSWER_WAIT_MS = 30 * 60_000

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

interface SpeechStore {
  mode: ReadAloud
  setMode: (m: ReadAloud) => void
  /** the agent being read out now */
  speaking: string | null
  /** agents the owner just talked to by voice (id → when): their next answer is read */
  talkedTo: Record<string, number>
}

export const useSpeech = create<SpeechStore>((set) => ({
  mode: (() => {
    try {
      const m = localStorage.getItem(MODE_KEY)
      return m === 'always' || m === 'off' ? m : 'voice'
    } catch {
      return 'voice'
    }
  })(),
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      // this visit only
    }
    if (mode === 'off') stopSpeaking()
    set({ mode })
  },
  speaking: null,
  talkedTo: {},
}))

/** A message went to `agentId` by voice: read its answer. */
export const talkedByVoice = (agentId: string) => useSpeech.setState((s) => ({ talkedTo: { ...s.talkedTo, [agentId]: Date.now() } }))

export function stopSpeaking() {
  if (!speechSupported()) return
  window.speechSynthesis.cancel()
  useSpeech.setState({ speaking: null })
}

/** The best voice the device has for this language (a natural / Google / premium one first). */
function voiceFor(lang: string) {
  const voices = window.speechSynthesis.getVoices()
  const base = lang.slice(0, 2).toLowerCase()
  const fit = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base))
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|premium|enhanced/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 2 : 0) + (v.lang.replace('_', '-') === lang ? 1 : 0) + (v.localService ? 0 : 0)
  return fit.sort((a, b) => score(b) - score(a))[0]
}

/**
 * Safari (and phones) only let a page talk once the owner has done something on it that asked for sound: a silent
 * word said inside their tap (the mic, Send, Alt+Space) unlocks it for the answers that come later, on their own.
 */
let primed = false
export function primeSpeech() {
  if (primed || !speechSupported()) return
  primed = true
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  window.speechSynthesis.speak(u)
}

/** Read `text` out for `agentId` (anything being read stops first). */
export function speak(agentId: string, text: string) {
  if (!speechSupported()) return
  const words = speakable(text)
  if (!words) return
  const synth = window.speechSynthesis
  // Safari drops a phrase queued right after cancel(): stop what's being read, then speak a moment later
  if (synth.speaking || synth.pending) {
    synth.cancel()
    setTimeout(() => say(agentId, words), 120)
  } else say(agentId, words)
}

/** keeps the phrase being read reachable (Safari stops one that's been garbage-collected, midway) */
let current: SpeechSynthesisUtterance | null = null

function say(agentId: string, words: string) {
  const lang = useDictationLang.getState().lang
  const u = new SpeechSynthesisUtterance(words)
  u.lang = lang
  const voice = voiceFor(lang)
  if (voice) u.voice = voice
  u.rate = 1.05
  u.onend = u.onerror = () => {
    if (current === u) current = null
    if (useSpeech.getState().speaking === agentId) useSpeech.setState({ speaking: null })
  }
  current = u
  useSpeech.setState({ speaking: agentId })
  // a paused engine (Chrome after a long idle, Safari after the tab was hidden) speaks nothing until resumed
  window.speechSynthesis.resume()
  window.speechSynthesis.speak(u)
}

/** The agent's latest answer, in full (the agents' list only has its first line). */
async function latestAnswer(agentId: string) {
  const res = await api(`/api/agents/${agentId}/chat?limit=8`)
  if (!res.ok) return null
  const items = (await res.json()) as ChatItem[]
  const lastUser = items.map((i) => i.kind).lastIndexOf('user')
  const answer = [...items.slice(lastUser + 1)].reverse().find((i) => i.kind === 'assistant')
  return answer?.kind === 'assistant' ? answer.text : null
}


/**
 * Watches for agents finishing a turn (their unread count goes up) and reads the answer when it should be: after the
 * owner talked to them by voice, or always for the manager and the open chat. Mounted once (App).
 */
export function useSpeechWatcher() {
  useEffect(() => {
    if (!speechSupported()) return
    // some browsers load their voices late
    window.speechSynthesis.getVoices()
    let seen: Map<string, number> | null = null
    const unsub = useOffice.subscribe((s) => {
      if (s.source !== 'live') return void (seen = null)
      const now = new Map(s.agents.map((a) => [a.id, a.unread ?? 0]))
      if (seen) {
        const { mode, talkedTo } = useSpeech.getState()
        for (const a of s.agents) {
          const before = seen.get(a.id)
          if (before === undefined || (a.unread ?? 0) <= before || mode === 'off') continue
          const byVoice = Date.now() - (talkedTo[a.id] ?? 0) < ANSWER_WAIT_MS
          const read = byVoice || (mode === 'always' && (a.kind === 'manager' || chatOnScreen(a.id)))
          if (!read) continue
          if (byVoice) useSpeech.setState((st) => ({ talkedTo: { ...st.talkedTo, [a.id]: 0 } }))
          void latestAnswer(a.id).then((text) => {
            console.info(`[voice] reading ${a.name}'s answer`, text ? `(${text.length} chars)` : '(none found)')
            if (text) speak(a.id, text)
          })
        }
      }
      seen = now
    })
    return () => {
      unsub()
      stopSpeaking()
    }
  }, [])
}
