import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, CanvasTexture, Color, MeshStandardMaterial, SRGBColorSpace, type DirectionalLight, type HemisphereLight, type MeshBasicMaterial, type Mesh, type PointLight } from 'three'
import { useDaylight } from '../state/clock'
import { headlight, taillight } from './Vehicle'
import { useOffice } from '../state/store'
import { streetLampLights } from './Parking'
import { DESK_LAMP, deskPos, LOUNGE, MEETING_PENDANTS, PANTRY, type Layout } from './layout'
import { useRenderConfig } from './quality'

// Lighting that follows the office clock. Day: warm sun through the windows. Night: dark blue ambience, the
// room lit only by its own lamps (desk lamps, pendants, floor lamp) and glowing monitors.

/** Live day/night mix other scene parts read each frame (0 = day, 1 = night). */
export const env = { night: 0 }

/** Shared by every window pane so the sky tint changes in one place. */
export const windowGlass = new MeshStandardMaterial({ color: '#bfe3f5', emissive: new Color('#a9dcf5'), emissiveIntensity: 0.35, roughness: 0.3 })

/** Shared by every lamp bulb/shade interior: glows at night. */
export const lampBulb = new MeshStandardMaterial({ color: '#fff4dc', emissive: new Color('#ffcf8a'), emissiveIntensity: 0.1, toneMapped: false })

// animated every frame by DayNight: StaticBatch keeps meshes that use them on these exact instances
windowGlass.userData.live = true
lampBulb.userData.live = true

const SKY_DAY = new Color('#bfe3f5')
const SKY_NIGHT = new Color('#0e1528')
const GLOW_DAY = new Color('#a9dcf5')
const GLOW_NIGHT = new Color('#1c2a55')
const SUN_DAY = new Color('#fff1dc')
const MOON = new Color('#a3b3ff')
const HEMI_SKY_DAY = new Color('#fff6e8')
const HEMI_SKY_NIGHT = new Color('#8591c9')
const HEMI_GROUND_DAY = new Color('#b7a48f')
const HEMI_GROUND_NIGHT = new Color('#3a3342')

interface Lamp {
  pos: [number, number, number]
  power: number
  distance: number
  /** worth a real point light on capable devices; the others only get a light pool on the floor */
  real?: boolean
}

const FIXED_LAMPS: Lamp[] = [
  ...MEETING_PENDANTS.map(([x, z], i): Lamp => ({ pos: [x, 1.65, z], power: 6, distance: 5.5, real: i === Math.floor(MEETING_PENDANTS.length / 2) })),
  { pos: [LOUNGE.billiards.x, 1.5, LOUNGE.billiards.z], power: 6, distance: 5, real: true },
  { pos: [LOUNGE.floorLamp[0] + 0.3, 1.6, LOUNGE.floorLamp[1] - 0.3], power: 5.5, distance: 5.5, real: true },
  { pos: [LOUNGE.tv.x, 1.4, LOUNGE.tv.z + 0.8], power: 2.5, distance: 4 },
  { pos: [LOUNGE.catPlay[0], 2.2, LOUNGE.catPlay[1]], power: 3.5, distance: 5 },
  { pos: [PANTRY.table.x, 1.6, PANTRY.table.z], power: 6, distance: 5, real: true },
  { pos: [PANTRY.counter.x, 1.8, PANTRY.counter.z + 0.8], power: 4, distance: 4.5 },
]

/** Soft round glow for fake "light pools" painted on the floor (additive, so it brightens what's under it). */
export const poolTexture = (() => {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
})()

const POOL_COLOR = new Color('#ffc47a')
const DESK_COLOR = new Color('#ffd79a')
const WAIT_COLOR = new Color('#ffb070')

/** A light pool on the floor: looks like lamp light hitting the ground, costs one cheap transparent quad. */
function LightPool({ at, radius, meshRef }: { at: [number, number, number]; radius: number; meshRef: (m: Mesh | null) => void }) {
  return (
    <mesh ref={meshRef} position={at} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
      <planeGeometry args={[radius * 2, radius * 2]} />
      <meshBasicMaterial map={poolTexture} color={POOL_COLOR} transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
  )
}

/** Desk lights are a fixed pool moved each frame onto desks whose agent is working (no shader recompiles). */
const DESK_POOL = 12

