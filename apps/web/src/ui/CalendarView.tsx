import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  LuCalendarClock,
  LuCalendarDays,
  LuCalendarPlus,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuDownload,
  LuEllipsis,
  LuListTodo,
  LuNotebookPen,
  LuPlus,
  LuRepeat,
  LuUser,
} from 'react-icons/lu'
import type { OfficeTask } from '@after-office/shared'
import { useBranding } from '../state/branding'
import { useClock, useNow, zonedParts } from '../state/clock'
import { describeDays } from '../state/cronRunner'
import { useDashboard } from '../state/dashboard'
import { useLive } from '../state/live'
import { useOffice } from '../state/store'
import { placePopover } from '../state/placePopover'
import { openNewEvent, useCalendarDay } from './NewEvent'
import { openUrl } from '../state/url'
import { ActionMenu, type MenuAction } from './ActionMenu'
import { cronSlots, dayKey, downloadIcs, googleCalendarUrl, monthGrid, zonedMs, type CalEvent } from './calendar'
import { noteWhenLabel } from './NoteDate'
import { statusDefOf, useStatuses } from './taskMeta'
import { tip } from './Tooltip'
import { useModalMaximize } from './Maximize'
import { Modal } from './Modal'

// The Daily card's Calendar tab (also the phones' round Calendar button on the stage, ui/MobileDock.tsx CalendarFab):
// a month in the office's time zone, each day with a dot per kind of thing on it: tasks due (the owner's own too),
// daily job runs (what ran on past days, what's scheduled from today on) and dated notes (ui/NoteDate.tsx, events too):
// only what's planned for a day, not what happened on it (reports, threads). Big (?calendar=1, CalendarModal): the days show their items' names.
// A tap on a day lists it under the grid; a row opens what it is (state/url.ts). Rows with a time can go to another
// calendar: Google Calendar's prefilled page or an .ics file (ui/calendar.ts).

type Kind = 'task' | 'daily' | 'note'
interface Item {
  id: string
  kind: Kind
  day: string
  at: number
  title: string
  meta: string
  /** no time of day (a dated note): "All day" instead of a time */
  allDay?: boolean
  /** finished / already ran / off: drawn dimmed */
  dim?: boolean
  overdue?: boolean
  mine?: boolean
  open: Record<string, string>
  /** a time worth putting in a calendar */
  event?: CalEvent
  /** a daily job: the same, repeating on its weekdays */
  repeat?: CalEvent
}

const KIND_ICON: Record<Kind, ReactNode> = {
  task: <LuListTodo />,
  daily: <LuCalendarClock />,
  note: <LuNotebookPen />,
}
/** names a day shows in the big view (the last line becomes "+N more" when there are more) */
const BIG_NAMES = 4
const WEEK_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''))

