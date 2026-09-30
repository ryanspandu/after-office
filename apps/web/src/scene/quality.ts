import { create } from 'zustand'

// Render quality.
//   low      phones, or any device that can't keep up (PerformanceMonitor in Office.tsx drops to it)
//   high     desktops (the default)
//   advanced opt-in "Advanced render" switch on the 3D stage: every lamp is a real light, big shadows
// Real point lights are the expensive part: each one is evaluated on every pixel. The cheaper tiers light the
// floor with painted "light pools" instead.

export type Tier = 'high' | 'low'

export interface TierConfig {
  /** real point lights following working agents' desks (all active desks also get floor light pools) */
  deskLights: number
  /** which of DayNight's fixed lamps are real lights: none, the few marked `real`, or all of them */
  fixedLights: 'none' | 'key' | 'all'
  /** sun shadow map size; 0 = no shadows */
  shadowMap: number
  /** device pixel ratio range; PerformanceMonitor moves within it */
  dpr: [number, number]
  /** frame cap; 0 = every display frame */
  fps: number
  /** extra night ambience to make up for fewer real lights */
  nightBoost: number
}

export const TIERS: Record<Tier | 'advanced', TierConfig> = {
  advanced: { deskLights: 12, fixedLights: 'all', shadowMap: 4096, dpr: [1, 2], fps: 0, nightBoost: 0 },
  high: { deskLights: 4, fixedLights: 'key', shadowMap: 2048, dpr: [1, 2], fps: 0, nightBoost: 0.25 },
  low: { deskLights: 0, fixedLights: 'none', shadowMap: 0, dpr: [1, 1.5], fps: 30, nightBoost: 0.4 },
}

const ADVANCED_KEY = 'after-office:advanced-render'
/** What this device settled on last time (tier + pixel ratio), so a new visit starts there instead of adjusting on screen. */
const SETTLED_KEY = 'after-office:render-settled'
/** A device that fell back to the low tier gets another chance at high after a week. */
const LOW_TIER_TTL_MS = 7 * 24 * 60 * 60_000

type Settled = { tier?: Tier; lowAt?: number; dpr?: number }

function loadSettled(): Settled {
  try {
    return JSON.parse(localStorage.getItem(SETTLED_KEY) ?? '{}') as Settled
  } catch {
    return {}
  }
}

function saveSettled(patch: Settled) {
  try {
    localStorage.setItem(SETTLED_KEY, JSON.stringify({ ...loadSettled(), ...patch }))
  } catch {
    // private mode: not remembered
  }
}

function initialTier(): Tier {
  if (typeof window === 'undefined') return 'high'
  const phone = window.matchMedia('(max-width: 768px)').matches || window.matchMedia('(pointer: coarse)').matches
  if (phone) return 'low'
  const s = loadSettled()
  return s.tier === 'low' && s.lowAt && Date.now() - s.lowAt < LOW_TIER_TTL_MS ? 'low' : 'high'
}

function initialDpr(tier: Tier) {
  const [lo, hi] = TIERS[tier].dpr
  const device = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const settled = loadSettled().dpr
  return Math.min(hi, device, Math.max(lo, settled ?? hi))
}

function loadAdvanced() {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1'
  } catch {
    return false
  }
}

interface QualityStore {
  /** automatic tier for this device */
  tier: Tier
  /** the user's "Advanced render" switch (off by default, remembered per browser) */
  advanced: boolean
  /** current pixel ratio (adapted between the active config's bounds) */
  dpr: number
  setTier: (tier: Tier) => void
  setAdvanced: (on: boolean) => void
  setDpr: (dpr: number) => void
}

export const useQuality = create<QualityStore>((set) => {
  const tier = initialTier()
  return {
    tier,
    advanced: loadAdvanced(),
    dpr: initialDpr(tier),
    setTier: (tier) => {
      saveSettled(tier === 'low' ? { tier, lowAt: Date.now(), dpr: TIERS.low.dpr[0] } : { tier })
      set({ tier, dpr: TIERS[tier].dpr[0] })
    },
    setAdvanced: (advanced) => {
      try {
        localStorage.setItem(ADVANCED_KEY, advanced ? '1' : '0')
      } catch {
        // private mode: just not remembered
      }
      set({ advanced })
    },
    setDpr: (dpr) => {
      saveSettled({ dpr })
      set({ dpr })
    },
  }
})

/** The config in effect: the switch wins over the automatic tier. */
export function useRenderConfig() {
  const advanced = useQuality((s) => s.advanced)
  const tier = useQuality((s) => s.tier)
  return advanced ? TIERS.advanced : TIERS[tier]
}

if (import.meta.env.DEV) Object.assign(window, { __quality: useQuality })
