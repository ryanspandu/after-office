import { useZoom } from '../scene/zoom'

/** The stage's zoom level, top left: how far in or out the view is (the town shows from CITY_SHOW out). */
export function ZoomBadge() {
  const zoom = useZoom((s) => s.zoom)
  if (!zoom) return null
  return (
    <span className="zoom-badge" aria-live="off" data-tip="Zoom level (scroll or pinch to change)">
      Zoom {zoom.toFixed(zoom < 10 ? 1 : 0)}
    </span>
  )
}
