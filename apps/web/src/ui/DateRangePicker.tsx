import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import { placePopover } from '../state/placePopover'
import { usePresence } from '../state/usePresence'
import { DayPicker, type DateRange } from 'react-day-picker'
import 'react-day-picker/style.css'
import { LuCalendar, LuChevronDown } from 'react-icons/lu'
import { rangeBounds, useDashboard, ymd, type RangePreset } from '../state/dashboard'

const PRESETS: { id: Exclude<RangePreset, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
]

/** A range as the picker shows it: a preset (e.g. "7d", "all"), or custom days (YYYY-MM-DD, inclusive). */
export interface PickedRange {
  preset: string
  from: string
  to: string
}

const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const fmt = (s: string) => parse(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** Token-usage range (navbar): the dashboard's own range. */
export function DateRangePicker() {
  const { range, setRange } = useDashboard(useShallow((s) => ({ range: s.range, setRange: s.setRange })))
  return <RangePicker value={range} onChange={(r) => setRange(r as typeof range)} presets={PRESETS} bounds={(r) => rangeBounds(r as typeof range)} />
}

/** Quick presets + a calendar for a custom range, in a popover. Any range: pass the value, presets and its bounds. */
export function RangePicker({
  value: range,
  onChange: setRange,
  presets,
  bounds,
}: {
  value: PickedRange
  onChange: (r: PickedRange) => void
  presets: { id: string; label: string }[]
  /** the days a preset covers (for the calendar); null: no bounds (e.g. "All time") */
  bounds: (r: PickedRange) => [string, string] | null
}) {
  const [open, setOpen] = useState(false)
  const presence = usePresence(open, 140)
  const [draft, setDraft] = useState<DateRange | undefined>()
  const [pos, setPos] = useState<{ top: number; left: number; transformOrigin?: string }>({ top: 0, left: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  const b = bounds(range)
  const [from, to] = b ?? [ymd(new Date()), ymd(new Date())]
  const label =
    range.preset === 'custom' ? (from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`) : (presets.find((p) => p.id === range.preset)?.label ?? range.preset)

  // after the popover is in the DOM, so its real width decides left- or right-alignment
  useLayoutEffect(() => {
    if (!open || !presence.mounted || !button.current) return
    setPos(placePopover(button.current, pop.current))
  }, [open, presence.mounted])

  useEffect(() => {
    if (!open) return
    setDraft(b ? { from: parse(from), to: parse(to) } : undefined)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const apply = () => {
    if (!draft?.from) return
    setRange({ preset: 'custom', from: ymd(draft.from), to: ymd(draft.to ?? draft.from) })
    setOpen(false)
  }

  return (
    <>
      <button ref={button} className="range-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <LuCalendar />
        <span>{label}</span>
        <LuChevronDown className="muted" />
      </button>
      {presence.mounted &&
        createPortal(
          <div ref={pop} className={`popover range-pop${presence.closing ? ' popover--closing' : ''}`} style={pos} role="dialog" aria-label="Choose date range">
            <div className="range-pop__presets">
              {presets.map((p) => (
                <button
                  key={p.id}
                  className={range.preset === p.id ? 'active' : ''}
                  onClick={() => {
                    setRange({ ...range, preset: p.id })
                    setOpen(false)
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="range-pop__cal">
              <DayPicker
                mode="range"
                selected={draft}
                onSelect={setDraft}
                disabled={{ after: new Date() }}
                defaultMonth={draft?.to ?? new Date()}
                endMonth={new Date()}
                weekStartsOn={1}
              />
              <div className="range-pop__foot">
                <span className="muted">
                  {draft?.from ? `${fmt(ymd(draft.from))} – ${draft.to ? fmt(ymd(draft.to)) : '…'}` : 'Pick a start date'}
                </span>
                <button className="small primary" disabled={!draft?.from} onClick={apply}>
                  Apply
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
