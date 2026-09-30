/**
 * Where to put a popover under its button: left-aligned with the button, or right-aligned when it would run off
 * the screen (e.g. the button sits on the right on a phone). Uses the popover's real width.
 */
export function placePopover(button: HTMLElement, pop: HTMLElement | null, margin = 12) {
  const r = button.getBoundingClientRect()
  const width = pop?.offsetWidth ?? 0
  const vw = document.documentElement.clientWidth
  const fitsLeftAligned = r.left + width <= vw - margin
  const left = fitsLeftAligned ? r.left : r.right - width
  return {
    top: r.bottom + 8,
    left: Math.max(margin, Math.min(left, vw - width - margin)),
    transformOrigin: fitsLeftAligned ? 'top left' : 'top right',
  }
}
