import { useOffice } from '../state/store'
import { colsForDesks, getLayout } from './layout'

/** Current office layout: gains a desk column whenever the agent count needs one. */
export function useLayout() {
  const cols = useOffice((s) => colsForDesks(s.agents.reduce((max, a) => Math.max(max, a.desk), -1)))
  return getLayout(cols)
}
