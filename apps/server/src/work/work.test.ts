import { describe, expect, test } from 'bun:test'
import type { CronJob } from '@after-office/shared'
import { dueSlots } from './work'

const cron = (patch: Partial<CronJob> = {}): CronJob => ({
  id: 'c1',
  name: 'Check CI',
  prompt: 'check',
  times: ['09:00', '14:00'],
  days: [1, 2, 3, 4, 5],
  agentId: 'a1',
  enabled: true,
  ...patch,
})

// 2026-09-28 is a Monday. 02:02 UTC = 09:02 in Jakarta (UTC+7).
const monday0902Jakarta = new Date('2026-09-28T02:02:00Z')

describe('cron dueSlots', () => {
  test('fires a slot within the catch-up window, in the office timezone', () => {
    expect(dueSlots(cron(), monday0902Jakarta, 'Asia/Jakarta')).toEqual(['2026-09-28 09:00'])
  })

  test('the same instant is not due in another timezone', () => {
    expect(dueSlots(cron(), monday0902Jakarta, 'UTC')).toEqual([])
  })

  test('does not fire twice', () => {
    expect(dueSlots(cron({ lastRuns: ['2026-09-28 09:00'] }), monday0902Jakarta, 'Asia/Jakarta')).toEqual([])
  })

  test('skips days that are not selected', () => {
    expect(dueSlots(cron({ days: [0, 6] }), monday0902Jakarta, 'Asia/Jakarta')).toEqual([])
  })

  test('ignores slots missed by more than the catch-up window', () => {
    expect(dueSlots(cron({ times: ['08:50'] }), monday0902Jakarta, 'Asia/Jakarta')).toEqual([])
  })

  test('disabled or unassigned jobs never fire', () => {
    expect(dueSlots(cron({ enabled: false }), monday0902Jakarta, 'Asia/Jakarta')).toEqual([])
    expect(dueSlots(cron({ agentId: null }), monday0902Jakarta, 'Asia/Jakarta')).toEqual([])
  })
})
