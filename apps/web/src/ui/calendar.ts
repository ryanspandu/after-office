import type { CronJob } from '@after-office/shared'

// The Daily card's Calendar tab (ui/CalendarView.tsx): date math in the office's time zone with plain Intl (a day is
// a "YYYY-MM-DD" key there), a job's runs laid out on days, and the "Add to Google Calendar" / .ics exports. No OAuth
// and nothing for Google to fetch (the dashboard is only on the owner's Tailscale): a prefilled link and a file.

const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** The office-time day `ms` falls on, as "YYYY-MM-DD" (en-CA formats exactly that). */
export function dayKey(ms: number, timezone: string) {
  let f = dayFormats.get(timezone)
  if (!f)
    dayFormats.set(
      timezone,
      (f = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })),
    )
  return f.format(ms)
}

const pad = (n: number) => String(n).padStart(2, '0')
export const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
/** Weekday of a calendar day, 0 = Sunday (the same numbering as CronJob.days). */
export const weekdayOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** How far `timezone`'s clock is ahead of UTC at `ms`. */
function offsetMs(ms: number, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  )
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** The moment it is `hhmm` on `day` in `timezone` (a second pass settles days the offset changes on). */
export function zonedMs(day: string, hhmm: string, timezone: string) {
  const [y, m, d] = day.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, h, mi)
  const first = wall - offsetMs(wall, timezone)
  const second = offsetMs(first, timezone)
  return second === offsetMs(wall, timezone) ? first : wall - second
}

/** The month's days as weeks (Monday first, like the daily job editor); days of the months around it are null. */
export function monthGrid(year: number, month: number) {
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells: (string | null)[] = [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, i) => keyOf(year, month, i + 1))]
  while (cells.length % 7) cells.push(null)
  return cells
}

export interface CronSlot {
  day: string
  time: string
  at: number
  /** it ran (lastRuns has it) */
  ran: boolean
}

/**
 * A job's runs on `days`: days before today show the slots it really ran (lastRuns); today and later the slots its
 * schedule has (an off job, or one without an agent, has none ahead: it won't run on its own).
 */
export function cronSlots(cron: CronJob, days: string[], today: string, timezone: string): CronSlot[] {
  const ran = new Set(cron.lastRuns ?? [])
  const out: CronSlot[] = []
  const scheduled = cron.enabled && !!cron.agentId
  for (const day of days) {
    if (day < today) {
      for (const slot of ran)
        if (slot.startsWith(day + ' '))
          out.push({
            day,
            time: slot.slice(11),
            at: zonedMs(day, slot.slice(11), timezone),
            ran: true,
          })
      continue
    }
    if (!scheduled || !cron.days.includes(weekdayOf(day))) continue
    for (const time of cron.times)
      out.push({
        day,
        time,
        at: zonedMs(day, time, timezone),
        ran: ran.has(`${day} ${time}`),
      })
  }
  return out.sort((a, b) => a.at - b.at)
}

// ── exports to other calendars ──────────────────────────────────────────

export interface CalEvent {
  /** stable, so a second download updates the same event in apps that keep UIDs */
  uid: string
  title: string
  details: string
  start: number
  /** minutes */
  duration?: number
  /** a daily job at one time: repeats on these weekdays (0 = Sunday), in `timezone` */
  repeat?: { days: number[]; time: string; timezone: string }
  /** all day instead (a dated note without a time): its first and last day, "YYYY-MM-DD" (`start` is unused) */
  allDay?: { from: string; to: string }
}

/** "20261021" */
const dateStamp = (day: string) => day.replace(/-/g, '')
/** The day after (all-day events end on it: the end is exclusive). */
function nextDay(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

const DEFAULT_MIN = 30
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
/** "20261021T023000Z" */
const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
/** "20261021T093000": wall time, read in the event's ctz */
const wallStamp = (ms: number, timezone: string) => utcStamp(ms + offsetMs(ms, timezone)).slice(0, -1)

/** Every day: DAILY; some weekdays (weekdays, Mon/Wed/Fri…): WEEKLY on them. */
export function rrule(days: number[]) {
  const set = [...new Set(days)].sort()
  if (!set.length) return null
  return set.length === 7 ? 'RRULE:FREQ=DAILY' : `RRULE:FREQ=WEEKLY;BYDAY=${set.map((d) => BYDAY[d]).join(',')}`
}

/**
 * Google Calendar's "new event" page, filled in. A one-off event in UTC; a repeating one in the office's wall time
 * with its zone (ctz), so the weekdays it repeats on are the office's (in UTC, an early run lands on the day before).
 */
export function googleCalendarUrl(ev: CalEvent) {
  const end = ev.start + (ev.duration ?? DEFAULT_MIN) * 60_000
  const rule = ev.repeat && rrule(ev.repeat.days)
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    details: ev.details,
  })
  if (ev.allDay) p.set('dates', `${dateStamp(ev.allDay.from)}/${dateStamp(nextDay(ev.allDay.to))}`)
  else if (ev.repeat && rule) {
    p.set('dates', `${wallStamp(ev.start, ev.repeat.timezone)}/${wallStamp(end, ev.repeat.timezone)}`)
    p.set('ctz', ev.repeat.timezone)
    p.set('recur', rule)
  } else p.set('dates', `${utcStamp(ev.start)}/${utcStamp(end)}`)
  return `https://calendar.google.com/calendar/render?${p.toString()}`
}

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Lines of at most 75 bytes, continued with a leading space (RFC 5545), never splitting a character. */
function fold(line: string) {
  const enc = new TextEncoder()
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

/** One event as an iCalendar file (in UTC, or whole days), with a reminder 15 minutes before (all day: before it starts). */
export function icsFile(ev: CalEvent, now = Date.now()) {
  const end = ev.start + (ev.duration ?? DEFAULT_MIN) * 60_000
  const span = ev.allDay
    ? [`DTSTART;VALUE=DATE:${dateStamp(ev.allDay.from)}`, `DTEND;VALUE=DATE:${dateStamp(nextDay(ev.allDay.to))}`]
    : [`DTSTART:${utcStamp(ev.start)}`, `DTEND:${utcStamp(end)}`]
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//After Office//Dashboard//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.uid}@after-office`,
    `DTSTAMP:${utcStamp(now)}`,
    ...span,
    `SUMMARY:${icsText(ev.title)}`,
    `DESCRIPTION:${icsText(ev.details)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(ev.title)}`,
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n')
    .concat('\r\n')
}

export function downloadIcs(ev: CalEvent) {
  const blob = new Blob([icsFile(ev)], { type: 'text/calendar;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${
    ev.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'event'
  }.ics`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
