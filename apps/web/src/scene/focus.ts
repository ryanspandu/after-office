import { Vector3 } from 'three'
import { create } from 'zustand'

// The camera following a clicked agent (scene/Office.tsx FocusCamera), and the "back to the whole office" request.
// Agents write where they are each frame; the camera reads the selected one's place.

/** What each agent is doing with its body right now (its pose: 'walk', 'type', 'write'…), set every frame by
 *  scene/Agent.tsx: props that react to it (the whiteboard) only move while it's really there doing it. */
export const agentPose = new Map<string, string>()

/** Where each agent is (its chest), in world space, updated every frame by scene/Agent.tsx. */
export const agentWorld = new Map<string, Vector3>()

export function setAgentWorld(id: string, x: number, y: number, z: number) {
  const v = agentWorld.get(id)
  if (v) v.set(x, y, z)
  else agentWorld.set(id, new Vector3(x, y, z))
}

/** A turn or a zoom asked from the stage's buttons (ui/FocusCard.tsx ViewControls), played by scene/Office.tsx. */
export interface Nudge {
  at: number
  /** radians around the looked-at point (+ = counter-clockwise from above) */
  turn: number
  /** zoom multiplier */
  zoom: number
  /** radians down towards the floor (+) or up to the top view (−) */
  tilt: number
}

interface ViewState {
  nudge: Nudge | null
  turn: (radians: number) => void
  zoomBy: (factor: number) => void
  tilt: (radians: number) => void
  /** bumped to put the camera back on the whole office (the start view) */
  resetAt: number
  /** the camera was turned or moved away from the start view: the reset button shows */
  moved: boolean
  reset: () => void
  setMoved: (moved: boolean) => void
}

export const useView = create<ViewState>((set) => ({
  nudge: null,
  turn: (turn) => set({ nudge: { at: Date.now(), turn, zoom: 1, tilt: 0 }, moved: true }),
  zoomBy: (zoom) => set({ nudge: { at: Date.now(), turn: 0, zoom, tilt: 0 }, moved: true }),
  tilt: (tilt) => set({ nudge: { at: Date.now(), turn: 0, zoom: 1, tilt }, moved: true }),
  resetAt: 0,
  moved: false,
  reset: () => set({ resetAt: Date.now(), moved: false }),
  setMoved: (moved) => set((s) => (s.moved === moved ? s : { moved })),
}))
