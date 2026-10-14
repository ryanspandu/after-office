import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Answer buttons (approve, reject, an option): while the answer is on its way to the server every button in here is
 * disabled, and the one pressed spins. A slow server shows something is happening, and nobody answers twice. It adds
 * no box of its own (styles/controls.css .busy-set): the buttons lay out as they did.
 */
export function Busy({ busy, children }: { busy: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  // done (or failed): no spinner left behind
  useEffect(() => {
    if (!busy) set.current?.querySelectorAll('[data-busy]').forEach((b) => b.removeAttribute('data-busy'))
  }, [busy])
  return (
    <fieldset
      ref={set}
      className="busy-set"
      disabled={busy}
      // the button pressed: the one that spins (any other one marked before lets go)
      onClickCapture={(e) => {
        const b = (e.target as HTMLElement).closest('button')
        if (!b || busy) return
        set.current?.querySelectorAll('[data-busy]').forEach((x) => x.removeAttribute('data-busy'))
        b.setAttribute('data-busy', '')
      }}
    >
      {children}
    </fieldset>
  )
}
