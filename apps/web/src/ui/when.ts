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
