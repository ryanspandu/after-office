// Phones: a text field brings the keyboard on the first tap. A select you can search (react-select) takes two: the
// first tap opens its options with no keyboard over them, a second one brings the keyboard to search. A field focused
// on its own (a window's first field) doesn't bring the keyboard either until it's tapped. Done with inputmode="none"
// while a field is only selected.

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])
const COARSE = '(hover: none) and (pointer: coarse)'

type Field = HTMLInputElement | HTMLTextAreaElement

function textField(t: EventTarget | null): Field | null {
  if (t instanceof HTMLTextAreaElement) return t.readOnly || t.disabled ? null : t
  if (t instanceof HTMLInputElement && TEXT_TYPES.has(t.type) && !t.readOnly && !t.disabled) return t
  return null
}

/** Selected without a keyboard: the field's own inputmode is kept here to put back. */
const KEPT = 'aoInputmode'

function quiet(el: Field) {
  if (el.dataset[KEPT] !== undefined) return
  el.dataset[KEPT] = el.getAttribute('inputmode') ?? ''
  el.setAttribute('inputmode', 'none')
}

function restore(el: Field) {
  const kept = el.dataset[KEPT]
  if (kept === undefined) return
  delete el.dataset[KEPT]
  if (kept) el.setAttribute('inputmode', kept)
  else el.removeAttribute('inputmode')
}

export function tapToType() {
  if (typeof window === 'undefined' || !window.matchMedia(COARSE).matches) return
  // fields the owner asked to type in (a tap on a text field, the second tap on a select): their keyboard stays until
  // they leave the field
  const typing = new WeakSet<Field>()
  const inSelect = (el: Element) => !!el.closest('.rs__control')
  // before the tap focuses it: a select's search field without a keyboard; any other text field with one, right away
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = textField(e.target)
      if (!el || document.activeElement === el) return
      if (inSelect(el)) quiet(el)
      else typing.add(el)
    },
    true,
  )
  let toggling = false
  // focused some other way (a window's first field): no keyboard either
  document.addEventListener(
    'focusin',
    (e) => {
      const el = textField(e.target)
      if (el && !typing.has(el)) quiet(el)
    },
    true,
  )
  /** The keyboard, now: blur + focus inside the tap (that's what makes a phone show it). The page never sees that
   *  blur and focus (a select would close its menu, a field would save on blur). */
  const keyboard = (el: Field) => {
    typing.add(el)
    restore(el)
    toggling = true
    el.blur()
    el.focus()
    toggling = false
  }
  const waiting = (el: Field | null): el is Field => !!el && document.activeElement === el && el.dataset[KEPT] !== undefined && !justFocused.has(el)
  for (const type of ['focusin', 'focusout'])
    window.addEventListener(type, (e) => toggling && e.stopImmediatePropagation(), true)

  // tapped again while selected: the keyboard
  document.addEventListener(
    'click',
    (e) => {
      const el = textField(e.target)
      if (waiting(el)) keyboard(el)
    },
    true,
  )
  // a select you can search (react-select): its touch ends the tap itself (no click follows), and a tap anywhere on
  // it counts, not only on its small text field. With its options open they stay open while the keyboard comes up.
  document.addEventListener(
    'touchend',
    (e) => {
      const control = (e.target as Element | null)?.closest?.('.rs__control')
      const el = textField(control?.querySelector('input') ?? null)
      if (!control || !waiting(el)) return
      const open = el.getAttribute('aria-expanded') === 'true'
      keyboard(el)
      if (open) {
        e.stopPropagation()
        e.preventDefault()
      }
    },
    { capture: true, passive: false },
  )
  // the click of the tap that focused it isn't the second tap
  const justFocused = new WeakSet<Field>()
  document.addEventListener(
    'focusin',
    (e) => {
      const el = textField(e.target)
      if (!el) return
      justFocused.add(el)
      setTimeout(() => justFocused.delete(el), 400)
    },
    true,
  )
  // left the field: as it was (the blur inside our own blur + focus doesn't count)
  document.addEventListener(
    'focusout',
    (e) => {
      const el = textField(e.target)
      if (!el || toggling) return
      typing.delete(el)
      restore(el)
    },
    true,
  )
}
