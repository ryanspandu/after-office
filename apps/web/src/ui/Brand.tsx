import { DEFAULT_LOGO, useBranding } from '../state/branding'

/**
 * Logo + name, with a line under it (the navbar's tagline, or the sign-in page's own). Until the office's branding is
 * read, a skeleton: never After Office's own name and logo flashing before the real ones.
 */
export function Brand({ sub }: { sub?: string }) {
  const { name, tagline, logo, loaded } = useBranding()
  if (!loaded)
    return (
      <>
        <span className="brand__logo skeleton" aria-hidden />
        <div className="brand__skeleton" aria-label="Loading">
          <span className="skeleton skeleton--line" style={{ width: 96 }} />
          <span className="skeleton skeleton--line skeleton--sm" style={{ width: 132 }} />
        </div>
      </>
    )
  return (
    <>
      <img className="brand__logo" src={logo ?? DEFAULT_LOGO} alt="" width={32} height={32} />
      <div>
        <b>{name}</b>
        <span className={sub ? 'muted' : 'brand__sub'}>{sub ?? tagline}</span>
      </div>
    </>
  )
}
