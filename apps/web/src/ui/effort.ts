import type { AgentEffort } from '@after-office/shared'

// Claude Code's thinking effort (`claude --effort`), for the agent profile and the hire form. '' = its own default.
export const EFFORT_LABEL: Record<AgentEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

export const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  ...(Object.keys(EFFORT_LABEL) as AgentEffort[]).map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
]
