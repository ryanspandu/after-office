import { useEffect, useRef } from 'react'
import { forgetStep, pushStep } from './url'

/**
 * While mounted (and `on`), the Back gesture / button calls `onBack` instead of leaving the page: a window opened on
 * top of another without an address of its own (a file's preview over a folder's sheet) closes alone, and what's
 * under it stays. A step in the history (state/url.ts pushStep); closed some other way, the step goes quietly.
 * `onBack` may say it stayed open (false, e.g. "discard your changes?" answered no): the next Back closes it again.
 */
export function useBackStep(onBack: () => void | boolean | Promise<void | boolean>, on = true) {
  const back = useRef(onBack)
  back.current = onBack
  const step = useRef<string | null>(null)
  const forget = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gone = useRef(false)
  useEffect(() => {
    if (!on) return
    gone.current = false
    // remounted at once (React's dev check): the same step stays
    if (forget.current) clearTimeout(forget.current), (forget.current = null)
    else if (!step.current) {
      const run = () => {
        step.current = null
        void Promise.resolve(back.current()).then((closed) => {
          // still open (and still here): the step again
          if (closed === false && !gone.current && !step.current) step.current = pushStep(run)
        })
      }
      step.current = pushStep(run)
    }
    return () => {
      forget.current = setTimeout(() => {
        forget.current = null
        gone.current = true
        if (step.current) forgetStep(step.current)
        step.current = null
      }, 0)
    }
  }, [on])
}
