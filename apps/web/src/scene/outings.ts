import type { Vec2 } from './layout'
import type { Driver } from './Traffic'

// Agents who are off (asleep) don't go home: they hang out in town. Some sit at a table at the café behind the office
// or the coffee shop across the side road, some take their car or motorbike for a ride round the streets
// (scene/Traffic.tsx); when they're woken they come back from wherever they are (scene/Agent.tsx).

/** A seat in town: where it is, which way it faces (the table), and the walk to it from the office's door. */
export type Seat = { x: number; z: number; rotY: number; walk: Vec2[] }

/** The town's seats, set by the city (scene/City.tsx). */
let seats: Seat[] = []
export const setSeats = (list: Seat[]) => void (seats = list)

/** Who sits where (a seat each). */
const taken = new Map<number, string>()

/** A free seat for this agent, the same one each time it's free (picked from its desk); null: none (no town yet). */
export function takeSeat(agentId: string, desk: number): number | null {
  for (const [n, id] of taken) if (id === agentId) return n
  if (!seats.length) return null
  const first = (desk * 7 + 3) % seats.length
  for (let k = 0; k < seats.length; k++) {
    const n = (first + k * 5) % seats.length
    if (!taken.has(n)) {
      taken.set(n, agentId)
      return n
    }
  }
  return null
}
export const seatAt = (n: number): Seat | undefined => seats[n]
export const freeSeat = (n: number) => void taken.delete(n)

/** What an agent does when it's off: a ride round town, or a seat somewhere (the same for an agent every time). */
export const outingKind = (desk: number): 'ride' | 'sit' => ((desk * 7 + 3) % 5 < 2 ? 'ride' : 'sit')

/** Where each agent who is out is now: kept when its character is drawn afresh (it comes back from there). */
export const outings = new Map<string, { kind: 'sit'; seat: number } | { kind: 'ride'; driver: Driver }>()

/** Whether the town is showing now (scene/City.tsx, from a zoom out): out of it, those in town aren't drawn. */
export const townView = { shown: false }
