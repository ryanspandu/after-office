// One way to show a moment everywhere: "28 Sep, 13:03", with the year only when it isn't this one ("28 Dec 2025,
// 09:10"). Built from parts: browsers word the full format differently ("28 Sep at 13:03", "28 Sept, 13:03").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Date and time of `ms`, in `timeZone` (the office's, for deadlines) or this device's. */
export function dateTime(ms: number, timeZone?: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  )
  const thisYear = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric' }).format(Date.now())
  const year = parts.year === thisYear ? '' : ` ${parts.year}`
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}${year}, ${parts.hour}:${parts.minute}`
}

/** A chat message's time: "14:22" today, else with its date ("3 Oct, 14:22"). */
export function chatTime(ms: number, timeZone?: string) {
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
  if (day(ms) !== day(Date.now())) return dateTime(ms, timeZone)
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
}

/** The wall-clock parts of `ms` in `timeZone`. */
function partsIn(ms: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  )
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute }
}

/** The moment a wall-clock time in `timeZone` is (DST-safe enough: corrected once by the zone's offset then). */
function zonedMs(y: number, mo: number, d: number, h: number, mi: number, timeZone: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const p = partsIn(guess, timeZone)
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess
  return guess - offset
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// Claude Code's limit notices: "resets 12:50pm (Europe/Berlin)", "resets 5pm (Europe/Berlin)", "resets Oct 9, 5pm (…)"
const RESETS = /\bresets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\)/gi

/**
 * A plan-limit notice's reset time in the office's timezone instead of the server's ("resets 12:50pm (Europe/Berlin)"
 * → "resets 17:50 (Asia/Jakarta)"). `at`: when the notice was written (the reset is the next such time after it).
 */
export function localizeResets(text: string, timeZone: string, at: number) {
  if (!/resets/i.test(text)) return text
  return text.replace(RESETS, (all, mon: string | undefined, day: string | undefined, hh: string, mm: string | undefined, ampm: string, zone: string) => {
    try {
      let h = Number(hh) % 12
      if (ampm.toLowerCase() === 'pm') h += 12
      const mi = Number(mm ?? 0)
      const base = partsIn(at, zone)
      let ms: number
      if (mon && day) {
        const mo = MONTH_NAMES.indexOf(mon.toLowerCase()) + 1
        if (!mo) return all
        ms = zonedMs(base.y, mo, Number(day), h, mi, zone)
        // a date early next year
        if (ms < at - 86_400_000) ms = zonedMs(base.y + 1, mo, Number(day), h, mi, zone)
      } else {
        ms = zonedMs(base.y, base.mo, base.d, h, mi, zone)
        // a time already past on that day: the next day's
        if (ms < at - 60_000) ms += 86_400_000
      }
      if (!Number.isFinite(ms)) return all
      const sameDay = partsIn(ms, timeZone).d === partsIn(at, timeZone).d && ms - at < 86_400_000
      const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
      return `resets ${sameDay ? time : dateTime(ms, timeZone)} (${timeZone})`
    } catch {
      // an unknown zone: as it was
      return all
    }
  })
}
