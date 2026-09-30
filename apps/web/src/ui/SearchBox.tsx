import { LuSearch, LuX } from 'react-icons/lu'

/** A small search field with a clear button (lists in the side panels). */
export function SearchBox({ value, onChange, placeholder, className = '' }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <label className={`search-box search-box--sm ${className}`}>
      <LuSearch />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} onKeyDown={(e) => e.key === 'Escape' && onChange('')} />
      {value && (
        <button type="button" className="icon-btn small ghost" onClick={() => onChange('')} aria-label="Clear search">
          <LuX />
        </button>
      )}
    </label>
  )
}

/** Does any of these texts contain every word of the search (any case)? */
export function matchesSearch(q: string, ...texts: (string | null | undefined)[]) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}