/** Everything in the dashboard with a day in this month (office time). */
function useMonthItems(year: number, month: number, today: string, now: number): Item[] {
  const timezone = useClock((s) => s.timezone)
  const tasks = useDashboard((s) => s.tasks)
  const crons = useDashboard((s) => s.crons)
  const notes = useLive((s) => s.notes)
  const agents = useOffice((s) => s.agents)
  const statuses = useStatuses()
  const brand = useBranding((s) => s.name)
  // the day's turn is enough to move "ran" / "overdue" along
  const minute = Math.floor(now / 60_000)

  return useMemo(() => {
    const prefix = `${year}-${String(month).padStart(2, '0')}-`
    const inMonth = (day: string) => day.startsWith(prefix)
    const agentName = (id: string | null | undefined) => agents.find((a) => a.id === id)?.name
    const items: Item[] = []
    const days = monthGrid(year, month).filter((d): d is string => !!d)

    const taskWho = (t: OfficeTask) => (t.forOwner ? 'You' : (agentName(t.agentId) ?? 'Unassigned'))
    for (const t of tasks) {
      const day = dayKey(t.deadline, timezone)
      if (!inMonth(day)) continue
      const done = t.status === 'done'
      const status = statusDefOf(t, statuses).label
      const event: CalEvent = {
        uid: `task-${t.id}`,
        title: `Due: ${t.title}`,
        details: [`Task deadline in ${brand} · ${status} · ${taskWho(t)}`, clip(t.description, 400)].filter(Boolean).join('\n\n'),
        start: t.deadline,
      }
      items.push({
        id: `t:${t.id}`,
        kind: 'task',
        day,
        at: t.deadline,
        title: t.title,
        meta: `${status} · ${taskWho(t)}`,
        dim: done,
        overdue: !done && t.deadline < minute * 60_000,
        mine: t.forOwner,
        open: { task: t.id },
        event: done ? undefined : event,
      })
    }

    for (const c of crons) {
      const who = agentName(c.agentId)
      for (const slot of cronSlots(c, days, today, timezone)) {
        const details = [`Daily job in ${brand} · ${describeDays(c.days)} at ${slot.time} (${timezone}) · ${who ?? 'No agent'}`, clip(c.prompt, 400)].join(
          '\n\n',
        )
        const event: CalEvent = {
          uid: `daily-${c.id}-${slot.day}-${slot.time.replace(':', '')}`,
          title: c.name,
          details,
          start: slot.at,
        }
        const ahead = slot.at > minute * 60_000
        items.push({
          id: `d:${c.id}:${slot.day}:${slot.time}`,
          kind: 'daily',
          day: slot.day,
          at: slot.at,
          title: c.name,
          meta: slot.ran ? `Ran · ${who ?? 'No agent'}` : ahead ? `${describeDays(c.days)} · ${who ?? 'No agent'}` : 'Missed',
          dim: !ahead,
          open: { daily: c.id },
          event: ahead ? event : undefined,
          repeat: ahead
            ? {
                ...event,
                uid: `daily-${c.id}-${slot.time.replace(':', '')}`,
                repeat: { days: c.days, time: slot.time, timezone },
              }
            : undefined,
        })
      }
    }

    // dated notes: on their day, or on each day of their range (undated ones aren't on the calendar)
    for (const n of notes) {
      if (!n.date) continue
      const last = n.dateEnd ?? n.date
      const span = n.dateEnd ? ` · ${noteWhenLabel(n)}` : ''
      const details = [`Note in ${brand}${n.dateEnd ? ` · ${noteWhenLabel(n)}` : ''}`, clip(n.excerpt, 400)].filter(Boolean).join('\n\n')
      const title = n.title || 'Untitled note'
      for (const day of days) {
        if (day < n.date || day > last) continue
        // with a time: that moment in office time; all day: the day's start (sorted first)
        const at = n.time ? zonedMs(day, n.time, timezone) : zonedMs(day, '00:00', timezone)
        const event: CalEvent = n.time
          ? { uid: `note-${n.id}`, title, details, start: at }
          : {
              uid: `note-${n.id}`,
              title,
              details,
              start: at,
              allDay: { from: n.date, to: last },
            }
        items.push({
          id: `n:${n.id}:${day}`,
          kind: 'note',
          day,
          at,
          allDay: !n.time,
          title,
          meta: `Note${span}`,
          open: { note: n.id },
          event,
        })
      }
    }
    return items
  }, [year, month, today, minute, timezone, tasks, crons, notes, agents, statuses, brand])
}

/**
 * `big`: the calendar's own window (?calendar=1): days with their items' names, the day's list beside the month.
 * `dayPopup`: the Daily card (too short for a list under the month): a day's list opens in a small window when it's
 * clicked.
 */
