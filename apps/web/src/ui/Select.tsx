import type { ReactNode } from 'react'
import ReactSelect from 'react-select'

// Thin wrapper over react-select: string values in/out, styled entirely by `.rs__*` classes in styles/select.css.

export interface Option<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
  /** Type to filter options. */
  searchable?: boolean
  /** Text shown in the closed control; defaults to the option label. */
  display?: (o: Option<T>) => ReactNode
  /** The open list wider than the control (a small button). */
  menuWidth?: number
}

export function Select<T extends string>({ value, options, onChange, ariaLabel, size = 'md', className, disabled, searchable, display, menuWidth }: Props<T>) {
  return (
    <ReactSelect<Option<T>, false>
      unstyled
      isSearchable={!!searchable}
      placeholder={searchable ? 'Search…' : undefined}
      noOptionsMessage={() => 'No matches'}
      formatOptionLabel={display ? (o, meta) => (meta.context === 'value' ? display(o) : o.label) : undefined}
      isDisabled={disabled}
      aria-label={ariaLabel}
      className={`rs rs--${size}${className ? ` ${className}` : ''}`}
      classNamePrefix="rs"
      value={options.find((o) => o.value === value) ?? null}
      options={options}
      onChange={(o) => o && onChange(o.value)}
      // opened: the list starts at what's picked (a long list, e.g. the timezones, would otherwise open at its top)
      onMenuOpen={() =>
        setTimeout(() => {
          const sel = document.querySelector<HTMLElement>('.rs__menu .rs__option--selected')
          const list = sel?.closest<HTMLElement>('.rs__menu-list')
          if (sel && list) list.scrollTop = Math.max(0, sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2)
        }, 0)
      }
      // render the menu on <body> so cards with overflow don't clip it
      menuPortalTarget={document.body}
      menuPlacement="auto"
      styles={
        menuWidth
          ? {
              // lined up with the control's left edge (a control that widens when opened grows to the right)
              menuPortal: (base) => ({ ...base, width: menuWidth }),
            }
          : undefined
      }
      classNames={{
        control: (s) => (s.isFocused ? 'rs__control--focused' : ''),
        option: (s) => [s.isSelected && 'rs__option--selected', s.isFocused && 'rs__option--focused'].filter(Boolean).join(' '),
      }}
    />
  )
}
