import type { OfficeAgent } from '../state/store'

// What an agent is doing, in a few words: the agents list, the bubbles above them in the office (scene/labels.tsx)
// and the card of a clicked agent (ui/FocusCard.tsx).

export function waitingLabel(k: NonNullable<OfficeAgent['waitingFor']>) {
  return k === 'plan' ? 'Plan ready' : k === 'question' ? 'Question' : 'Needs you'
}

export function idleText(spotId: string) {
  if (spotId.startsWith('boss-shelf')) return 'Planning on the whiteboard'
  if (spotId.startsWith('cat')) return 'Playing with the cat'
  if (spotId.startsWith('pool')) return 'Shooting pool'
  if (spotId.startsWith('sofa')) return 'Watching TV'
  if (spotId.startsWith('pantry')) return 'Snack break in the pantry'
  if (spotId.startsWith('pc-')) return 'Watching videos at the desk'
  if (spotId.startsWith('desk')) return 'Chilling at the desk'
  return 'Idle'
}

/** One short line: the tool it's using or its task while it works, what it needs while it waits, its pastime when idle. */
export function activityOf(a: Pick<OfficeAgent, 'status' | 'waitingFor' | 'tool' | 'task' | 'spotId'>): string {
  if (a.status === 'offline') return 'Offline'
  if (a.status === 'asleep') return 'Asleep'
  if (a.status === 'waiting') return a.waitingFor ? waitingLabel(a.waitingFor) : 'Needs you'
  if (a.status === 'working' || a.status === 'meeting') {
    if (a.tool) return `Using ${a.tool.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')}`
    return a.task?.split('\n')[0] || (a.status === 'meeting' ? 'In a meeting' : 'Working')
  }
  return idleText(a.spotId)
}
