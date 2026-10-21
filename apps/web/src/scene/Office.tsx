import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { MapControls, PerformanceMonitor } from '@react-three/drei'
import { MathUtils, Spherical, Vector3 } from 'three'
import { agentWorld, useView } from './focus'
import { useMediaQuery } from '../state/useMediaQuery'
import { useZoom } from './zoom'
import { isAway, useOffice } from '../state/store'
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
import { MEETING, openPlanCenter } from './layout'
import { BossOffice } from './furniture/BossOffice'
import { Outline } from './Outline'
import { City } from './City'
import { WorkCorner } from './furniture/WorkCorner'
import { useQuality, useRenderConfig } from './quality'
import { useLayout } from './useLayout'

/** How long after the office appears before the frame rate counts (see PerformanceMonitor below). */
const WARM_UP_MS = 8000

export function Office() {
  const agents = useOffice((s) => s.agents)
  const departing = useOffice((s) => s.departing)
  // asleep, not in the office: out in town (a seat at the café, a ride round the streets: scene/outings.ts), unless
  // it's still on its way out (then it's drawn from `departing`)
  const outInTown = useMemo(() => agents.filter((a) => a.status === 'asleep' && !a.lingering && !departing.some((d) => d.id === a.id)), [agents, departing])
  const select = useOffice((s) => s.select)
  const layout = useLayout()
  const { advanced, dpr, setDpr, setTier } = useQuality()
  // a touch screen (no mouse): two fingers do one thing at a time there
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)')
  const pinch = useView((s) => s.pinch)
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

  // now and then an idle manager gets up and goes elsewhere (mostly within its office): every 2–4 minutes
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const next = () => {
      t = setTimeout(() => (useOffice.getState().changeOfScene(), next()), 120_000 + Math.random() * 120_000)
    }
    next()
    return () => clearTimeout(t)
  }, [])

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
            // the user asked for advanced render: neither its resolution (a blurred office) nor the render itself is
            // lowered for them
            if (advanced) return
            if (dpr > cfg.dpr[0]) setDpr(cfg.dpr[0])
            else setTier('low')
          }}
        />
      )}
      <FrameCap fps={fps} />
      {/* draws each frame: the office, then its dark outlines (scene/Outline.tsx) */}
      <Outline />
      <DayNight layout={layout} />
      <FitCamera layout={layout} />
      {/* drag pans; right-drag (two fingers on a phone) turns the view around the office and tilts it, from nearly
          straight down to nearly level with the floor (never under it) */}
      {/* phones: two fingers either zoom or turn, not both at once (the camera buttons switch, ui/FocusCard.tsx) */}
      <MapControls
        makeDefault
        minZoom={4}
        maxZoom={180}
        screenSpacePanning={false}
        minPolarAngle={MIN_POLAR}
        maxPolarAngle={MAX_POLAR}
        rotateSpeed={0.6}
        enableZoom={!touch || pinch === 'zoom'}
        enableRotate={!touch || pinch === 'turn'}
      />
      <FocusCamera />
      <NudgeCamera />
      <LabelDetail />
      <ZoomProbe />

      <Room layout={layout} />
      <Parking layout={layout} slots={agents.length + departing.length} />
      {/* the town around it: roads, office blocks, the coffee shop and the warung across the road */}
      <City layout={layout} />
      {/* desks are static except their screens, LEDs and lamps; rebuilt only when a desk's owner changes */}
      <StaticBatch version={deskVersion}>
        {layout.desks.map((at, i) => (
          // the manager works in its own office (below): its open-plan desk stays free
          <Workstation key={i} at={at} index={i} owner={agents.find((a) => a.desk === i && a.kind !== 'manager')} />
        ))}
      </StaticBatch>
      <BossOffice room={layout.boss} manager={agents.find((a) => a.kind === 'manager')} />
      <MeetingRoom />
      <Pantry />
      <WorkCorner />
      <Lounge />
      <Cat />
      {/* one list keyed by id, so a removed agent keeps its component (and position) while it walks out. The
          generation changes when an agent comes back after leaving, so it mounts fresh instead of reusing the
          component that already walked away. */}
      {[...agents.filter((a) => !isAway(a.status) || a.lingering), ...departing, ...outInTown].map((a) => (
        <Agent key={`${a.id}:${a.gen ?? 0}`} agent={a} leaving={departing.includes(a)} out={outInTown.includes(a)} />
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

/**
 * Where the camera looks to start with. A wide screen: the open plan, a little towards the back wall and the manager's
 * office (the sign on the wall and the manager in view). A phone: the corner by the meeting room's glass, between the
 * open plan's last desks and the TV lounge (the sign above; it stays put when the open plan grows to the left).
 */
function center(layout: Layout, wide = false): [number, number, number] {
  const [x, z] = openPlanCenter(layout)
  return wide ? [x - 2, 0, z - 1.5] : [MEETING.bounds.minX - 0.5, 0, -0.3]
}

/** How much of the office the start view shows across the stage, in metres: close, the people big enough to read. */
const START_SPAN = { wide: 22, tall: 8 }
/** The start view's angle from straight down (radians): looking across the room rather than down onto it; a little
 *  higher on a wide screen (the whole floor in view), lower on a phone (close on the desks). */
const START_POLAR = { wide: 1.02, tall: 1.15 }
const START_DIST = 30

/** Zoom so the whole scene fits and keep the camera on the isometric diagonal from its center. */
function FitCamera({ layout }: { layout: Layout }) {
  const { camera, size } = useThree()
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3; update: () => void } | null
  const b = bounds(layout)
  // Refit on a new layout or a real change of width (a rotated phone, a resized window), never on height alone: on a
  // phone the height changes all the time (the keyboard of a modal's field, the browser bar, a sheet) and refitting
  // then threw away the owner's pan and zoom. A stage hidden or collapsed for a moment (a few px) is ignored too.
  const last = useRef<{ w: number; key: string; reset: number; controls: boolean } | null>(null)
  // "back to the whole office" (the view button): the start view again, whatever was turned or zoomed
  const resetAt = useView((s) => s.resetAt)
  useEffect(() => {
    if (size.width < 80 || size.height < 80) return
    const key = `${b.minX},${b.maxX},${b.minZ},${b.maxZ}`
    const prev = last.current
    // (and once more when the controls arrive: fitted before them, they'd keep looking at the origin)
    if (prev && prev.key === key && Math.abs(prev.w - size.width) < 32 && prev.reset === resetAt && prev.controls === !!controls) return
    last.current = { w: size.width, key, reset: resetAt, controls: !!controls }
    // close in on the desks: about START_SPAN metres across (fewer on a phone held upright)
    const portrait = size.height > size.width * 1.2
    const [cx, , cz] = center(layout, !portrait)
    camera.zoom = MathUtils.clamp(size.width / (portrait ? START_SPAN.tall : START_SPAN.wide), 20, 140)
    // on the diagonal, low: looking across the room
    const polar = portrait ? START_POLAR.tall : START_POLAR.wide
    const flat = Math.sin(polar) * START_DIST * Math.SQRT1_2
    camera.position.set(cx + flat, Math.cos(polar) * START_DIST, cz + flat)
    camera.lookAt(cx, 0, cz)
    camera.updateProjectionMatrix()
    // the controls look at their own target: move it with the camera, or the next frame turns the camera from its
    // new place towards the old (panned) target, off the isometric diagonal: the "angle changes" glitch
    if (controls) {
      controls.target.set(cx, 0, cz)
      controls.update()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controls, size.width, size.height, b.minX, b.maxX, b.minZ, b.maxZ, resetAt])
  return null
}

/** Tells the stage the zoom level (ui/ZoomBadge.tsx), when it has changed by a tenth or more. */
function ZoomProbe() {
  useFrame(({ camera }) => {
    const z = Math.round(camera.zoom * 10) / 10
    if (z !== useZoom.getState().zoom) useZoom.setState({ zoom: z })
  })
  return null
}

/** Below this zoom the office is seen from afar: the name tags drop their "what they're doing" line (it piles up). */
const DETAIL_ZOOM = 42

/** Marks the label layer far/near as the camera zooms (scene/labels.tsx, styles/name-tags.css). */
function LabelDetail() {
  const far = useRef<boolean | null>(null)
  useFrame(({ camera }) => {
    const now = camera.zoom < DETAIL_ZOOM
    if (now === far.current) return
    far.current = now
    const el = document.querySelector<HTMLElement>('.labels')
    if (el) el.classList.toggle('labels--far', now)
  })
  return null
}

/** The stage's turn and zoom buttons: the camera turns around what it looks at, or zooms, smoothly. */
function NudgeCamera() {
  const nudge = useView((s) => s.nudge)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const left = useRef({ turn: 0, zoom: 0, tilt: 0 })
  const offset = useRef(new Vector3())
  const sphere = useRef(new Spherical())
  useEffect(() => {
    if (!nudge) return
    left.current.turn += nudge.turn
    left.current.tilt += nudge.tilt
    // zoom as a log, so in and out add up
    left.current.zoom += Math.log(nudge.zoom)
  }, [nudge])
  useFrame((_, rawDt) => {
    const l = left.current
    if (!controls || (Math.abs(l.turn) < 1e-4 && Math.abs(l.zoom) < 1e-4 && Math.abs(l.tilt) < 1e-4)) return
    const k = 1 - Math.exp(-7 * Math.min(rawDt, 0.05))
    const turn = l.turn * k
    const zoom = l.zoom * k
    const tilt = l.tilt * k
    l.turn -= turn
    l.zoom -= zoom
    l.tilt -= tilt
    const o = offset.current.copy(camera.position).sub(controls.target)
    o.applyAxisAngle(UP, turn)
    if (tilt) {
      const sph = sphere.current.setFromVector3(o)
      sph.phi = MathUtils.clamp(sph.phi + tilt, MIN_POLAR, MAX_POLAR)
      o.setFromSpherical(sph)
    }
    camera.position.copy(controls.target).add(o)
    camera.zoom = MathUtils.clamp(camera.zoom * Math.exp(zoom), 4, 180)
    camera.updateProjectionMatrix()
    controls.update()
  })
  return null
}
const UP = new Vector3(0, 1, 0)
/** How far the view tilts: from almost straight down to almost level with the floor (radians from straight down). */
const MIN_POLAR = 0.2
const MAX_POLAR = 1.45

/** How close the camera comes to a clicked agent (at least: closer if it already was). */
const FOCUS_ZOOM = 120

type Controls = { target: Vector3; update: () => void; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void }

/**
 * A clicked agent: the camera glides to it, comes close and keeps it in the middle while it walks around. Moving the
 * view by hand stops the following (the agent stays selected). Unselected: back to where the camera was before.
 */
function FocusCamera() {
  const selectedId = useOffice((s) => s.selectedId)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const dom = useThree((s) => s.gl.domElement)
  const st = useRef({ following: false, returning: false, zoomUntil: 0, saved: null as null | { target: Vector3; pos: Vector3; zoom: number } })
  const step = useRef(new Vector3())

  // the owner turning or moving the view: the reset button shows; a follow stops
  useEffect(() => {
    if (!controls) return
    // a press alone (clicking an agent) isn't moving the view: only a change while pressed is. The wheel's zoom
    // eases in over the next frames (damping), after its start/end: a change shortly after a wheel counts too.
    let pressed = false
    let wheeled = 0
    const start = () => (pressed = true)
    const end = () => (pressed = false)
    const wheel = () => (wheeled = performance.now())
    dom.addEventListener('wheel', wheel, { passive: true })
    const change = () => {
      if (!pressed && performance.now() - wheeled > 600) return
      st.current.following = false
      st.current.returning = false
      useView.getState().setMoved(true)
    }
    controls.addEventListener('start', start)
    controls.addEventListener('end', end)
    controls.addEventListener('change', change)
    return () => {
      controls.removeEventListener('start', start)
      controls.removeEventListener('end', end)
      controls.removeEventListener('change', change)
      dom.removeEventListener('wheel', wheel)
    }
  }, [controls, dom])

  useEffect(() => {
    const s = st.current
    if (!controls) return
    if (selectedId) {
      if (!s.saved) s.saved = { target: controls.target.clone(), pos: camera.position.clone(), zoom: camera.zoom }
      s.following = true
      s.returning = false
      s.zoomUntil = performance.now() + 1600
    } else if (s.saved) {
      s.following = false
      s.returning = true
    }
  }, [selectedId, controls, camera])
  // the start view asked for: nothing to go back to
  const resetAt = useView((s) => s.resetAt)
  useEffect(() => {
    st.current = { following: false, returning: false, zoomUntil: 0, saved: null }
  }, [resetAt])

  useFrame((_, rawDt) => {
    const s = st.current
    if (!controls || (!s.following && !s.returning)) return
    const dt = Math.min(rawDt, 0.05)
    const k = 1 - Math.exp(-5 * dt)
    if (s.following && selectedId) {
      const at = agentWorld.get(selectedId)
      if (!at) return
      // the target and the camera move together: the angle stays, only the place changes
      const d = step.current.copy(at).sub(controls.target).multiplyScalar(k)
      controls.target.add(d)
      camera.position.add(d)
      if (performance.now() < s.zoomUntil) camera.zoom = MathUtils.lerp(camera.zoom, Math.max(FOCUS_ZOOM, s.saved?.zoom ?? 0), k)
    } else if (s.returning && s.saved) {
      controls.target.lerp(s.saved.target, k)
      camera.position.lerp(s.saved.pos, k)
      camera.zoom = MathUtils.lerp(camera.zoom, s.saved.zoom, k)
      if (controls.target.distanceTo(s.saved.target) < 0.02 && Math.abs(camera.zoom - s.saved.zoom) < 0.2) {
        controls.target.copy(s.saved.target)
        camera.position.copy(s.saved.pos)
        camera.zoom = s.saved.zoom
        s.returning = false
        s.saved = null
      }
    }
    camera.updateProjectionMatrix()
    controls.update()
  })
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
