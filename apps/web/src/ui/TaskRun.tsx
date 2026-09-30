import type { LiveMode, OfficeTask } from '@after-office/shared'
import { useOffice } from '../state/store'
import { Field } from './Modal'
import { DateTimeField } from './pickers'
import { Select } from './Select'

// Live-only task settings: which permission mode the agent works in, and whether the task starts by itself.
// The deadline stays "when it must be done"; the start is separate.

export type TaskRun = Pick<OfficeTask, 'autoStart' | 'startAt' | 'mode'>

const MODE_OPTIONS: { value: '' | LiveMode; label: string }[] = [
  { value: '', label: "Agent's current mode" },
  { value: 'default', label: 'Ask before actions' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto (no permission prompts)' },
]

const START_OPTIONS = [
  { value: 'manual', label: 'When I click Start' },
  { value: 'free', label: 'As soon as the agent is free' },
  { value: 'at', label: 'At a set time' },
] as const
type Start = (typeof START_OPTIONS)[number]['value']

export function TaskRunFields({ value, onChange }: { value: TaskRun; onChange: (patch: TaskRun) => void }) {
  const live = useOffice((s) => s.source === 'live')
  if (!live) return null
  const start: Start = !value.autoStart ? 'manual' : value.startAt ? 'at' : 'free'
  return (
    <div className="field-row">
      <Field label="Start" hint={start === 'at' ? undefined : start === 'free' ? 'Sent right away, or queued until the agent is idle.' : undefined}>
        <Select<Start>
          ariaLabel="Start"
          value={start}
          options={[...START_OPTIONS]}
          onChange={(s) =>
            onChange(
              s === 'manual'
                ? { autoStart: false, startAt: undefined }
                : s === 'free'
                  ? { autoStart: true, startAt: undefined }
                  : { autoStart: true, startAt: value.startAt ?? Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000 },
            )
          }
        />
        {start === 'at' && <DateTimeField value={value.startAt!} onChange={(startAt) => onChange({ autoStart: true, startAt })} ariaLabel="Start at" />}
      </Field>
      <Field label="Mode for this task" hint={value.mode ? 'The agent goes back to its previous mode afterwards.' : undefined}>
        <Select<'' | LiveMode>
          ariaLabel="Mode for this task"
          value={value.mode ?? ''}
          options={MODE_OPTIONS}
          onChange={(m) => onChange({ mode: m || undefined })}
        />
      </Field>
    </div>
  )
}
