import { expect, test } from 'bun:test'
import { mergeRateLimits } from './ingest'

// Plan usage: a status line with only the weekly window keeps the 5-hour one until it resets (no flicker to "–").
test('one window at a time keeps the other until its reset', () => {
  const now = Date.parse('2026-09-28T10:00:00Z')
  const s = (t: string) => Date.parse(t) / 1000
  const both = mergeRateLimits(null, { five_hour: { used_percentage: 21, resets_at: s('2026-09-28T12:00:00Z') }, seven_day: { used_percentage: 60, resets_at: s('2026-10-01T00:00:00Z') } }, now)
  expect(both).toEqual({ fiveHourPct: 21, sevenDayPct: 60, fiveHourResetsAt: s('2026-09-28T12:00:00Z'), sevenDayResetsAt: s('2026-10-01T00:00:00Z'), checkedAt: null })
  const weekOnly = mergeRateLimits(both, { seven_day: { used_percentage: 61, resets_at: s('2026-10-01T00:00:00Z') } }, now)
  expect(weekOnly).toMatchObject({ fiveHourPct: 21, sevenDayPct: 61 })
  // after the 5-hour window reset, a missing one really is gone
  const later = mergeRateLimits(both, { seven_day: { used_percentage: 62, resets_at: s('2026-10-01T00:00:00Z') } }, Date.parse('2026-09-28T13:00:00Z'))
  expect(later).toMatchObject({ fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: 62 })
})

// An idle session keeps reporting the usage of its last reply: it must not pull the number back down.
test('an older report never lowers the usage', () => {
  const now = Date.parse('2026-09-28T10:00:00Z')
  const s = (t: string) => Date.parse(t) / 1000
  const five = s('2026-09-28T12:00:00Z')
  const week = s('2026-10-01T00:00:00Z')
  const busy = mergeRateLimits(null, { five_hour: { used_percentage: 3, resets_at: five }, seven_day: { used_percentage: 7, resets_at: week } }, now)
  // the idle one, same windows, older numbers
  const idle = mergeRateLimits(busy, { five_hour: { used_percentage: 2, resets_at: five }, seven_day: { used_percentage: 6, resets_at: week } }, now)
  expect(idle).toMatchObject({ fiveHourPct: 3, sevenDayPct: 7 })
  // an idle one still on the previous 5-hour window: ignored
  const stale = mergeRateLimits(idle, { five_hour: { used_percentage: 40, resets_at: five - 5 * 3600 } }, now)
  expect(stale).toMatchObject({ fiveHourPct: 3, fiveHourResetsAt: five })
  // a new window: starts over, lower is right
  const next = mergeRateLimits(idle, { five_hour: { used_percentage: 1, resets_at: five + 5 * 3600 } }, Date.parse('2026-09-28T12:30:00Z'))
  expect(next).toMatchObject({ fiveHourPct: 1, fiveHourResetsAt: five + 5 * 3600 })
})
