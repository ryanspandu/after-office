import { useEffect } from 'react'
import { create } from 'zustand'
import { useManagerPanel } from '../ui/ManagerPanel'
import { unreadOf, useOffice } from './store'
import { brandTitle } from './branding'

// Tells you when an agent answers, also while its chat is open (where the unread badge clears itself right away):
// a short chime, a toast when that chat isn't the one on screen, and "(2) After Office" in the tab title while the
// tab is in the background. The chime can be switched off (per device) in the Automation modal.

const SOUND_KEY = 'ao-reply-sound'

export const useReplyAlerts = create<{
  sound: boolean
  setSound: (on: boolean) => void
  /** `session`: the side session that answered (unset: the main one) */
  toast: { agentId: string; name: string; at: number; session?: string } | null
  dismiss: () => void
}>((set) => ({
  sound: (() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off'
    } catch {
      return true
    }
  })(),
  setSound: (sound) => {
    try {
      localStorage.setItem(SOUND_KEY, sound ? 'on' : 'off')
    } catch {
      /* private mode: this session only */
    }
    set({ sound })
  },
  toast: null,
  dismiss: () => set({ toast: null }),
}))

let audio: AudioContext | null = null

/** Two soft notes. Browsers only allow sound after the page was interacted with (sending a message counts). */
export function chime() {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    const t0 = audio.currentTime
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = t0 + i * 0.12
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
      osc.connect(gain).connect(audio.destination)
      osc.start(t)
      osc.stop(t + 0.4)
    }
  } catch {
    /* no audio: the toast and title still tell */
  }
}

const TOAST_MS = 6000

/** Is this agent's chat the one on screen? (its profile drawer, or the manager panel for the manager) */
export function chatOnScreen(agentId: string) {
  if (document.visibilityState !== 'visible') return false
  const office = useOffice.getState()
  if (office.profileId === agentId) return true
  const manager = office.agents.find((a) => a.kind === 'manager')
  return !!manager && manager.id === agentId && useManagerPanel.getState().open
}

export function useReplyAlertWatcher() {
  useEffect(() => {
    let seen: Map<string, number> | null = null
    let seenSides: Map<string, Record<string, number>> | null = null
    let hiddenReplies = 0
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const setTitle = () => (document.title = hiddenReplies ? `(${hiddenReplies}) ${brandTitle()}` : brandTitle())

    const unsub = useOffice.subscribe((s) => {
      if (s.source !== 'live') {
        seen = null
        return
      }
      // every chat of an agent counts: its main session and the side sessions
      const now = new Map(s.agents.map((a) => [a.id, unreadOf(a)]))
      // …and which one it was: a side session whose count went up
      const sides = new Map(s.agents.map((a) => [a.id, Object.fromEntries((a.sessions ?? []).map((x) => [x.key, x.unread ?? 0]))]))
      // the first snapshot (and agents appearing later) are the starting point, not news
      if (seen) {
        for (const a of s.agents) {
          const before = seen.get(a.id)
          if (before === undefined || unreadOf(a) <= before) continue
          if (useReplyAlerts.getState().sound) chime()
          if (document.visibilityState !== 'visible') {
            hiddenReplies++
            setTitle()
          }
          if (!chatOnScreen(a.id)) {
            const was = seenSides?.get(a.id) ?? {}
            const session = (a.sessions ?? []).find((x) => x.open && (x.unread ?? 0) > (was[x.key] ?? 0))?.key
            useReplyAlerts.setState({ toast: { agentId: a.id, name: a.name, at: Date.now(), ...(session ? { session } : {}) } })
            clearTimeout(hideTimer)
            hideTimer = setTimeout(() => useReplyAlerts.getState().dismiss(), TOAST_MS)
          }
        }
      }
      seen = now
      seenSides = sides
    })
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !hiddenReplies) return
      hiddenReplies = 0
      setTitle()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      unsub()
      clearTimeout(hideTimer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
