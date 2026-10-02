// Phones: a field takes two taps before the keyboard comes up. The first tap (or a field focused on its own when a
// window opens) only selects it: a select's options open, the caret is there, the screen stays as it was. Tapping it
// again, once it's selected, brings the keyboard. Done with inputmode="none" while it's only selected.

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
  // before the tap focuses it: no keyboard for this focus
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = textField(e.target)
      if (el && document.activeElement !== el) quiet(el)
    },
    true,
  )
  // fields the owner asked to type in (the second tap): their keyboard stays until they leave the field
  const typing = new WeakSet<Field>()
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
  // tapped again while selected: the keyboard (blur + focus inside the tap, so the phone shows it)
  document.addEventListener(
    'click',
    (e) => {
      const el = textField(e.target)
      if (!el || document.activeElement !== el || el.dataset[KEPT] === undefined || justFocused.has(el)) return
      typing.add(el)
      restore(el)
      toggling = true
      el.blur()
      el.focus()
      toggling = false
    },
    true,
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
