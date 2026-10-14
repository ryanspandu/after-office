import { DataTexture, NearestFilter, RedFormat, UnsignedByteType } from 'three'

// The office's look: flat colours lit in a few hard steps (toon shading), like a hand-drawn isometric game, with dark
// outlines drawn over everything afterwards (scene/Outline.tsx). Every material of the office's shapes (prims.tsx,
// and the merged batches of StaticBatch.tsx) shades with this ramp.

/** The light steps: shadowed, half lit, lit. Close together: the colours stay themselves, only the sides differ. */
const STEPS = [150, 205, 255]

/** The ramp a toon material reads its brightness from: one texel per step, never blended. */
export const toonRamp = (() => {
  const t = new DataTexture(new Uint8Array(STEPS), STEPS.length, 1, RedFormat, UnsignedByteType)
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
})()
