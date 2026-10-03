import { tip } from './Tooltip'
import ReactSelect from 'react-select'
import CreatableSelect from 'react-select/creatable'
import type { Tag } from '@after-office/shared'
import { useDashboard } from '../state/dashboard'

// Tags: the owner's coloured labels for tasks and reports. Made right in the picker (type a new name), managed
// (rename, colour, delete) in the Tags tab of the left sidebar (ui/TagsTab.tsx).

export const TAG_COLORS = ['#e8762c', '#f4b817', '#2fbf71', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#9a9a96']

/** The next colour for a new tag: the least used one. */
export function nextTagColor(tags: Tag[]) {
  const used = new Map(TAG_COLORS.map((c) => [c, 0]))
  for (const t of tags) used.set(t.color, (used.get(t.color) ?? 0) + 1)
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0][0]
}

/** A task's or report's tags as small coloured chips. */
/** A thing's tags as chips; with `max`, the first few and "+N" for the rest (named on hover). */
export function TagChips({ ids, className = '', max }: { ids?: string[]; className?: string; max?: number }) {
  const tags = useDashboard((s) => s.tags)
  const all = (ids ?? []).map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => !!t)
  if (!all.length) return null
  const shown = max ? all.slice(0, max) : all
  const more = all.slice(shown.length)
  return (
    <span className={`tag-chips ${className}`}>
      {shown.map((t) => (
        <span key={t.id} className="tag-chip" style={{ ['--c' as string]: t.color }}>
          {t.name}
        </span>
      ))}
      {more.length > 0 && (
        <span className="tag-chip tag-chip--more" {...tip(more.map((t) => t.name).join(', '))}>
          +{more.length}
        </span>
      )}
    </span>
  )
}

type TagOption = { value: string; label: string; color: string }
const toOption = (t: Tag): TagOption => ({ value: t.id, label: t.name, color: t.color })
const optionLabel = (o: TagOption) => (
  <span className="tag-opt">
    <span className="chip__dot" style={{ background: o.color }} />
    <span className="truncate">{o.label}</span>
  </span>
)
const selectClassNames = {
  control: (s: { isFocused: boolean }) => (s.isFocused ? 'rs__control--focused' : ''),
  option: (s: { isSelected: boolean; isFocused: boolean }) => [s.isSelected && 'rs__option--selected', s.isFocused && 'rs__option--focused'].filter(Boolean).join(' '),
  multiValue: () => 'tag-mv',
}
const tagStyles = { multiValue: (base: object, p: { data: TagOption }) => ({ ...base, ['--c' as string]: p.data.color }) }

/** Pick a task's or report's tags; typing a new name creates the tag. */
export function TagPicker({ value, onChange, size = 'md', inline = false, menuPlacement = 'auto' }: { value: string[]; onChange: (ids: string[]) => void; size?: 'sm' | 'md'; inline?: boolean; menuPlacement?: 'auto' | 'top' }) {
  const tags = useDashboard((s) => s.tags)
  const putTag = useDashboard((s) => s.putTag)
  const options = tags.map(toOption)
  return (
    <CreatableSelect<TagOption, true>
      unstyled
      isMulti
      isClearable={false}
      placeholder={inline ? '+ Add tags' : 'Add tags…'}
      aria-label="Tags"
      // inline: reads like the text around it until hovered or opened (a report's tags under its title)
      className={`rs rs--${size} rs--multi${inline ? ' rs--inline' : ''}`}
      classNamePrefix="rs"
      value={options.filter((o) => value.includes(o.value))}
      options={options}
      formatOptionLabel={(o, meta) => (meta.context === 'menu' ? optionLabel(o) : o.label)}
      formatCreateLabel={(name) => `Create tag "${name.trim()}"`}
      isValidNewOption={(name) => !!name.trim() && name.trim().length <= 32 && !tags.some((t) => t.name.toLowerCase() === name.trim().toLowerCase())}
      onCreateOption={(name) => onChange([...value, putTag({ name, color: nextTagColor(tags) })])}
      onChange={(list) => onChange(list.map((o) => o.value))}
      noOptionsMessage={() => 'Type a name to make a tag'}
      menuPortalTarget={document.body}
      menuPlacement={menuPlacement}
      classNames={selectClassNames}
      styles={tagStyles}
    />
  )
}

/** Filter by tags (any of them matches). */
export function TagFilter({ value, onChange, className = '' }: { value: string[]; onChange: (ids: string[]) => void; className?: string }) {
  const tags = useDashboard((s) => s.tags)
  const options = tags.map(toOption)
  return (
    <span className={`tag-filter ${className}`}>
      <ReactSelect<TagOption, true>
        unstyled
        isMulti
        isClearable={false}
        placeholder="All tags"
        aria-label="Filter by tag"
        className="rs rs--md rs--multi"
        classNamePrefix="rs"
        value={options.filter((o) => value.includes(o.value))}
        options={options}
        formatOptionLabel={(o, meta) => (meta.context === 'menu' ? optionLabel(o) : o.label)}
        onChange={(list) => onChange(list.map((o) => o.value))}
        noOptionsMessage={() => 'No tags yet: add them on a task or report'}
        menuPortalTarget={document.body}
        menuPlacement="auto"
        classNames={selectClassNames}
        styles={tagStyles}
      />
    </span>
  )
}
