import type { AgentFigure } from '@after-office/shared'

// The agent's character in the office: a man (short hair) or a woman (long hair, skirt). Chosen here or by the
// manager when it hires; never guessed from the name.

export function FigurePicker({ value, onChange }: { value?: AgentFigure; onChange: (f: AgentFigure) => void }) {
  return (
    <div className="seg figure-picker" role="radiogroup" aria-label="Character">
      {(
        [
          ['woman', 'Woman'],
          ['man', 'Man'],
        ] as const
      ).map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}
