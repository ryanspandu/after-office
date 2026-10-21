import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DayPicker } from 'react-day-picker'
import 'react-day-picker/style.css'
import { LuCalendarDays, LuClock, LuX } from 'react-icons/lu'
import type { OwnerNoteSummary } from '@after-office/shared'
import { ymd } from '../state/dashboard'
import { placePopover } from '../state/placePopover'
import { usePresence } from '../state/usePresence'
import { TimeField } from './pickers'

// A note's optional day on the calendar (ui/CalendarView.tsx): one day, maybe at a time, or a range of days. Picked
// in a small popover with the navbar range picker's calendar (react-day-picker, styles/navbar.css .range-pop); each
// pick saves at once, like the note's folder and tags.

export type NoteWhen = Pick<OwnerNoteSummary, 'date' | 'dateEnd' | 'time'>
/** what changes: null clears a field */
export type NoteWhenPatch = {
  date?: string | null
  dateEnd?: string | null
  time?: string | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "21 Oct", "21 Oct, 14:00", "21–24 Oct", "30 Oct – 2 Nov" (the year only when it isn't this one). */
export function noteWhenLabel(n: NoteWhen) {
  if (!n.date) return ''
  const thisYear = String(new Date().getFullYear())
  const [y, m, d] = n.date.split('-')
  const year = (yy: string) => (yy === thisYear ? '' : ` ${yy}`)
  if (n.dateEnd) {
    const [y2, m2, d2] = n.dateEnd.split('-')
    if (y === y2 && m === m2) return `${Number(d)}–${Number(d2)} ${MONTHS[Number(m) - 1]}${year(y)}`
    return `${Number(d)} ${MONTHS[Number(m) - 1]}${y === y2 ? '' : year(y)} – ${Number(d2)} ${MONTHS[Number(m2) - 1]}${year(y2)}`
  }
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${year(y)}${n.time ? `, ${n.time}` : ''}`
}

export function NoteDateButton({ value, onChange }: { value: NoteWhen; onChange: (patch: NoteWhenPatch) => void }) {
  const [open, setOpen] = useState(false)
  const presence = usePresence(open, 140)
  const [pos, setPos] = useState<{
    top: number
    left: number
    transformOrigin?: string
  }>({ top: 0, left: 0 })
  // a range opens on Range; picking one is two taps (its first day waits here for the second)
  const [mode, setMode] = useState<'day' | 'range'>(value.dateEnd ? 'range' : 'day')
  const [start, setStart] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !presence.mounted || !button.current) return
    setPos(placePopover(button.current, pop.current))
  }, [open, presence.mounted, mode])

  useEffect(() => {
    if (!open) return
    setMode(value.dateEnd ? 'range' : 'day')
    setStart(null)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // the time field's own popup lives in a portal of its own (ui/pickers.tsx)
      if (!pop.current?.contains(t) && !button.current?.contains(t) && !t.closest?.('.dp-popper, #dp-portal')) setOpen(false)
    }
    // Esc closes this, not the note's window under it
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pickDay = (day: Date) => {
    const key = ymd(day)
    if (mode === 'day') return onChange({ date: key, dateEnd: null })
    if (!start) return setStart(key)
    const [from, to] = start <= key ? [start, key] : [key, start]
    setStart(null)
    onChange({ date: from, dateEnd: from === to ? null : to, time: null })
  }

  const selected = value.date ? parse(value.date) : undefined
  const range = start ? { from: parse(start), to: undefined } : value.date ? { from: parse(value.date), to: parse(value.dateEnd ?? value.date) } : undefined
  const label = noteWhenLabel(value)

  return (
    <>
      <span className="chat-ctx__project note-date">
        <button
          ref={button}
          type="button"
          className="chat-ctx__pick"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-tip={label ? 'Its day on the calendar' : 'Put it on the calendar'}
        >
          <LuCalendarDays className="note-row__folder" />
          {label ? <span className="truncate">{label}</span> : <span className="muted">Date…</span>}
        </button>
        {value.date && (
          <button type="button" className="chat-ctx__unpick" aria-label="No date" onClick={() => onChange({ date: null })}>
            <LuX />
          </button>
        )}
      </span>
      {presence.mounted &&
        createPortal(
          <div
            ref={pop}
            className={`popover range-pop note-date-pop${presence.closing ? ' popover--closing' : ''}`}
            style={pos}
            role="dialog"
            aria-label="The note's date"
          >
            <div className="seg note-date-pop__mode" role="tablist" aria-label="One day or a range">
              <button role="tab" aria-selected={mode === 'day'} className={mode === 'day' ? 'active' : ''} onClick={() => (setMode('day'), setStart(null))}>
                One day
              </button>
              <button role="tab" aria-selected={mode === 'range'} className={mode === 'range' ? 'active' : ''} onClick={() => setMode('range')}>
                Range
              </button>
            </div>
            {mode === 'day' ? (
              <DayPicker mode="single" selected={selected} onSelect={(_, day) => pickDay(day)} defaultMonth={selected ?? new Date()} weekStartsOn={1} />
            ) : (
              <DayPicker mode="range" selected={range} onSelect={(_, day) => pickDay(day)} defaultMonth={range?.from ?? new Date()} weekStartsOn={1} />
            )}
            <div className="range-pop__foot note-date-pop__foot">
              {mode === 'range' ? (
                <span className="muted">{start ? 'Now its last day' : 'Tap its first day, then its last'}</span>
              ) : value.date && !value.dateEnd && value.time ? (
                <span className="note-date-pop__time">
                  <TimeField size="sm" value={value.time} onChange={(time) => onChange({ time })} ariaLabel="Time" />
                  <button type="button" className="icon-btn small ghost" data-tip="All day" aria-label="All day" onClick={() => onChange({ time: null })}>
                    <LuX />
                  </button>
                </span>
              ) : (
                <button className="small" disabled={!value.date || !!value.dateEnd} onClick={() => onChange({ time: '09:00' })}>
                  <LuClock /> Add a time
                </button>
              )}
              <button className="small primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
