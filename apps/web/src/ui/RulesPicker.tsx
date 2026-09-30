import ReactSelect from 'react-select'
import { LuLock } from 'react-icons/lu'
import { RULE_PACKS, type RulePackId } from '@after-office/shared'

// Office rules for an agent's CLAUDE.md (new agent form, hire, CLAUDE.md tab): a multi-select of the sets.
// "Working in After Office" is always in (it can't be removed).

type Option = { value: RulePackId; label: string; description: string; fixed: boolean }
const OPTIONS: Option[] = RULE_PACKS.map((p) => ({ value: p.id, label: p.label, description: p.description, fixed: 'always' in p && !!p.always }))

export function RulesPicker({ value, onChange, disabled }: { value: string[]; onChange: (packs: RulePackId[]) => void; disabled?: boolean }) {
  // the fixed ones are always there, whatever comes in
  const selected = OPTIONS.filter((o) => o.fixed || value.includes(o.value))
  return (
    <ReactSelect<Option, true>
      unstyled
      isMulti
      isClearable={false}
      isDisabled={disabled}
      isSearchable={false}
      closeMenuOnSelect={false}
      placeholder="Pick rules…"
      aria-label="Office rules"
      className="rs rs--md rs--multi rules-select"
      classNamePrefix="rs"
      value={selected}
      options={OPTIONS}
      isOptionDisabled={(o) => o.fixed}
      // chosen ones stay in the menu, ticked, so it reads as a checklist
      hideSelectedOptions={false}
      formatOptionLabel={(o, meta) =>
        meta.context === 'menu' ? (
          <span className="rules-opt">
            <span className="rules-opt__check" aria-hidden>
              {o.fixed ? <LuLock /> : selected.some((s) => s.value === o.value) ? '✓' : ''}
            </span>
            <span className="rules-opt__text">
              <b>{o.label}</b>
              <span className="muted">
                {o.description}
                {o.fixed ? ' Always included.' : ''}
              </span>
            </span>
          </span>
        ) : o.fixed ? (
          <span className="rules-mv__fixed">
            <LuLock aria-label="Always included" /> {o.label}
          </span>
        ) : (
          o.label
        )
      }
      onChange={(list) => onChange(OPTIONS.filter((o) => o.fixed || list.some((l) => l.value === o.value)).map((o) => o.value))}
      menuPortalTarget={document.body}
      menuPlacement="auto"
      classNames={{
        control: (s) => (s.isFocused ? 'rs__control--focused' : ''),
        // its menu is portaled to <body>: a class of its own for the spacing and the orange ticks
        menu: () => 'rules-menu',
        option: (s) => [s.isSelected && 'rs__option--selected', s.isFocused && 'rs__option--focused'].filter(Boolean).join(' '),
        // the always-on set shows without a remove (x) button
        multiValue: (s) => (s.data.fixed ? 'rules-mv rules-mv--fixed' : 'rules-mv'),
      }}
    />
  )
}
