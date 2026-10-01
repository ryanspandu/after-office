import { useEffect, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { MapControls, PerformanceMonitor } from '@react-three/drei'
import { useOffice } from '../state/store'
import { Agent } from './Agent'
import { Cat } from './Cat'
import { DayNight } from './DayNight'
import type { Layout } from './layout'
import { Room } from './Room'
import { StaticBatch } from './StaticBatch'
import { Lounge } from './furniture/Lounge'
import { MeetingRoom } from './furniture/MeetingRoom'
import { Pantry } from './furniture/Pantry'
import { Parking } from './Parking'
import { Workstation } from './furniture/Workstation'
import { useQuality, useRenderConfig } from './quality'
import { useLayout } from './useLayout'

/** How long after the office appears before the frame rate counts (see PerformanceMonitor below). */
const WARM_UP_MS = 8000

export function Office() {
  const agents = useOffice((s) => s.agents)
  const departing = useOffice((s) => s.departing)
  const select = useOffice((s) => s.select)
  const layout = useLayout()
  const { advanced, dpr, setDpr, setTier } = useQuality()
  const cfg = useRenderConfig()
  // fewer frames while nobody's looking: the window in the background, or untouched for a while
  const fps = usePace(cfg.fps)
  const throttled = fps < cfg.fps
  // The first seconds are always slow (shaders compile, the scene is built): judging the device then would lower
  // the resolution and drop to the low tier on almost every visit, a visible glitch. Start measuring once it settled.
  const [warm, setWarm] = useState(false)
  // The first frames (default canvas size before it's measured, the camera fitting itself, desks batching) are
  // hidden: the office fades in once it has settled, instead of jumping into place.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setWarm(true), WARM_UP_MS)
    return () => clearTimeout(t)
  }, [])
  const deskVersion = layout.desks
    .map((_, i) => {
      const a = agents.find((x) => x.desk === i)
      // who sits there (colours, the manager's plate), not what they're doing: everything that follows the status
      // (screen, LED, lamp) is kept out of the batch, so status changes don't rebuild the whole office
      return a ? `${a.look.shirt}:${a.kind ?? ''}` : '-'
    })
    .join(',')

  return (
    <Canvas
      className={`office-canvas${shown ? ' is-shown' : ''}`}
      orthographic
      shadows
      dpr={dpr}
      // frames on demand, paced by FrameCap (never every frame of a 120 Hz display)
      frameloop="demand"
      camera={{ position: [22, 20, 22], zoom: 38, near: -100, far: 200 }}
      onPointerMissed={() => select(null)}
      onCreated={(state) => {
        if (import.meta.env.DEV) Object.assign(window, { __office: state.get })
        // a few frames after the first one: sized, fitted and batched
        let frames = 0
        const tick = () => (++frames >= 4 ? setShown(true) : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
        setTimeout(() => setShown(true), 800) // never stay hidden (e.g. a background tab without frames)
      }}
    >
      {/* Adapt to a slow device, in at most two steps and never back up within a visit: every change of the pixel
          ratio clears the canvas (a visible flicker), so no ping-pong. 1) sustained slow frames: lowest pixel ratio of
          the tier; 2) still slow: the low tier (no real lights, no shadows, 30 fps). Both are remembered for the next
          visit (quality.ts), which then starts there instead of changing on screen. */}
      {/* judged against the frame cap (not the display's rate), and only while it runs at full pace */}
      {warm && !throttled && (
        <PerformanceMonitor
          ms={500}
          iterations={10}
          bounds={() => [cfg.fps * 0.7, cfg.fps * 2 + 10]}
          onDecline={() => {
            if (document.visibilityState !== 'visible') return
            if (dpr > cfg.dpr[0]) setDpr(cfg.dpr[0])
            else if (!advanced) setTier('low') // the user asked for advanced render: don't switch it off for them
          }}
        />
      )}
      <FrameCap fps={fps} />
      <DayNight layout={layout} />
      <FitCamera layout={layout} />
      <MapControls makeDefault enableRotate={false} minZoom={4} maxZoom={120} screenSpacePanning={false} target={center(layout)} />

      <Room layout={layout} />
      <Parking layout={layout} slots={agents.length + departing.length} />
      {/* desks are static except their screens, LEDs and lamps; rebuilt only when a desk's owner changes */}
      <StaticBatch version={deskVersion}>
        {layout.desks.map((at, i) => (
          <Workstation key={i} at={at} index={i} owner={agents.find((a) => a.desk === i)} />
        ))}
      </StaticBatch>
      <MeetingRoom />
      <Pantry />
      <Lounge />
      <Cat />
      {/* one list keyed by id, so a removed agent keeps its component (and position) while it walks out. The
          generation changes when an agent comes back after leaving, so it mounts fresh instead of reusing the
          component that already walked away. */}
      {[...agents.filter((a) => a.status !== 'offline' || a.lingering), ...departing].map((a) => (
        <Agent key={`${a.id}:${a.gen ?? 0}`} agent={a} leaving={departing.includes(a)} />
      ))}
    </Canvas>
  )
}

