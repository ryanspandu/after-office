import { useState } from 'react'
import { create } from 'zustand'
import { LuCheck } from 'react-icons/lu'
import { api } from '../state/auth'
import { useClock, zonedParts } from '../state/clock'
import { Field, Modal } from './Modal'
import { NoteDateButton, type NoteWhen, type NoteWhenPatch } from './NoteDate'

// "+" on the calendar (the Daily card's Calendar tab, its big window, the phones' Calendar sheet): a new event. An
// event is simply a dated note (ui/NoteDate.tsx), so it's on the calendar, in Notes, and goes to Google Calendar /
// .ics like the rest. The day picked in the calendar (useCalendarDay) is where it starts.

export const useCalendarDay = create<{ day: string | null; adding: NoteWhen | null }>(() => ({ day: null, adding: null }))

/** Open the "New event" form on `day` (else the day picked in the calendar, else today in office time). */
export function openNewEvent(day?: string) {
  const at = day ?? useCalendarDay.getState().day ?? zonedParts(new Date(), useClock.getState().timezone).date
  useCalendarDay.setState({ adding: { date: at } })
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** The description as the note's text: a paragraph per line. */
const toHtml = (text: string) =>
  text.trim()
    ? text
        .trim()
        .split('\n')
        .map((l) => `<p>${esc(l)}</p>`)
        .join('')
    : ''

/** Always mounted (ui/UrlModals.tsx): shows the form while one is being added. */
export function NewEventHost() {
  const adding = useCalendarDay((s) => s.adding)
  if (!adding) return null
  return <NewEventModal start={adding} onClose={() => useCalendarDay.setState({ adding: null })} />
}

function NewEventModal({ start, onClose }: { start: NoteWhen; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState<NoteWhen>(start)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // the same rules as on a note: no day, none of it; a range has no time
  const change = (patch: NoteWhenPatch) =>
    setWhen((w) => {
      const next = { ...w }
      for (const k of ['date', 'dateEnd', 'time'] as const) if (patch[k] !== undefined) next[k] = patch[k] ?? undefined
      if (!next.date) return {}
      if (next.dateEnd) next.time = undefined
      return next
    })
  const ok = !!title.trim() && !!when.date && !saving
  const save = async () => {
    if (!ok) return
    setSaving(true)
    setError(null)
    try {
      const r = await api('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), html: toHtml(text), ...when }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save')
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="New event" description="Saved as a note with its date: it shows on the calendar and in Notes." width={460}>
      <form
        className="modal__body new-event"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label="Title">
          <input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call with the client" />
        </Field>
        <div className="field">
          <span className="field__label">When</span>
          <NoteDateButton value={when} onChange={change} />
        </div>
        <Field label="Description" hint="Optional">
          <textarea value={text} rows={3} maxLength={5000} onChange={(e) => setText(e.target.value)} />
        </Field>
        {error && <p className="danger-text">{error}</p>}
        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <button type="submit" className="primary" disabled={!ok}>
            <LuCheck /> Add event
          </button>
        </footer>
      </form>
    </Modal>
  )
}
