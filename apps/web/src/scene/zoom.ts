import { create } from 'zustand'

// The camera's zoom, for what's outside the 3D view (the stage's zoom level, ui/ZoomBadge.tsx). Written from the
// scene only when it changes enough to show (not every frame).

export const useZoom = create<{ zoom: number }>(() => ({ zoom: 0 }))

/**
 * The town (scene/City.tsx) is built only once the view is zoomed out past CITY_SHOW (at first only the office, its
 * car park and the cars are drawn), and hidden again closer in than CITY_HIDE (two values: no flicker at the edge).
 * The start view is closer than both (scene/Office.tsx clamps it to 20 at least).
 */
export const CITY_SHOW = 19
export const CITY_HIDE = 21
