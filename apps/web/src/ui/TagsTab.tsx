import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { matchesSearch } from './SearchBox'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { LuPlus, LuTrash2 } from 'react-icons/lu'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import type { Tag } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { confirm } from './Confirm'
import { nextTagColor, TAG_COLORS } from './tags'
import { tip } from './Tooltip'

// The Tags tab (left sidebar, next to Tasks and Projects): make, rename, recolour and delete tags. Tags are also made
// right in a task's or report's tag picker.

export function TagsTab({ q = '' }: { q?: string }) {
  const allTags = useDashboard((s) => s.tags)
  const tags = allTags.filter((t) => matchesSearch(q, t.name))
  const tasks = useDashboard((s) => s.tasks)
  const reports = useDashboard((s) => s.reports)
  const putTag = useDashboard((s) => s.putTag)
  const removeTag = useDashboard((s) => s.removeTag)
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const taken = (n: string, id?: string) => allTags.some((t) => t.id !== id && t.name.toLowerCase() === n.trim().toLowerCase())
  const add = () => {
    const n = name.trim()
    if (!n) return
    if (taken(n)) return setError(`There is already a tag called ${n}.`)
    putTag({ name: n, color: nextTagColor(allTags) })
    setName('')
    setError('')
  }
  const uses = (id: string) => ({ tasks: tasks.filter((t) => t.tags?.includes(id)).length, reports: reports.filter((r) => r.tags?.includes(id)).length })
  const remove = async (t: Tag) => {
    const u = uses(t.id)
    const where = [u.tasks && `${u.tasks} task${u.tasks === 1 ? '' : 's'}`, u.reports && `${u.reports} report${u.reports === 1 ? '' : 's'}`].filter(Boolean).join(' and ')
    if (!(await confirm({ title: `Delete the tag "${t.name}"?`, message: where ? `It's taken off ${where} (and any older ones). The tasks and reports stay.` : 'Nothing uses it right now.', confirmLabel: 'Delete tag' }))) return
    removeTag(t.id)
  }

  return (
    <div className="tags-tab">
      <form
        className="tags-modal__new"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input value={name} onChange={(e) => (setName(e.target.value), setError(''))} maxLength={32} placeholder="New tag, e.g. SEO" aria-label="New tag name" />
        <button className="icon-btn small primary" disabled={!name.trim()} {...tip('Add tag')}>
          <LuPlus />
        </button>
      </form>
      {error && <p className="danger-text tags-tab__error">{error}</p>}
      {!tags.length ? (
        <p className="empty">{allTags.length ? 'No tags match.' : "No tags yet. Add one here, or type a new name in a task's or report's tag picker."}</p>
      ) : (
        <ul className="list tags-modal__list">
          {tags.map((t) => (
            <TagRow key={t.id} tag={t} uses={uses(t.id)} taken={(n) => taken(n, t.id)} onSave={(patch) => putTag({ ...t, ...patch })} onDelete={() => void remove(t)} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TagRow({ tag, uses, taken, onSave, onDelete }: { tag: Tag; uses: { tasks: number; reports: number }; taken: (name: string) => boolean; onSave: (p: Partial<Tag>) => void; onDelete: () => void }) {
  const [name, setName] = useState(tag.name)
  const [picking, setPicking] = useState(false)
  const colorBox = useRef<HTMLSpanElement>(null)
  // the palette floats over the page (a portal), placed by floating-ui: never cut off by the scrolling list
  const pop = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const ref = colorBox.current
    const el = pop.current
    if (!picking || !ref || !el) return
    return autoUpdate(ref, el, () =>
      void computePosition(ref, el, { placement: 'bottom-start', strategy: 'fixed', middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })] }).then(({ x, y }) => {
        el.style.left = `${x}px`
        el.style.top = `${y}px`
      }),
    )
  }, [picking])
  const custom = !TAG_COLORS.includes(tag.color)
  const [mixing, setMixing] = useState(false)
  // a custom colour follows the picker live, saved once it settles (dragging in the picker fires many changes)
  const [draft, setDraft] = useState(tag.color)
  useEffect(() => setDraft(tag.color), [tag.color])
  useEffect(() => {
    if (draft === tag.color || !/^#[0-9a-f]{6}$/i.test(draft)) return
    const t = setTimeout(() => onSave({ color: draft }), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  // the colour picker closes on a click elsewhere, or Esc
  useEffect(() => {
    if (!picking) return setMixing(false)
    const away = (e: PointerEvent) => !colorBox.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setPicking(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPicking(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [picking])
  const bad = !name.trim() ? 'A tag needs a name' : taken(name) ? 'That name is taken' : ''
  // renamed on Enter or when leaving the field; a bad name goes back to the saved one
  const commit = () => {
    if (bad) return setName(tag.name)
    if (name.trim() !== tag.name) onSave({ name: name.trim() })
  }
  return (
    <li className="tags-modal__row">
      <span className="tags-modal__color" ref={colorBox}>
        <button type="button" className="tags-modal__swatch" style={{ background: draft }} onClick={() => setPicking((v) => !v)} aria-expanded={picking} {...tip(`Colour of ${tag.name}`)} />
        {picking &&
          createPortal(
          <span ref={pop} className="tags-modal__palette" role="listbox" aria-label="Colours">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={c === tag.color}
                className={`tags-modal__swatch${c === tag.color ? ' is-on' : ''}`}
                style={{ background: c }}
                onClick={() => {
                  onSave({ color: c })
                  setPicking(false)
                }}
                aria-label={c}
              />
            ))}
            {/* any colour: a rainbow swatch opens the picker below (on when the tag has a colour of its own) */}
            <button
              type="button"
              className={`tags-modal__swatch tags-modal__custom${custom || mixing ? ' is-on' : ''}`}
              aria-expanded={mixing}
              onClick={() => setMixing((v) => !v)}
              {...tip('Custom colour')}
            />
            {mixing && (
              <span className="tags-modal__mixer">
                <HexColorPicker color={draft} onChange={setDraft} />
                <span className="tags-modal__hex">
                  <span className="tags-modal__hex-dot" style={{ background: draft }} />#
                  <HexColorInput color={draft} onChange={setDraft} aria-label="Hex colour" />
                </span>
              </span>
            )}
          </span>,
          document.body,
        )}
      </span>
      <input
        className={`tags-modal__name${bad ? ' is-bad' : ''}`}
        value={name}
        maxLength={32}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            setName(tag.name)
          }
        }}
        aria-label="Tag name"
        data-tip={bad || undefined}
      />
      <span className="tags-modal__uses muted">
        {uses.tasks} task{uses.tasks === 1 ? '' : 's'} · {uses.reports} report{uses.reports === 1 ? '' : 's'}
      </span>
      <button type="button" className="icon-btn small ghost" onClick={onDelete} {...tip(`Delete ${tag.name}`)}>
        <LuTrash2 />
      </button>
    </li>
  )
}
