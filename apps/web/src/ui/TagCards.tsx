import { useState, type ReactNode } from 'react'
import { LuArrowLeft, LuArrowRight, LuCheck, LuLayers, LuPlus, LuTag } from 'react-icons/lu'
import type { OfficeTask, Tag } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'
import { useNow } from '../state/clock'
import { useOffice, avatarStyle } from '../state/store'
import { OwnerAvatar } from './EditProfile'
import { nextTagColor } from './tags'

// Tasks → List: the tags as cards, like projects (the office groups work by tag): how much is open, done and late,
// what's next, who's on it. A card picks the list below (All tags to start with); the last one makes a new tag.

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

export function TagCards({ value, onChange }: { value: string; onChange: (tagId: string) => void }) {
  const tasks = useDashboard((s) => s.tasks)
  const tags = useDashboard((s) => s.tags)
  const now = useNow(60_000).getTime()
  const [showAll, setShowAll] = useState(false)
  // two rows at first; the rest one click away
  const LIMIT = 7
  const shown = showAll ? tags : tags.slice(0, LIMIT)
  return (
    <div className="tag-cards" role="listbox" aria-label="Tasks by tag">
      <TagCard i={0} title="All tags" icon={<LuLayers />} color="var(--text)" s={summary(tasks, now)} on={value === '*'} onPick={() => onChange('*')} />
      {shown.map((t, n) => (
        <TagCard
          key={t.id}
          i={n + 1}
          title={t.name}
          icon={<LuTag />}
          color={t.color}
          s={summary(
            tasks.filter((x) => x.tags?.includes(t.id)),
            now,
          )}
          on={value === t.id}
          onPick={() => onChange(t.id)}
        />
      ))}
      {tags.length > LIMIT && (
        <button type="button" className="tag-card tag-card--more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${tags.length} tags`}
        </button>
      )}
      <NewTagCard tags={tags} />
    </div>
  )
}

function TagCard({ i, title, icon, color, s, on, onPick }: { i: number; title: string; icon: ReactNode; color: string; s: ReturnType<typeof summary>; on: boolean; onPick: () => void }) {
  const agents = useOffice((st) => st.agents)
  const state = s.open ? (s.late ? 'late' : 'active') : s.done ? 'done' : 'empty'
  return (
    <button type="button" role="option" aria-selected={on} className={`tag-card${on ? ' is-on' : ''}`} style={{ ['--c' as string]: color, ['--i' as string]: Math.min(i, 12) }} onClick={onPick}>
      <span className="tag-card__top">
        <span className="tag-card__icon">{icon}</span>
        <span className={`tag-card__badge tag-card__badge--${state}`}>{state === 'late' ? `${s.late} late` : state}</span>
      </span>
      <span className="tag-card__title">{title}</span>
      <span className="tag-card__next">{s.next ? `Next: ${s.next.title}` : s.done ? 'Everything here is done' : 'No tasks yet'}</span>
      <span className="tag-card__foot">
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
      </span>
    </button>
  )
}

/** The last card: a new tag, named in place. */
function NewTagCard({ tags }: { tags: Tag[] }) {
  const putTag = useDashboard((s) => s.putTag)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const taken = tags.some((t) => t.name.toLowerCase() === name.trim().toLowerCase())
  const make = () => {
    if (!name.trim() || taken) return
    putTag({ name: name.trim().slice(0, 32), color: nextTagColor(tags) })
    setName('')
    setNaming(false)
  }
  if (!naming)
    return (
      <button type="button" className="tag-card tag-card--new" onClick={() => setNaming(true)}>
        <span className="tag-card__plus">
          <LuPlus />
        </span>
        New tag
      </button>
    )
  // naming it: it looks like the card it will be (its colour, its icon), the name typed where the title goes
  const color = nextTagColor(tags)
  return (
    <form
      className="tag-card tag-card--naming"
      style={{ ['--c' as string]: color }}
      onSubmit={(e) => {
        e.preventDefault()
        make()
      }}
      onKeyDown={(e) => e.key === 'Escape' && (setNaming(false), setName(''))}
    >
      <span className="tag-card__top">
        <span className="tag-card__icon">
          <LuTag />
        </span>
        <span className="tag-card__badge">new</span>
      </span>
      <input className="tag-card__name-input" autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Tag name" aria-label="New tag name" />
      <span className={`tag-card__next${taken ? ' danger-text' : ''}`}>{taken ? 'That tag exists already' : 'e.g. SEO, a client, a project. Enter to create.'}</span>
      <span className="tag-card__foot">
        <button type="button" className="small ghost" onClick={() => (setNaming(false), setName(''))}>
          Cancel
        </button>
        <span className="grow" />
        <button type="submit" className="small primary" disabled={!name.trim() || taken}>
          <LuCheck /> Create
        </button>
      </span>
    </form>
  )
}

/** Inside a tag (Tasks → List): back to the cards, which tag this is, and how it stands. */
export function TagHeader({ tagId, onBack }: { tagId: string; onBack: () => void }) {
  const tasks = useDashboard((s) => s.tasks)
  const tag = useDashboard((s) => s.tags.find((t) => t.id === tagId))
  const now = useNow(60_000).getTime()
  const s = summary(tag ? tasks.filter((t) => t.tags?.includes(tag.id)) : tasks, now)
  return (
    <div className="tag-head" style={{ ['--c' as string]: tag?.color ?? 'var(--text)' }}>
      <button type="button" className="small tag-head__back" onClick={onBack}>
        <LuArrowLeft /> Tags
      </button>
      <span className="tag-card__icon">{tag ? <LuTag /> : <LuLayers />}</span>
      <span className="tag-head__title">{tag?.name ?? 'All tags'}</span>
      <span className="tag-head__stats muted">
        {s.open} open · {s.done} done{s.late ? <span className="danger-text"> · {s.late} late</span> : null}
      </span>
    </div>
  )
}
