import { useState } from 'react'
import { LuCheck, LuSearch, LuX } from 'react-icons/lu'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import type { Tag } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { Modal } from './Modal'
import { nextTagColor, TAG_COLORS } from './tags'
import { TAG_ICON_GROUPS, TagIcon } from './tagIcons'
import { tip } from './Tooltip'

// Make a tag, or change one (the Tags tab's "+" and Edit, the New tag card in Tasks): its name, colour and icon.

export function TagModal({ tag, onClose, onSaved }: { tag?: Tag; onClose: () => void; onSaved?: (id: string) => void }) {
  const tags = useDashboard((s) => s.tags)
  const putTag = useDashboard((s) => s.putTag)
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState(tag?.color ?? nextTagColor(tags))
  const [icon, setIcon] = useState(tag?.icon ?? 'tag')
  const [mixing, setMixing] = useState(!!tag && !TAG_COLORS.includes(tag.color))
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const taken = tags.some((t) => t.id !== tag?.id && t.name.toLowerCase() === name.trim().toLowerCase())
  const bad = !name.trim() ? '' : taken ? 'There is already a tag with that name' : ''
  const ok = !!name.trim() && !taken && /^#[0-9a-f]{6}$/i.test(color)
  const groups = TAG_ICON_GROUPS.map((g) => ({ ...g, icons: g.icons.filter(([k]) => !needle || k.includes(needle) || g.label.toLowerCase().includes(needle)) })).filter((g) => g.icons.length)

  const save = () => {
    if (!ok) return
    const id = putTag({ ...(tag ? { id: tag.id } : {}), name: name.trim().slice(0, 32), color, icon: icon === 'tag' ? undefined : icon })
    onSaved?.(id)
    onClose()
  }

  return (
    <Modal open onClose={onClose} title={tag ? 'Edit tag' : 'New tag'} width={520}>
      <form
        className="modal__body tag-modal"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        {/* how it will look */}
        <div className="tag-modal__preview" style={{ ['--c' as string]: color }}>
          <span className="tag-card__icon">
            <TagIcon icon={icon} />
          </span>
          <input className="tag-modal__name" autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Tag name, e.g. SEO" aria-label="Tag name" />
        </div>
        {bad && <p className="danger-text tag-modal__error">{bad}</p>}

        <div className="tag-modal__label">Colour</div>
        <div className="tag-modal__colors" role="listbox" aria-label="Colour">
          {TAG_COLORS.map((c) => (
            <button key={c} type="button" role="option" aria-selected={c === color} className={`tag-modal__swatch${c === color && !mixing ? ' is-on' : ''}`} style={{ background: c }} onClick={() => (setColor(c), setMixing(false))} aria-label={c} />
          ))}
          <button type="button" className={`tag-modal__swatch tags-modal__custom${mixing ? ' is-on' : ''}`} aria-expanded={mixing} onClick={() => setMixing((v) => !v)} {...tip('Custom colour')} />
        </div>
        {mixing && (
          <div className="tag-modal__mixer ui-drop">
            <HexColorPicker color={color} onChange={setColor} />
            <span className="tags-modal__hex">
              <span className="tags-modal__hex-dot" style={{ background: color }} />#
              <HexColorInput color={color} onChange={setColor} aria-label="Hex colour" />
            </span>
          </div>
        )}

        <div className="tag-modal__label">Icon</div>
        <label className="search-box tag-modal__search">
          <LuSearch />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search icons, e.g. rocket, money, code" aria-label="Search icons" />
          {q && (
            <button type="button" className="icon-btn small ghost" onClick={() => setQ('')} aria-label="Clear search">
              <LuX />
            </button>
          )}
        </label>
        <div className="tag-modal__icons" style={{ ['--c' as string]: color }}>
          {groups.length ? (
            groups.map((g) => (
              <section key={g.label}>
                <div className="tag-modal__group muted">{g.label}</div>
                <div className="tag-modal__grid" role="listbox" aria-label={g.label}>
                  {g.icons.map(([k, Icon]) => (
                    <button key={k} type="button" role="option" aria-selected={k === icon} className={`tag-modal__icon${k === icon ? ' is-on' : ''}`} onClick={() => setIcon(k)} {...tip(k.replace(/-/g, ' '))}>
                      <Icon />
                    </button>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <p className="empty">No icons match “{q.trim()}”.</p>
          )}
        </div>

        <footer className="modal__foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <button type="submit" className="primary" disabled={!ok}>
            <LuCheck /> {tag ? 'Save' : 'Create tag'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