export function CalendarView({ big = false, withAdd = false, dayPopup = false }: { big?: boolean; withAdd?: boolean; dayPopup?: boolean } = {}) {
  const timezone = useClock((s) => s.timezone)
  const now = useNow(60_000)
  const today = zonedParts(now, timezone).date
  const [ty, tm] = today.split('-').map(Number)
  const [view, setView] = useState({ year: ty, month: tm })
  const [picked, setPicked] = useState(today)
  // the card: the clicked day's list in its window
  const [popup, setPopup] = useState(false)
  // the "+" outside it (the card's header, the big window's) starts a new event on this day
  useEffect(() => useCalendarDay.setState({ day: picked }), [picked])
  const items = useMonthItems(view.year, view.month, today, now.getTime())

  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>()
    for (const it of items) map.set(it.day, [...(map.get(it.day) ?? []), it])
    return map
  }, [items])

  const step = (by: 1 | -1) =>
    setView(({ year, month }) => {
      const m = month + by
      return m < 1 ? { year: year - 1, month: 12 } : m > 12 ? { year: year + 1, month: 1 } : { year, month: m }
    })
  const goToday = () => (setView({ year: ty, month: tm }), setPicked(today))

  const dayItems = (byDay.get(picked) ?? []).slice().sort((a, b) => a.at - b.at)
  const [py, pm, pd] = picked.split('-').map(Number)
  const pickedLabel = new Date(Date.UTC(py, pm - 1, pd)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const onThisMonth = view.year === ty && view.month === tm

  // the picked day's list: under (or beside) the month, or in its own small window (the card)
  const agenda = (
    <div className="cal__agenda">
      <div className="cal__agenda-head">
        <span>{picked === today ? `Today · ${pickedLabel}` : pickedLabel}</span>
        <span className="muted">{dayItems.length ? `${dayItems.length} item${dayItems.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {!dayItems.length && (
        <div className="cal__empty">
          <span className="cal__empty-icon" aria-hidden>
            <LuCalendarDays />
          </span>
          <b>Nothing on this day</b>
          <span className="muted">No tasks, daily jobs or events.</span>
          <button type="button" className="small primary" onClick={() => openNewEvent(picked)}>
            <LuPlus /> Add event
          </button>
        </div>
      )}
      {dayItems.length > 0 && (
        <ul className="list cal__list">
          {dayItems.map((it) => (
            <AgendaRow key={it.id} item={it} timezone={timezone} />
          ))}
        </ul>
      )}
      {/* a day with things on it: one more, from the bottom of the list (an empty day has its own button) */}
      {dayItems.length > 0 && (
        <div className="cal__agenda-foot">
          <button type="button" className="small primary cal__agenda-add" onClick={() => openNewEvent(picked)}>
            <LuPlus /> Add event
          </button>
        </div>
      )}
    </div>
  )

  const byOrder = (a: Item, b: Item) => a.at - b.at

  return (
    <div className={`cal${big ? ' cal--big' : ''}`}>
      <div className="cal__layout">
        <div className="cal__pane">
          <div className="cal__bar">
            <button className="icon-btn small" {...tip('Previous month')} onClick={() => step(-1)}>
              <LuChevronLeft />
            </button>
            <MonthPicker year={view.year} month={view.month} thisYear={ty} thisMonth={tm} onPick={(year, month) => setView({ year, month })} />
            <button className="icon-btn small" {...tip('Next month')} onClick={() => step(1)}>
              <LuChevronRight />
            </button>
            <span className="grow" />
            <button className="small" disabled={onThisMonth && picked === today} onClick={goToday}>
              Today
            </button>
            {/* the phones' sheet has no header of its own to put it in */}
            {withAdd && (
              <button className="icon-btn small" {...tip('New event')} onClick={() => openNewEvent(picked)}>
                <LuPlus />
              </button>
            )}
          </div>

          <div className="cal__grid" role="grid" aria-label={`${MONTH_NAMES[view.month - 1]} ${view.year}`}>
            {WEEK_HEAD.map((d) => (
              <span key={d} className="cal__wd" aria-hidden>
                {d.slice(0, 2)}
              </span>
            ))}
            {monthGrid(view.year, view.month).map((day, i) => {
              if (!day) return <span key={`x${i}`} className="cal__day cal__day--blank" />
              const list = byDay.get(day) ?? []
              const tasks = list.filter((x) => x.kind === 'task')
              const open = tasks.filter((x) => !x.dim)
              const runs = list.filter((x) => x.kind === 'daily').length
              const notes = list.filter((x) => x.kind === 'note').length
              const other = list.length - tasks.length - runs - notes
              const label = [
                tasks.length && `${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
                runs && `${runs} run${runs === 1 ? '' : 's'}`,
                notes && `${notes} note${notes === 1 ? '' : 's'}`,
                other && `${other} more`,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <button
                  key={day}
                  role="gridcell"
                  aria-selected={day === picked}
                  aria-label={`${Number(day.slice(8))}${label ? `, ${label}` : ''}`}
                  className={`cal__day${day === today ? ' is-today' : ''}${day === picked ? ' is-picked' : ''}${day < today ? ' is-past' : ''}`}
                  onClick={() => (setPicked(day), dayPopup && setPopup(true))}
                >
                  <span className="cal__num">{Number(day.slice(8))}</span>
                  {list.length > 0 && (
                    <span className="cal__dots">
                      {tasks.length > 0 && (
                        <i className={`cal__dot cal__dot--task${open.some((x) => x.overdue) ? ' is-overdue' : open.length ? '' : ' is-done'}`} />
                      )}
                      {runs > 0 && <i className="cal__dot cal__dot--daily" />}
                      {notes > 0 && <i className="cal__dot cal__dot--note" />}
                      {other > 0 && <i className="cal__dot cal__dot--other" />}
                      {/* wide enough (the dock sheets, a wide column): how many in all */}
                      <span className="cal__count">{list.length}</span>
                    </span>
                  )}
                  {/* the big view: the first few by name, then how many more */}
                  {big && list.length > 0 && (
                    <span className="cal__names">
                      {[...list]
                        .sort(byOrder)
                        .slice(0, list.length > BIG_NAMES ? BIG_NAMES - 1 : BIG_NAMES)
                        .map((x) => (
                          <span key={x.id} className={`cal__name cal__name--${x.kind}${x.dim ? ' is-dim' : ''}${x.overdue ? ' is-overdue' : ''}`}>
                            {!x.allDay && <b>{zonedParts(new Date(x.at), timezone).hhmm}</b>}
                            <span className="cal__name-text">{x.title}</span>
                          </span>
                        ))}
                      {list.length > BIG_NAMES && <span className="cal__name cal__name--more">+{list.length - BIG_NAMES + 1} more</span>}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {!dayPopup && agenda}
      </div>
      {dayPopup && popup && (
        <Modal open onClose={() => setPopup(false)} title={picked === today ? `Today · ${pickedLabel}` : pickedLabel} width={440}>
          <div className="modal__body cal cal--popup">{agenda}</div>
        </Modal>
      )}
    </div>
  )
}

function AgendaRow({ item, timezone }: { item: Item; timezone: string }) {
  const [menu, setMenu] = useState<{
    x: number
    y: number
    above: number
    width?: number
  } | null>(null)
  const time = zonedParts(new Date(item.at), timezone).hhmm
  const actions: MenuAction[] = []
  if (item.repeat)
    actions.push({
      icon: <LuRepeat />,
      label: `Add to Google Calendar (repeats ${describeDays(item.repeat.repeat!.days).toLowerCase()})`,
      run: () => openGoogle(item.repeat!),
    })
  if (item.event) {
    actions.push({
      icon: <LuCalendarPlus />,
      label: item.repeat ? 'Add this run to Google Calendar' : 'Add to Google Calendar',
      run: () => openGoogle(item.event!),
    })
    actions.push({
      icon: <LuDownload />,
      label: 'Download .ics',
      run: () => downloadIcs(item.event!),
    })
  }
  return (
    <li className={`cal-row cal-row--${item.kind}${item.dim ? ' is-dim' : ''}`}>
      <button className="cal-row__main" onClick={() => openUrl(item.open)} {...tip(item.title)}>
        <span className={`cal-row__time${item.overdue ? ' is-overdue' : ''}${item.allDay ? ' is-all-day' : ''}`}>{item.allDay ? 'All day' : time}</span>
        <span className="cal-row__icon" aria-hidden>
          {KIND_ICON[item.kind]}
        </span>
        <span className="cal-row__text">
          <span className="cal-row__title truncate">{item.title}</span>
          <span className="cal-row__meta truncate">
            {item.mine && <LuUser aria-label="Your own task" />}
            {item.kind === 'task' && item.overdue && <span className="due--overdue">Overdue · </span>}
            {item.meta}
          </span>
        </span>
      </button>
      {actions.length > 0 && (
        <button
          type="button"
          className="icon-btn small ghost cal-row__more"
          aria-expanded={!!menu}
          {...tip('Add to calendar')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            // as wide as the agenda it opens in, lined up with it
            const col = e.currentTarget.closest('.cal__agenda')?.getBoundingClientRect()
            setMenu(menu ? null : { x: col ? col.right : r.right, y: r.bottom + 4, above: r.top - 4, width: col?.width })
          }}
        >
          <LuEllipsis />
        </button>
      )}
      {menu && <ActionMenu x={menu.x} y={menu.y} above={menu.above} width={menu.width} title={item.title} actions={actions} onClose={() => setMenu(null)} />}
    </li>
  )
}

const openGoogle = (ev: CalEvent) => window.open(googleCalendarUrl(ev), '_blank', 'noopener,noreferrer')

/** The Calendar on its own, as a card (the phones' Calendar sheet). */
export function CalendarCard() {
  return (
    <section className="card card--grow cal-card">
      <CalendarView withAdd />
    </section>
  )
}

/** The calendar in a big window of its own (?calendar=1, ui/UrlModals.tsx), with its own full size. */
export function CalendarModal({ onClose }: { onClose: () => void }) {
  const max = useModalMaximize(1000, 'after-office:calendar-max')
  return (
    <Modal
      open
      onClose={onClose}
      title="Calendar"
      {...max.modalProps}
      actions={
        <>
          <button className="icon-btn small ghost" {...tip('New event')} onClick={() => openNewEvent()}>
            <LuPlus />
          </button>
          {max.modalProps.actions}
        </>
      }
    >
      <div className="modal__body cal-modal" ref={max.bodyRef}>
        <CalendarView big />
      </div>
    </Modal>
  )
}

/** The month's name in the bar: a tap opens a year (‹ 2026 ›) and its twelve months, to jump to one. */
function MonthPicker({
  year,
  month,
  thisYear,
  thisMonth,
  onPick,
}: {
  year: number
  month: number
  thisYear: number
  thisMonth: number
  onPick: (year: number, month: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [shownYear, setShownYear] = useState(year)
  const [pos, setPos] = useState<{ top: number; left: number; transformOrigin?: string }>({ top: 0, left: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (open && button.current) setPos(placePopover(button.current, pop.current))
  }, [open])
  useEffect(() => {
    if (!open) return
    setShownYear(year)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    // Esc closes this, not the window under it
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <>
      <button ref={button} type="button" className="cal__month" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {MONTH_NAMES[month - 1]} <span className="cal__year">{year}</span>
        <LuChevronDown />
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="popover ui-pop cal-mp" style={pos} role="dialog" aria-label="Go to a month">
            <div className="cal-mp__year">
              <button className="icon-btn small" {...tip('Previous year')} onClick={() => setShownYear((y) => y - 1)}>
                <LuChevronLeft />
              </button>
              <b>{shownYear}</b>
              <button className="icon-btn small" {...tip('Next year')} onClick={() => setShownYear((y) => y + 1)}>
                <LuChevronRight />
              </button>
            </div>
            <div className="cal-mp__months">
              {MONTH_NAMES.map((name, i) => (
                <button
                  key={name}
                  className={`${shownYear === year && i + 1 === month ? 'active' : ''}${shownYear === thisYear && i + 1 === thisMonth ? ' is-now' : ''}`}
                  aria-current={shownYear === thisYear && i + 1 === thisMonth ? 'date' : undefined}
                  onClick={() => (onPick(shownYear, i + 1), setOpen(false))}
                >
                  {name.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
