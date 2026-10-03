import { useState, type ReactNode } from 'react'
import { LuArrowLeft, LuArrowRight, LuCheck, LuLayers, LuPlus } from 'react-icons/lu'
import type { OfficeTask } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { useNow } from '../state/clock'
import { useOffice, avatarStyle } from '../state/store'
import { OwnerAvatar } from './EditProfile'
import { TagModal } from './TagModal'
import { TagIcon } from './tagIcons'

// Tasks → List: the tags as cards, like projects (the office groups work by tag): how much is open, done and late,
// what's next, who's on it. A card's footer opens its tasks (All tags to start with); the last card makes a new tag.

/** How a set of tasks stands. */
function summary(tasks: OfficeTask[], now: number) {
  const open = tasks.filter((t) => t.status !== 'done')
  return {
    open: open.length,
    done: tasks.length - open.length,
    late: open.filter((t) => t.deadline < now).length,
    next: [...open].sort((a, b) => a.deadline - b.deadline)[0],
    agents: [...new Set(open.map((t) => (t.forOwner ? '@me' : t.agentId)).filter((x): x is string => !!x))],
  }
}

/** `onSelect`: a card clicked (it takes the focus); `onChange`: its footer clicked (open its tasks). */
export function TagCards({ value, onChange, onSelect }: { value: string; onChange: (tagId: string) => void; onSelect?: (tagId: string) => void }) {
  const tasks = useDashboard((s) => s.tasks)
  const tags = useDashboard((s) => s.tags)
  const now = useNow(60_000).getTime()
  const [showAll, setShowAll] = useState(false)
  // two rows at first; the rest one click away
  const LIMIT = 7
  const shown = showAll ? tags : tags.slice(0, LIMIT)
  return (
    <div className="tag-cards" role="listbox" aria-label="Tasks by tag">
      <TagCard i={0} title="All tags" icon={<LuLayers />} color="var(--text)" s={summary(tasks, now)} on={value === '*'} onFocus={() => onSelect?.('*')} onPick={() => onChange('*')} />
      {shown.map((t, n) => (
        <TagCard
          key={t.id}
          i={n + 1}
          title={t.name}
          icon={<TagIcon tag={t} />}
          color={t.color}
          s={summary(
            tasks.filter((x) => x.tags?.includes(t.id)),
            now,
          )}
          on={value === t.id}
          onFocus={() => onSelect?.(t.id)}
          onPick={() => onChange(t.id)}
        />
      ))}
      {tags.length > LIMIT && (
        <button type="button" className="tag-card tag-card--more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${tags.length} tags`}
        </button>
      )}
      <NewTagCard />
    </div>
  )
}

function TagCard({ i, title, icon, color, s, on, onFocus, onPick }: { i: number; title: string; icon: ReactNode; color: string; s: ReturnType<typeof summary>; on: boolean; onFocus: () => void; onPick: () => void }) {
  const agents = useOffice((st) => st.agents)
  const state = s.open ? (s.late ? 'late' : 'active') : s.done ? 'done' : 'empty'
  return (
    // a click on the card moves the focus to it; only its footer opens the tag
    <div role="option" aria-selected={on} className={`tag-card tag-card--static${on ? ' is-on' : ''}`} style={{ ['--c' as string]: color, ['--i' as string]: Math.min(i, 12) }} onClick={onFocus}>
      <span className="tag-card__top">
        <span className="tag-card__icon">{icon}</span>
        <span className={`tag-card__badge tag-card__badge--${state}`}>{state === 'late' ? `${s.late} late` : state}</span>
      </span>
      <span className="tag-card__title">{title}</span>
      <span className="tag-card__next">{s.next ? `Next: ${s.next.title}` : s.done ? 'Everything here is done' : 'No tasks yet'}</span>
      <button type="button" className="tag-card__foot tag-card__open" onClick={onPick} aria-label={`Open ${title}`}>
        <span className="tag-card__count">
          <b>{s.open}</b> open{s.done ? <span className="muted"> · {s.done} done</span> : null}
        </span>
        <span className="tag-card__who">
          {s.agents.slice(0, 3).map((id) =>
            id === '@me' ? (
              <OwnerAvatar key={id} className="avatar--xs" />
            ) : (
              <span key={id} className="avatar avatar--xs" style={agents.find((a) => a.id === id) ? avatarStyle(agents.find((a) => a.id === id)!.look.shirt) : undefined}>
                {agents.find((a) => a.id === id)?.name[0] ?? '?'}
              </span>
            ),
          )}
        </span>
        <span className="tag-card__go" aria-hidden>
          {on ? <LuCheck /> : <LuArrowRight />}
        </span>
      </button>
    </div>
  )
}

/** The last card: a new tag (named, coloured and given an icon in a modal). */
function NewTagCard() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="tag-card tag-card--new" onClick={() => setOpen(true)}>
        <span className="tag-card__plus">
          <LuPlus />
        </span>
        New tag
      </button>
      {open && <TagModal onClose={() => setOpen(false)} />}
    </>
  )
}

/** Inside a tag (Tasks): back to the cards, which tag this is, how it stands, and List / Board. */
export function TagHeader({ tagId, onBack, children }: { tagId: string; onBack: () => void; children?: ReactNode }) {
  const tasks = useDashboard((s) => s.tasks)
  const tag = useDashboard((s) => s.tags.find((t) => t.id === tagId))
  const now = useNow(60_000).getTime()
  const s = summary(tag ? tasks.filter((t) => t.tags?.includes(tag.id)) : tasks, now)
  return (
    <div className="tag-head" style={{ ['--c' as string]: tag?.color ?? 'var(--text)' }}>
      <button type="button" className="small tag-head__back" onClick={onBack}>
        <LuArrowLeft /> Tags
      </button>
      <span className="tag-card__icon">{tag ? <TagIcon tag={tag} /> : <LuLayers />}</span>
      <span className="tag-head__title">{tag?.name ?? 'All tags'}</span>
      <span className="tag-head__stats muted">
        {s.open} open · {s.done} done{s.late ? <span className="danger-text"> · {s.late} late</span> : null}
      </span>
      {/* how its tasks show (List / Board) */}
      {children && <span className="tag-head__view">{children}</span>}
    </div>
  )
}
