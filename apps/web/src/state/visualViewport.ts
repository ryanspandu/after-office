// On phones the on-screen keyboard covers the bottom of the page. Browsers that don't shrink the layout for it
// (the viewport meta asks them to: interactive-widget=resizes-content) still report the visible part through
// window.visualViewport. Its size and offset go into CSS variables, so fixed layers (drawers, modals) sit exactly
// above the keyboard instead of leaving a gap or hiding under it.

export function trackVisualViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement.style
  // the keyboard is up: the visible height dropped well below the tallest seen (the page tightens up: html.kb-open)
  let tallest = vv.height
  let width = vv.width
  const update = () => {
    // turned sideways (or a resized window): start over
    if (Math.abs(vv.width - width) > 40) (tallest = vv.height), (width = vv.width)
    tallest = Math.max(tallest, vv.height)
    document.documentElement.classList.toggle('kb-open', vv.height < tallest * 0.75)
    root.setProperty('--vvh', `${vv.height}px`)
    root.setProperty('--vvt', `${vv.offsetTop}px`)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
}
