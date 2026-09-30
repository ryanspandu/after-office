// On phones the on-screen keyboard covers the bottom of the page. Browsers that don't shrink the layout for it
// (the viewport meta asks them to: interactive-widget=resizes-content) still report the visible part through
// window.visualViewport. Its size and offset go into CSS variables, so fixed layers (drawers, modals) sit exactly
// above the keyboard instead of leaving a gap or hiding under it.

export function trackVisualViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement.style
  const update = () => {
    root.setProperty('--vvh', `${vv.height}px`)
    root.setProperty('--vvt', `${vv.offsetTop}px`)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
}
