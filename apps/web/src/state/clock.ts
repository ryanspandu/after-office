import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { create } from 'zustand'
import { api } from './auth'
import { useOffice } from './store'

// Office time: everything time-based (navbar clock, day/night lighting, cron schedule) uses this timezone.

/** Current UTC offset of a zone, e.g. "UTC+7" / "UTC-3:30". */
export function utcOffset(timezone: string, date = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value
  return name === 'GMT' || !name ? 'UTC' : name.replace('GMT', 'UTC')
}

function offsetMinutes(label: string) {
  const m = label.match(/UTC([+-])(\d+)(?::(\d+))?/)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}

/** Every IANA zone the browser knows, labelled "Jakarta · Asia · UTC+7", sorted by offset. */
export const TIMEZONES: { tz: string; label: string }[] = (() => {
  const zones: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Jakarta', 'UTC']
  const list = (zones.includes('UTC') ? zones : [...zones, 'UTC']).map((tz) => {
    const parts = tz.split('/')
    const city = parts[parts.length - 1].replace(/_/g, ' ')
    const region = parts.length > 1 ? parts[0] : ''
    const offset = utcOffset(tz)
    return { tz, label: [city, region, offset].filter(Boolean).join(' · '), minutes: offsetMinutes(offset) }
  })
  return list.sort((a, b) => a.minutes - b.minutes || a.label.localeCompare(b.label)).map(({ tz, label }) => ({ tz, label }))
})()

export type ThemeMode = 'auto' | 'day' | 'night'

const STORAGE_KEY = 'after-office:clock'

function load(): { timezone: string; mode: ThemeMode } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { timezone: 'Asia/Jakarta', mode: 'auto', ...JSON.parse(raw) }
  } catch {
    // storage unavailable: fall back to defaults
  }
  return { timezone: 'Asia/Jakarta', mode: 'auto' }
}

interface ClockStore {
  timezone: string
  mode: ThemeMode
  setTimezone: (tz: string) => void
  setMode: (mode: ThemeMode) => void
  /** The server's office timezone arrived: take it (and remember it) without sending it back. */
  syncTimezone: (tz: string) => void
}

export const useClock = create<ClockStore>((set, get) => {
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ timezone: get().timezone, mode: get().mode }))
    } catch {
      // ignore
    }
  }
  return {
    ...load(),
    setTimezone: (timezone) => {
      set({ timezone })
      save()
      // in live mode the office timezone is server-side too (cron schedules run in it)
      if (useOffice.getState().source === 'live')
        void api('/api/settings', { method: 'PUT', body: JSON.stringify({ timezone }) }).catch(() => {})
    },
    setMode: (mode) => (set({ mode }), save()),
    syncTimezone: (timezone) => {
      if (timezone === get().timezone) return
      set({ timezone })
      save()
    },
  }
})

/** Wall-clock parts of `date` in `timezone`. */
export function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
    hhmm: `${get('hour')}:${get('minute')}`,
  }
}

/**
 * 1 = full day, 0 = full night. Dawn ramps 05:00→07:00, dusk 17:00→19:00.
 * `mode` lets you force day or night regardless of the clock.
 */
export function daylightAt(date: Date, timezone: string, mode: ThemeMode) {
  if (mode === 'day') return 1
  if (mode === 'night') return 0
  const { hour, minute } = zonedParts(date, timezone)
  const h = hour + minute / 60
  if (h < 5 || h >= 19) return 0
  if (h < 7) return (h - 5) / 2
  if (h < 17) return 1
  return 1 - (h - 17) / 2
}

/** Re-renders every `ms`. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Current daylight (0..1), updated every 30 s. */
export function useDaylight() {
  const { timezone, mode } = useClock(useShallow((s) => ({ timezone: s.timezone, mode: s.mode })))
  const now = useNow(30_000)
  return daylightAt(now, timezone, mode)
}
