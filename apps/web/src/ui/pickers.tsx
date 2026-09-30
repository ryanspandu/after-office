import { useEffect, useRef, useState, type ReactNode } from 'react'
import DatePicker, { CalendarContainer } from 'react-datepicker'
import 'react-datepicker/dist/react-datepicker.css'
import { LuCalendar, LuClock } from 'react-icons/lu'

// Time and date-time fields built on react-datepicker, restyled with the app tokens in styles/pickers.css (.dp-*).
// Popups render into a body-level portal so modals and cards with overflow don't clip them.
// The time part is our own hour + minute columns, so any minute can be picked (the library's list is fixed steps);
// the input also accepts typed times like 07:37.

const PORTAL = 'dp-portal'

const toDate = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h || 0, m || 0, 0, 0)
  return d
}
const toHHMM = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const pad = (n: number) => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

/** One scrolling column of numbers; keeps the selected one in view without scrolling the page. */
function Column({ label, values, selected, onPick }: { label: string; values: number[]; selected: number; onPick: (n: number) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = list.current
    const item = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (el && item) el.scrollTo({ top: item.offsetTop - el.clientHeight / 2 + item.offsetHeight / 2 })
  }, [selected])
  return (
    <div className="tp__col" role="listbox" aria-label={label} ref={list}>
      {values.map((n) => (
        <button type="button" key={n} role="option" aria-selected={n === selected} className={`tp__item${n === selected ? ' tp__item--on' : ''}`} onClick={() => onPick(n)}>
          {pad(n)}
        </button>
      ))}
    </div>
  )
}

function TimeColumns({ date, onChange }: { date: Date; onChange: (d: Date) => void }) {
  const set = (h: number, m: number) => {
    const d = new Date(date)
    d.setHours(h, m, 0, 0)
    onChange(d)
  }
  return (
    <div className="tp">
      <div className="tp__head">
        Time <span className="tp__value">{toHHMM(date)}</span>
      </div>
      <div className="tp__cols">
        <Column label="Hour" values={HOURS} selected={date.getHours()} onPick={(h) => set(h, date.getMinutes())} />
        <Column label="Minute" values={MINUTES} selected={date.getMinutes()} onPick={(m) => set(date.getHours(), m)} />
      </div>
    </div>
  )
}

type ContainerProps = { className?: string; children?: ReactNode }

/** A calendarContainer with a stable identity (an inline one would remount the popup on every change and lose the
 *  columns' scroll position). It reads the latest value and handler from a ref on each render. */
function useTimeContainer(date: Date, onPick: (d: Date) => void, withCalendar: boolean) {
  const latest = useRef({ date, onPick })
  latest.current = { date, onPick }
  const [Container] = useState(() => ({ className, children }: ContainerProps) => (
    <CalendarContainer className={className}>
      {withCalendar && <div className="dp__month">{children}</div>}
      <TimeColumns date={latest.current.date} onChange={(d) => latest.current.onPick(d)} />
    </CalendarContainer>
  ))
  return Container
}

/** HH:MM picker: hour and minute columns, or type any time. */
export function TimeField({ value, onChange, ariaLabel = 'Time', size = 'md' }: { value: string; onChange: (hhmm: string) => void; ariaLabel?: string; size?: 'sm' | 'md' }) {
  const date = toDate(value)
  const pick = (d: Date) => onChange(toHHMM(d))
  const container = useTimeContainer(date, pick, false)
  return (
    <span className={`dp-field dp-field--${size}`} role="group" aria-label={ariaLabel}>
      <LuClock className="dp-field__icon" aria-hidden="true" />
      <DatePicker
        selected={date}
        onChange={(d: Date | null) => d && pick(d)}
        showTimeSelectOnly
        dateFormat="HH:mm"
        placeholderText="HH:MM"
        shouldCloseOnSelect={false}
        portalId={PORTAL}
        popperClassName="dp-popper"
        calendarClassName="dp dp--time"
        className="dp-input"
        calendarContainer={container}
      />
    </span>
  )
}

/** Date + time picker (calendar with hour/minute columns), e.g. task deadlines. */
export function DateTimeField({ value, onChange, ariaLabel = 'Date and time', min, max }: { value: number; onChange: (ms: number) => void; ariaLabel?: string; min?: number; max?: number }) {
  const date = new Date(value)
  const container = useTimeContainer(date, (d) => onChange(d.getTime()), true)
  return (
    <span className="dp-field" role="group" aria-label={ariaLabel}>
      <LuCalendar className="dp-field__icon" aria-hidden="true" />
      <DatePicker
        selected={date}
        // picking a day keeps the chosen time
        onChange={(d: Date | null) => {
          if (!d) return
          const next = new Date(d)
          if (d.getHours() === 0 && d.getMinutes() === 0 && (date.getHours() || date.getMinutes())) next.setHours(date.getHours(), date.getMinutes(), 0, 0)
          onChange(next.getTime())
        }}
        dateFormat="d MMM yyyy, HH:mm"
        calendarStartDay={1}
        {...(min ? { minDate: new Date(min) } : {})}
        {...(max ? { maxDate: new Date(max) } : {})}
        shouldCloseOnSelect={false}
        portalId={PORTAL}
        popperClassName="dp-popper"
        calendarClassName="dp"
        className="dp-input"
        calendarContainer={container}
      />
    </span>
  )
}
