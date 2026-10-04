import { useEffect, useState } from 'react'
import { LuCheck, LuLoaderCircle } from 'react-icons/lu'
import { useBusy, type Activity } from '../state/busy'

// A small "Deleting 3 reports… / Saving task…" while the dashboard writes something (state/busy.ts), then a
// short "Deleted" / "Saved". Quick writes (under SHOW_AFTER) don't flash it at all.

const SHOW_AFTER = 350
const DONE_FOR = 1400

const plural = (label: string, n: number) => (n === 1 || !label ? label : label.endsWith('s') ? label : `${label}s`)

function sentence(kind: Activity['kind'], items: Activity[]) {
  const verb = kind === 'delete' ? 'Deleting' : 'Saving'
  // one with its own count ("10 reports") says it; several single ones are counted
  if (items.length === 1) return `${verb}${items[0].label ? ` ${items[0].label}` : ''}…`
  const labels = new Set(items.map((x) => x.label))
  const label = labels.size === 1 ? [...labels][0] : ''
  return `${verb} ${items.length}${label ? ` ${plural(label, items.length)}` : ' items'}…`
}

export function BusyPill() {
  const items = useBusy((s) => s.items)
  const finished = useBusy((s) => s.finished)
  const [now, setNow] = useState(Date.now())
  // ticks only while something is going on (or a "Done" is showing)
  const ticking = items.length > 0 || (!!finished && Date.now() - finished.at < DONE_FOR)
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 150)
    return () => clearInterval(t)
  }, [ticking])
  // was it on screen? then its end shows as "Deleted" / "Saved"
  const [shown, setShown] = useState(false)
  const visible = items.filter((x) => now - x.startedAt >= SHOW_AFTER || x.total)
  useEffect(() => {
    if (visible.length) setShown(true)
    else if (!items.length && finished && now - finished.at >= DONE_FOR) setShown(false)
  }, [visible.length, items.length, finished, now])

  if (visible.length) {
    // deletes first: that's what the owner is waiting to see gone
    const kind = visible.some((x) => x.kind === 'delete') ? 'delete' : 'save'
    const mine = visible.filter((x) => x.kind === kind)
    const withTotal = mine.find((x) => x.total)
    const pct = withTotal ? Math.round(((withTotal.done ?? 0) / withTotal.total!) * 100) : null
    return (
      <div className={`busy-pill busy-pill--${kind}`} role="status" aria-live="polite">
        <LuLoaderCircle className="busy-pill__spin" />
        <span className="busy-pill__text">
          {sentence(kind, mine)}
          {withTotal && (
            <span className="busy-pill__count">
              {withTotal.done ?? 0}/{withTotal.total}
            </span>
          )}
        </span>
        <span className={`busy-pill__bar${pct === null ? ' is-indeterminate' : ''}`} aria-hidden>
          <span style={pct === null ? undefined : { width: `${pct}%` }} />
        </span>
      </div>
    )
  }
  if (shown && finished && now - finished.at < DONE_FOR && !items.length) {
    return (
      <div className="busy-pill busy-pill--done" role="status" aria-live="polite" key={finished.at}>
        <LuCheck />
        <span className="busy-pill__text">{finished.kind === 'delete' ? 'Deleted' : 'Saved'}</span>
      </div>
    )
  }
  return null
}