export function DayNight({ layout }: { layout: Layout }) {
  const target = useDaylight()
  const cfg = useRenderConfig()
  const lampsList = useMemo<Lamp[]>(
    () => [...FIXED_LAMPS, ...streetLampLights(layout).map((pos): Lamp => ({ pos, power: 5, distance: 7 }))],
    [layout],
  )
  const deskPool = useRef<(PointLight | null)[]>([])
  const current = useRef(target)
  const sun = useRef<DirectionalLight>(null!)
  const hemi = useRef<HemisphereLight>(null!)
  const lamps = useRef<(PointLight | null)[]>([])
  // which lamps get a real light (fixed per tier, so the light count and shaders stay stable)
  const isReal = (l: Lamp) => cfg.fixedLights === 'all' || (cfg.fixedLights === 'key' && !!l.real)
  const realLamps = useMemo(() => lampsList.filter(isReal), [lampsList, cfg.fixedLights]) // eslint-disable-line react-hooks/exhaustive-deps
  const pooledLamps = useMemo(() => lampsList.filter((l) => !isReal(l)), [lampsList, cfg.fixedLights]) // eslint-disable-line react-hooks/exhaustive-deps
  const pools = useRef<(Mesh | null)[]>([])
  const deskPools = useRef<(Mesh | null)[]>([])
  // aim the sun at the middle of the floor and size its shadow box to the (growing) office
  const cx = (Math.min(layout.floor.minX, layout.lot.minX) + Math.max(layout.floor.maxX, layout.lot.maxX)) / 2
  const half = (Math.max(layout.floor.maxX, layout.lot.maxX) - Math.min(layout.floor.minX, layout.lot.minX)) / 2 + 6

  useFrame((_, dt) => {
    // ease toward the target so switching modes fades instead of snapping
    current.current += (target - current.current) * Math.min(1, dt * 2)
    const d = current.current
    env.night = 1 - d
    sun.current.target.position.set(cx, 0, 4)
    sun.current.target.updateMatrixWorld()
    sun.current.intensity = 0.45 + d * 1.45
    sun.current.color.lerpColors(MOON, SUN_DAY, d)
    hemi.current.intensity = 0.55 + d * 0.57 + env.night * cfg.nightBoost
    hemi.current.color.lerpColors(HEMI_SKY_NIGHT, HEMI_SKY_DAY, d)
    hemi.current.groundColor.lerpColors(HEMI_GROUND_NIGHT, HEMI_GROUND_DAY, d)
    windowGlass.color.lerpColors(SKY_NIGHT, SKY_DAY, d)
    windowGlass.emissive.lerpColors(GLOW_NIGHT, GLOW_DAY, d)
    lampBulb.emissiveIntensity = 0.1 + env.night * 2.4
    headlight.emissiveIntensity = 0.2 + env.night * 2.5
    taillight.emissiveIntensity = 0.3 + env.night * 1.5
    lamps.current.forEach((l, i) => l && realLamps[i] && (l.intensity = env.night * realLamps[i].power))
    pools.current.forEach((m, i) => {
      if (!m || !pooledLamps[i]) return
      const o = env.night * Math.min(0.85, pooledLamps[i].power * 0.13)
      ;(m.material as MeshBasicMaterial).opacity = o
      m.visible = o > 0.004 // invisible pools still cost a draw call

    })

    // light the desks of agents who are at work right now
    const active = useOffice.getState().agents.filter((a) => a.status === 'working' || a.status === 'waiting')
    deskPool.current.forEach((l, i) => {
      if (!l) return
      const a = active[i]
      if (!a) return void (l.intensity = 0)
      const [x, z] = deskPos(a.desk)
      l.position.set(x + DESK_LAMP[0] - 0.2, 1.35, z + 0.45)
      l.intensity = env.night * (a.status === 'waiting' ? 3 : 3.6)
      l.color.set(a.status === 'waiting' ? '#ffb070' : '#ffd79a')
    })
    // every working desk also gets a pool of light on the floor (the only desk light on low-end devices)
    deskPools.current.forEach((m, i) => {
      if (!m) return
      const a = active[i]
      const mat = m.material as MeshBasicMaterial
      if (!a) return void (m.visible = false)
      const [x, z] = deskPos(a.desk)
      m.position.set(x + DESK_LAMP[0] - 0.2, 0.05, z + 0.55)
      mat.color.copy(a.status === 'waiting' ? WAIT_COLOR : DESK_COLOR)
      mat.opacity = env.night * (i < cfg.deskLights ? 0.25 : 0.75)
      m.visible = mat.opacity > 0.004
    })
  })

  return (
    <>
      <hemisphereLight ref={hemi} args={['#fff6e8', '#b7a48f', 1.1]} />
      <directionalLight
        key={`${layout.cols}:${cfg.shadowMap}`}
        ref={sun}
        position={[cx + 10, 18, 8]}
        intensity={1.9}
        color="#fff1dc"
        castShadow={cfg.shadowMap > 0}
        shadow-mapSize={[cfg.shadowMap || 1024, cfg.shadowMap || 1024]}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
      />
      {Array.from({ length: cfg.deskLights }, (_, i) => (
        <pointLight key={`desk${i}`} ref={(p) => void (deskPool.current[i] = p)} intensity={0} distance={3.6} decay={1.3} />
      ))}
      {Array.from({ length: DESK_POOL }, (_, i) => (
        <LightPool key={`deskpool${i}`} at={[0, 0.05, 0]} radius={1.7} meshRef={(m) => void (deskPools.current[i] = m)} />
      ))}
      {pooledLamps.map((l, i) => (
        <LightPool key={`pool${i}`} at={[l.pos[0], 0.05, l.pos[2]]} radius={l.distance * 0.65} meshRef={(m) => void (pools.current[i] = m)} />
      ))}
      {realLamps.map((l, i) => (
        <pointLight
          key={i}
          ref={(p) => void (lamps.current[i] = p)}
          position={l.pos}
          color="#ffc47a"
          intensity={0}
          distance={l.distance}
          decay={1.4}
        />
      ))}
    </>
  )
}