/** Middle of everything that's drawn: the building plus the parking lot and road in front of it. */
function bounds(layout: Layout) {
  const minX = Math.min(layout.floor.minX, layout.lot.minX)
  const maxX = Math.max(layout.floor.maxX, layout.lot.maxX)
  const minZ = layout.floor.minZ
  const maxZ = layout.lot.maxZ
  return { minX, maxX, minZ, maxZ }
}

function center(layout: Layout): [number, number, number] {
  const b = bounds(layout)
  return [(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2]
}

/** Zoom so the whole scene fits and keep the camera on the isometric diagonal from its center. */
function FitCamera({ layout }: { layout: Layout }) {
  const { camera, size } = useThree()
  const b = bounds(layout)
  // refit on a real resize or a new layout, not on a few pixels (a navbar line appearing): that kept resetting the
  // zoom the owner had set
  const last = useRef<{ w: number; h: number; key: string } | null>(null)
  useEffect(() => {
    const key = `${b.minX},${b.maxX},${b.minZ},${b.maxZ}`
    const prev = last.current
    if (prev && prev.key === key && Math.abs(prev.w - size.width) < 32 && Math.abs(prev.h - size.height) < 32) return
    last.current = { w: size.width, h: size.height, key }
    const [cx, , cz] = center(layout)
    const span = b.maxX - b.minX + (b.maxZ - b.minZ)
    // isometric footprint: width ≈ span·cos45°, height ≈ span·sin45°·sin35° + wall height
    const byWidth = size.width / (span * 0.72)
    const byHeight = size.height / (span * 0.42 + 3)
    // a tall stage (a phone held upright): fitting the width leaves the office a small strip in the middle, so fill
    // the height instead and let the sides run off (it pans)
    const portrait = size.height > size.width * 1.2
    camera.zoom = Math.max(4, portrait ? byHeight * 0.95 : Math.min(byWidth, byHeight))
    camera.position.set(cx + 22, 20, cz + 22)
    camera.lookAt(cx, 0, cz)
    camera.updateProjectionMatrix()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, size.width, size.height, b.minX, b.maxX, b.minZ, b.maxZ])
  return null
}

/** Render at most `fps` frames a second (the canvas runs on demand; this asks for frames). 0: none. */
function FrameCap({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (!fps) return
    const id = setInterval(() => invalidate(), 1000 / fps)
    return () => clearInterval(id)
  }, [fps, invalidate])
  return null
}

/** Frames per second while the window isn't focused, and after IDLE_MS without a touch, key or mouse move. */
const UNFOCUSED_FPS = 8
const IDLE_FPS = 15
const IDLE_MS = 2 * 60_000

/**
 * The frame rate to run at: the tier's cap while someone's using the dashboard; fewer frames with the window in the
 * background or nobody touching it for a while; none while it's hidden. Back to full pace on the next move.
 */
function usePace(cap: number) {
  const [state, setState] = useState<'active' | 'idle' | 'unfocused' | 'hidden'>('active')
  useEffect(() => {
    let last = Date.now()
    const judge = () =>
      setState(
        document.visibilityState !== 'visible' ? 'hidden' : !document.hasFocus() ? 'unfocused' : Date.now() - last > IDLE_MS ? 'idle' : 'active',
      )
    const touched = () => {
      last = Date.now()
      setState((s) => (s === 'idle' ? 'active' : s))
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const e of events) window.addEventListener(e, touched, { passive: true })
    window.addEventListener('focus', judge)
    window.addEventListener('blur', judge)
    document.addEventListener('visibilitychange', judge)
    const id = setInterval(judge, 5_000)
    judge()
    return () => {
      for (const e of events) window.removeEventListener(e, touched)
      window.removeEventListener('focus', judge)
      window.removeEventListener('blur', judge)
      document.removeEventListener('visibilitychange', judge)
      clearInterval(id)
    }
  }, [])
  return state === 'hidden' ? 0 : state === 'unfocused' ? Math.min(cap, UNFOCUSED_FPS) : state === 'idle' ? Math.min(cap, IDLE_FPS) : cap
}
