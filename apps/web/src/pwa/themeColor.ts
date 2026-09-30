// The browser / OS chrome colour (status bar on phones, title bar of the installed desktop app) follows the app's
// own light/dark switch, not only the system setting: both theme-color metas get the colour of the current theme.

export function syncThemeColor() {
  const apply = () => {
    // the app's surface (what sits right under the status bar), before the app mounts the page background
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || getComputedStyle(document.body).backgroundColor
    if (!bg) return
    for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = bg
  }
  apply()
  // the theme is applied as attributes/classes on <html>/<body>; the system setting can change too
  const watch = new MutationObserver(() => requestAnimationFrame(apply))
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  watch.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(apply))
}
