import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, MathUtils, Vector3, type Group, type Mesh, type MeshBasicMaterial } from 'three'
import { useOffice, type Look, type OfficeAgent } from '../state/store'
import { doorPos, driveInRoute, ENTRANCE, slotPos, spotById, vehicleKind, walkInRoute, type SpotKind, type Vec2 } from './layout'
import { poolTexture } from './DayNight'
import { StaticBatch } from './StaticBatch'
import { Vehicle } from './Vehicle'
import { placeLabel } from './labels'
import { findPath } from './pathing'
import { useLayout } from './useLayout'
import { dampAngle } from './math'
import { Box, Cyl } from './prims'
import { STRIKE_AT, STROKE_PERIOD, strokeOffset } from './furniture/Lounge'

type Pose = 'stand' | 'walk' | 'type' | 'wait' | 'meeting' | 'sofa' | 'relax' | 'eat' | 'pet' | 'billiards' | 'read' | 'watch'

/** Joint angles a pose wants this frame. Characters face +z; negative X rotation swings limbs forward. */
interface Joints {
  rootY: number
  torsoX: number
  headX: number
  headY: number
  armL: number
  armR: number
  armLz: number
  armRz: number
  legL: number
  legR: number
  kneeL: number
  kneeR: number
  cue: number
}

const REST: Joints = { rootY: 0, torsoX: 0, headX: 0, headY: 0, armL: 0, armR: 0, armLz: 0.08, armRz: -0.08, legL: 0, legR: 0, kneeL: 0, kneeR: 0, cue: 0 }
const SIT = { rootY: -0.08, legL: -Math.PI / 2, legR: -Math.PI / 2, kneeL: Math.PI / 2, kneeR: Math.PI / 2 }

function poseJoints(pose: Pose, t: number, seed: number, spotId: string): Joints {
  switch (pose) {
    case 'walk': {
      const s = Math.sin(t * 9)
      return { ...REST, rootY: Math.abs(Math.cos(t * 9)) * 0.05, legL: s * 0.6, legR: -s * 0.6, kneeL: Math.max(0, s) * 0.5, kneeR: Math.max(0, -s) * 0.5, armL: -s * 0.55, armR: s * 0.55 }
    }
    case 'type':
      return {
        ...REST, ...SIT, torsoX: 0.12, headX: 0.15 + Math.sin(t * 2 + seed) * 0.04, headY: Math.sin(t * 0.7 + seed) * 0.12,
        armL: -1.3 + Math.sin(t * 17 + seed) * 0.09, armR: -1.3 + Math.sin(t * 17 + seed + Math.PI) * 0.09, armLz: 0.15, armRz: -0.15,
      }
    case 'wait': {
      // looking around, scratching head
      const scratch = Math.sin(t * 10) * 0.08
      return { ...REST, ...SIT, torsoX: -0.05, headX: -0.12, headY: Math.sin(t * 1.4 + seed) * 0.5, armL: -0.5, armR: -2.7 + scratch, armRz: -0.5 }
    }
    case 'meeting': {
      const gesture = Math.max(0, Math.sin(t * 1.1 + seed * 3)) ** 3
      return { ...REST, ...SIT, torsoX: 0.05, headX: Math.sin(t * 3 + seed) * 0.07, headY: Math.sin(t * 0.5 + seed) * 0.35, armL: -1.05, armR: -1.05 - gesture * 0.9, armRz: -0.1 - gesture * 0.3 }
    }
    case 'sofa':
    case 'relax':
      return { ...REST, ...SIT, rootY: -0.12, torsoX: -0.25, headX: -0.15 + Math.sin(t * 0.8 + seed) * 0.05, headY: Math.sin(t * 0.3 + seed) * 0.3, armL: -0.4, armR: -1.9, armRz: 0.25 }
    case 'eat': {
      // sipping / snacking: right hand up to the mouth every few seconds
      const bite = Math.max(0, Math.sin(t * 1.4 + seed * 2)) ** 2
      return { ...REST, ...SIT, torsoX: 0.1, headX: 0.05 - bite * 0.15, headY: Math.sin(t * 0.4 + seed) * 0.3, armL: -1.0, armR: -0.9 - bite * 1.5, armRz: -0.1 - bite * 0.35 }
    }
    case 'pet': {
      const stroke = Math.sin(t * 3.5 + seed)
      return { ...REST, rootY: -0.24, torsoX: 0.5, headX: 0.35, headY: Math.sin(t * 0.9) * 0.15, legL: -1.15, kneeL: 2.1, legR: -0.35, kneeR: 1.6, armL: -0.3, armR: -0.8 + stroke * 0.3, armRz: -0.05 }
    }
    case 'billiards': {
      // slow pull back, then a snappy shot at STRIKE_AT
      const phase = (t + strokeOffset(spotId)) % STROKE_PERIOD
      const cue = phase < STRIKE_AT ? -(phase / STRIKE_AT) * 0.25 : Math.min(0.12, -0.25 + ((phase - STRIKE_AT) / 0.08) * 0.37)
      return { ...REST, torsoX: 0.75, headX: -0.55, legL: -0.25, legR: 0.25, armL: -1.35, armLz: 0.25, armR: -0.75 + cue * 2, armRz: -0.2, cue }
    }
    case 'read': {
      // standing at the bookcase, a book held up, turning a page now and then, head tilted to it
      const page = Math.max(0, Math.sin(t * 0.7 + seed * 2)) ** 6
      return { ...REST, torsoX: 0.08, headX: 0.32, headY: Math.sin(t * 0.25 + seed) * 0.12, armL: -1.25, armLz: 0.35, armR: -1.2 - page * 0.4, armRz: -0.35 }
    }
    case 'watch': {
      // leaning back at its own desk, eyes on the screen: a hand on the mouse, the other on the lap; a laugh now and then
      const laugh = Math.max(0, Math.sin(t * 0.45 + seed * 2)) ** 12
      return {
        ...REST, ...SIT, rootY: -0.1, torsoX: -0.14 - laugh * 0.08, headX: 0.04 - laugh * 0.12 + Math.sin(t * 9) * laugh * 0.05,
        headY: Math.sin(t * 0.2 + seed) * 0.06, armL: -0.55, armLz: 0.2, armR: -1.25 + Math.sin(t * 0.7 + seed) * 0.05, armRz: -0.12,
      }
    }
    case 'stand':
    default:
      return { ...REST, headY: Math.sin(t * 0.6 + seed) * 0.2 }
  }
}

function poseFor(kind: SpotKind, status: OfficeAgent['status']): Pose {
  if (kind === 'desk') return status === 'waiting' ? 'wait' : status === 'working' ? 'type' : 'relax'
  if (kind === 'meeting') return 'meeting'
  if (kind === 'sofa') return 'sofa'
  if (kind === 'cat') return 'pet'
  if (kind === 'pantry') return 'eat'
  if (kind === 'read') return 'read'
  if (kind === 'pc') return 'watch'
  return 'billiards'
}


const SPEED = 2.4
const HIP = 0.55

type Phase = 'driving-in' | 'walking-in' | 'present' | 'walking-out' | 'driving-out' | 'gone'

const CAR_SPEED = 6
const PARK_SPEED = 2.2

/** Move `pos` along `path` by `step`; returns the heading of the current leg (or null when idle). */
function advance(state: { pos: Vec2; path: Vec2[] }, step: number): number | null {
  if (!state.path.length) return null
  const [tx, tz] = state.path[0]
  const dx = tx - state.pos[0]
  const dz = tz - state.pos[1]
  const dist = Math.hypot(dx, dz)
  if (dist <= step) {
    state.pos = [tx, tz]
    state.path.shift()
  } else {
    state.pos = [state.pos[0] + (dx / dist) * step, state.pos[1] + (dz / dist) * step]
  }
  return dist > 0.001 ? Math.atan2(dx, dz) : null
}

export function Agent({ agent, leaving = false }: { agent: OfficeAgent; leaving?: boolean }) {
  const selected = useOffice((s) => s.selectedId === agent.id)
  const select = useOffice((s) => s.select)
  const spot = useMemo(() => spotById(agent.spotId), [agent.spotId])
  const layout = useLayout()
  const seed = useMemo(() => agent.desk * 1.7 + 0.3, [agent.desk])

  const root = useRef<Group>(null!)
  const torso = useRef<Group>(null!)
  const head = useRef<Group>(null!)
  const armL = useRef<Group>(null!)
  const armR = useRef<Group>(null!)
  const legL = useRef<Group>(null!)
  const legR = useRef<Group>(null!)
  const kneeL = useRef<Group>(null!)
  const kneeR = useRef<Group>(null!)
  const cue = useRef<Group>(null!)
  const joints = useRef<Joints>({ ...REST })
  const anchor = useMemo(() => new Vector3(), [])

  const finishDeparture = useOffice((s) => s.finishDeparture)
  const kind = vehicleKind(agent.desk)
  const vehicle = useRef<Group>(null!)
  const spotRef = useRef(spot)
  spotRef.current = spot
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const nav = useRef({
    phase: (agent.arriving ? 'driving-in' : 'present') as Phase,
    pos: (agent.arriving ? doorPos(agent.desk) : (agent.spawn ?? [spot.x, spot.z])) as Vec2,
    rotY: agent.arriving ? Math.PI : spot.rotY,
    path: [] as Vec2[],
    arrived: !agent.arriving,
  })
  // the agent's own car/scooter: drives in on arrival, waits in its slot, drives off on departure
  const car = useRef(
    agent.arriving
      ? (() => {
          const route = driveInRoute(agent.desk, layout.lot.maxX)
          return { pos: route[0], path: route.slice(1), rotY: -Math.PI / 2, total: route.length - 1 }
        })()
      : { pos: slotPos(agent.desk), path: [] as Vec2[], rotY: Math.PI, total: 0 },
  )

  // New destination → plan a route (only once the agent is inside and not on its way out).
  useEffect(() => {
    const n = nav.current
    if (n.phase !== 'present') return
    const target: Vec2 = [spot.x, spot.z]
    if (Math.hypot(n.pos[0] - target[0], n.pos[1] - target[1]) < 0.05) return
    n.path = findPath(layout, n.pos, target)
    n.arrived = false
  }, [spot])

  // Removed → walk out to the vehicle.
  useEffect(() => {
    if (!leaving) return
    const n = nav.current
    if (n.phase === 'driving-in') {
      // never got out: just turn around
      n.phase = 'driving-out'
      car.current.path = [...driveInRoute(agent.desk, layoutRef.current.lot.maxX)].reverse().slice(1)
      return
    }
    const outdoor = [...walkInRoute(agent.desk)].reverse().slice(1) // entrance → sidewalk → …
    const indoor = n.pos[1] < ENTRANCE[1] + 0.2 ? findPath(layoutRef.current, n.pos, ENTRANCE) : []
    n.path = [...indoor, ...outdoor, doorPos(agent.desk)]
    n.phase = 'walking-out'
    n.arrived = false
  }, [leaving, agent.desk])

  useFrame(({ clock, camera, size }, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const t = clock.elapsedTime
    const n = nav.current
    const c = car.current

    // ── vehicle ──
    if (c.path.length) {
      const parking = c.path.length <= 2
      const heading = advance(c, (parking ? PARK_SPEED : CAR_SPEED) * dt)
      // reversing out of the slot keeps the nose pointing at the building
      if (heading !== null) c.rotY = dampAngle(c.rotY, n.phase === 'driving-out' && c.path.length >= 2 ? heading + Math.PI : heading, 8, dt)
    } else if (n.phase === 'driving-in' || n.phase === 'present' || n.phase === 'walking-in' || n.phase === 'walking-out') {
      c.rotY = dampAngle(c.rotY, Math.PI, 6, dt)
    }
    vehicle.current.position.set(c.pos[0], 0, c.pos[1])
    vehicle.current.rotation.y = c.rotY
    vehicle.current.visible = n.phase !== 'gone'

    if (n.phase === 'driving-in' && !c.path.length) {
      // parked: get out and walk to the office, then on to the desk/spot
      n.phase = 'walking-in'
      n.pos = doorPos(agent.desk)
      n.path = [...walkInRoute(agent.desk), ...findPath(layoutRef.current, ENTRANCE, [spotRef.current.x, spotRef.current.z])]
    }
    if (n.phase === 'driving-out' && !c.path.length) {
      n.phase = 'gone'
      finishDeparture(agent.id)
    }
    const shown = n.phase === 'walking-in' || n.phase === 'present' || n.phase === 'walking-out'
    root.current.visible = shown
    const rider = vehicle.current.getObjectByName('rider')
    if (rider) rider.visible = !shown && n.phase !== 'gone'

    // follow the path
    let moving = false
    if (n.path.length) {
      const [tx, tz] = n.path[0]
      const dx = tx - n.pos[0]
      const dz = tz - n.pos[1]
      const dist = Math.hypot(dx, dz)
      const step = SPEED * dt
      if (dist <= step) {
        n.pos = [tx, tz]
        n.path.shift()
        if (!n.path.length) {
          n.arrived = true
          if (n.phase === 'walking-in') {
            n.phase = 'present'
            // the spot may have changed while we were walking in
            const sp = spotRef.current
            if (Math.hypot(n.pos[0] - sp.x, n.pos[1] - sp.z) > 0.05) {
              n.path = findPath(layoutRef.current, n.pos, [sp.x, sp.z])
              n.arrived = false
            }
          } else if (n.phase === 'walking-out') {
            // hop in and drive off (backing out of the slot first)
            n.phase = 'driving-out'
            const [sx, sz] = slotPos(agent.desk)
            c.path = [[sx, sz + 1.2], ...[...driveInRoute(agent.desk, layoutRef.current.lot.maxX)].reverse().slice(2)]
          }
        }
      } else {
        n.pos = [n.pos[0] + (dx / dist) * step, n.pos[1] + (dz / dist) * step]
      }
      moving = n.path.length > 0 || dist > step
      if (dist > 0.01) n.rotY = dampAngle(n.rotY, Math.atan2(dx, dz), 12, dt)
    } else if (n.arrived) {
      n.rotY = dampAngle(n.rotY, spot.rotY, 8, dt)
    }

    const pose: Pose = moving ? 'walk' : n.arrived && n.phase === 'present' ? poseFor(spot.kind, agent.status) : 'stand'
    const target = poseJoints(pose, t, seed, spot.id)
    const j = joints.current
    const k = pose === 'walk' || pose === 'billiards' ? 18 : 9
    for (const key of Object.keys(j) as (keyof Joints)[]) j[key] = MathUtils.damp(j[key], target[key], k, dt)

    root.current.position.set(n.pos[0], j.rootY, n.pos[1])
    root.current.rotation.y = n.rotY
    torso.current.rotation.x = j.torsoX
    head.current.rotation.set(j.headX, j.headY, 0)
    armL.current.rotation.set(j.armL, 0, j.armLz)
    armR.current.rotation.set(j.armR, 0, j.armRz)
    legL.current.rotation.x = j.legL
    legR.current.rotation.x = j.legR
    kneeL.current.rotation.x = j.kneeL
    kneeR.current.rotation.x = j.kneeR
    cue.current.visible = pose === 'billiards'
    cue.current.position.z = 0.35 + j.cue

    // label follows the vehicle while the agent is inside it
    const tagAt: Vec2 = shown ? n.pos : c.pos
    const tag = placeLabel(agent.id, anchor.set(tagAt[0], shown ? 2.0 + j.rootY : 1.9, tagAt[1]), camera, size.width, size.height)
    if (tag) {
      // only what changed is written (every write makes the browser redo the page's layout)
      const opacity = n.phase === 'gone' ? '0' : leaving ? '0.6' : '1'
      if (tag.style.opacity !== opacity) tag.style.opacity = opacity
      if (tag.dataset.pose !== pose) tag.dataset.pose = pose
      const bubble = tag.firstElementChild as HTMLElement
      const bob = `0 ${pose === 'wait' ? (Math.sin(t * 8) * 3).toFixed(1) : 0}px`
      if (bubble.style.translate !== bob) bubble.style.translate = bob
    }
  })

  const { look } = agent
  // batches are rebuilt when the look changes (a new figure or a shuffled style)
  const lookKey = `${look.seed}-${look.figure}`
  return (
    <>
    <Vehicle ref={vehicle} kind={kind} color={look.shirt} riderColor={look.shirt} />
    <group
      ref={root}
      onClick={(e) => {
        e.stopPropagation()
        select(selected ? null : agent.id)
      }}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      {selected && <SelectionHighlight color={look.shirt} />}
      <group position={[0, HIP, 0]}>
        {/* legs: thigh → knee → shin */}
        {([[legL, kneeL, -0.12], [legR, kneeR, 0.12]] as const).map(([leg, knee, x]) => (
          <group key={x} ref={leg} position={[x, 0, 0]}>
            <Box size={[0.17, 0.3, 0.19]} position={[0, -0.14, 0]} color={look.pants} />
            <group ref={knee} position={[0, -0.28, 0]}>
              <StaticBatch version={lookKey}>
                <Box size={[0.16, 0.26, 0.18]} position={[0, -0.11, 0]} color={look.pants} />
                <Box size={[0.18, 0.07, 0.26]} position={[0, -0.24, 0.04]} color={look.shoes} />
                {/* a chunky sole */}
                <Box size={[0.19, 0.025, 0.27]} position={[0, -0.285, 0.04]} color="#e9e6df" noShadow />
              </StaticBatch>
            </group>
          </group>
        ))}

        {/* woman: a short skirt over the hips (the legs move under it) */}
        {look.figure === 'woman' && <Box size={[0.5, 0.2, 0.32]} position={[0, -0.03, 0]} color={look.pants} />}

        <group ref={torso}>
          <Box size={[0.5, 0.56, 0.3]} position={[0, 0.28, 0]} color={look.shirt} />
          <Box size={[0.2, 0.08, 0.02]} position={[0, 0.5, 0.16]} color="#ffffff" opacity={0.6} noShadow />
          <StaticBatch version={lookKey}>
            <Top look={look} />
            <Bag look={look} />
          </StaticBatch>
          <Neckwear kind={look.neckwear} color={look.accent} />

          {/* arms pivot at the shoulder */}
          {([[armL, -0.32], [armR, 0.32]] as const).map(([arm, x]) => (
            <group key={x} ref={arm} position={[x, 0.5, 0]}>
              <StaticBatch version={lookKey}>
                <Box size={[0.14, 0.34, 0.16]} position={[0, -0.15, 0]} color={look.top === 'jacket' ? look.accent : look.shirt} />
                <Box size={[0.12, 0.12, 0.13]} position={[0, -0.37, 0]} color={look.skin} />
              </StaticBatch>
            </group>
          ))}

          {/* billiard cue, held in front */}
          <group ref={cue} position={[0.1, 0.18, 0.35]} rotation={[0.35, 0, 0]} visible={false}>
            <Cyl r={0.015} rBottom={0.03} h={1.5} rotation={[Math.PI / 2, 0, 0]} color="#d9b37a" />
            <Cyl r={0.017} h={0.04} position={[0, 0, 0.75]} rotation={[Math.PI / 2, 0, 0]} color="#4a7fd9" noShadow />
          </group>

          <group ref={head} position={[0, 0.6, 0]}>
            {/* the head is rigid: one batch instead of a dozen draw calls (rebuilt when the look changes) */}
            <StaticBatch version={lookKey}>
              <Box size={[0.46, 0.44, 0.44]} position={[0, 0.22, 0]} color={look.skin} />
              <Hair look={look} />
              {/* face */}
              {[-0.1, 0.1].map((x) => (
                <Box key={x} size={[0.06, 0.08, 0.02]} position={[x, 0.24, 0.225]} color="#1b1b22" noShadow />
              ))}
              {[-0.16, 0.16].map((x) => (
                <Box key={x} size={[0.07, 0.04, 0.01]} position={[x, 0.15, 0.225]} color="#f19a8a" opacity={0.7} noShadow />
              ))}
              <Ear kind={look.ear} />
              <Eyewear kind={look.eyewear} />
              <Hat kind={look.hat} color={look.hatColor} />
            </StaticBatch>
          </group>
        </group>
      </group>

    </group>
    </>
  )
}

// Head parts, in head space: the head box spans x ±0.23, y 0 → 0.44, z ±0.22 (the face is at +z). Hair stays within
// the head's height: a long slab down the back used to poke out of the shoulders when the agent leaned over (petting
// the cat, playing pool).

function Hair({ look }: { look: Look }) {
  const c = look.hair
  const top = <Box size={[0.5, 0.12, 0.48]} position={[0, 0.47, -0.01]} color={c} />
  const fringe = <Box size={[0.5, 0.08, 0.06]} position={[0, 0.39, 0.21]} color={c} />
  const locks = (h: number, y: number) =>
    [-0.255, 0.255].map((x) => <Box key={x} size={[0.06, h, 0.36]} position={[x, y, -0.03]} color={c} />)
  switch (look.hairStyle) {
    case 'buzz':
      return (
        <>
          <Box size={[0.48, 0.05, 0.46]} position={[0, 0.455, 0]} color={c} />
          <Box size={[0.48, 0.22, 0.03]} position={[0, 0.32, -0.225]} color={c} />
        </>
      )
    case 'curly':
      return (
        <>
          {top}
          {[-0.16, 0, 0.16].flatMap((x) =>
            [-0.14, 0.02, 0.16].map((z) => <Box key={`${x}${z}`} size={[0.15, 0.1, 0.15]} position={[x, 0.55 + ((x + z) * 10) % 2 * 0.015, z]} color={c} />),
          )}
          <Box size={[0.5, 0.3, 0.1]} position={[0, 0.3, -0.2]} color={c} />
        </>
      )
    case 'mullet':
      return (
        <>
          {top}
          <Box size={[0.48, 0.44, 0.1]} position={[0, 0.24, -0.2]} color={c} />
          {locks(0.16, 0.34)}
        </>
      )
    case 'bun':
      return (
        <>
          {top}
          <Box size={[0.5, 0.3, 0.1]} position={[0, 0.3, -0.2]} color={c} />
          <Box size={[0.17, 0.14, 0.17]} position={[0, 0.6, -0.1]} color={c} />
        </>
      )
    case 'long':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.52, 0.5, 0.1]} position={[0, 0.2, -0.22]} color={c} />
          {locks(0.44, 0.2)}
        </>
      )
    case 'bob':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.52, 0.34, 0.1]} position={[0, 0.3, -0.21]} color={c} />
          {locks(0.3, 0.27)}
        </>
      )
    case 'ponytail':
      return (
        <>
          {top}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          <Box size={[0.08, 0.06, 0.08]} position={[0, 0.36, -0.28]} color={look.hatColor} />
          <Box size={[0.13, 0.3, 0.12]} position={[0, 0.2, -0.3]} color={c} />
        </>
      )
    case 'buns':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          {[-0.17, 0.17].map((x) => (
            <Box key={x} size={[0.16, 0.15, 0.16]} position={[x, 0.59, -0.04]} color={c} />
          ))}
        </>
      )
    case 'pigtails':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          {[-0.29, 0.29].map((x) => (
            <Box key={x} size={[0.1, 0.3, 0.1]} position={[x, 0.2, -0.1]} color={c} />
          ))}
        </>
      )
    case 'fluffy':
      // a soft, full fringe over the forehead
      return (
        <>
          <Box size={[0.52, 0.16, 0.5]} position={[0, 0.49, -0.01]} color={c} />
          <Box size={[0.5, 0.12, 0.07]} position={[0, 0.37, 0.21]} color={c} />
          <Box size={[0.5, 0.3, 0.12]} position={[0, 0.3, -0.19]} color={c} />
          {locks(0.14, 0.35)}
        </>
      )
    case 'wolf':
      // shaggy layers: a fringe, choppy sides and a longer nape
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.38, 0.1]} position={[0, 0.25, -0.2]} color={c} />
          {locks(0.26, 0.29)}
          {[-0.12, 0.12].map((x) => (
            <Box key={x} size={[0.14, 0.1, 0.08]} position={[x, 0.08, -0.22]} color={c} />
          ))}
        </>
      )
    case 'spiky':
      return (
        <>
          {top}
          <Box size={[0.5, 0.3, 0.12]} position={[0, 0.3, -0.19]} color={c} />
          {[-0.15, 0, 0.15].flatMap((x) =>
            [-0.08, 0.12].map((z) => <Box key={`${x}${z}`} size={[0.08, 0.1, 0.08]} position={[x, 0.57, z]} rotation={[0, 0, x * 2]} color={c} />),
          )}
        </>
      )
    case 'curtain':
      // bangs parted in the middle, long at the back
      return (
        <>
          {top}
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.22, 0.13, 0.06]} position={[sd * 0.13, 0.37, 0.21]} rotation={[0, 0, sd * -0.3]} color={c} />
          ))}
          <Box size={[0.52, 0.5, 0.1]} position={[0, 0.2, -0.22]} color={c} />
          {locks(0.42, 0.21)}
        </>
      )
    case 'high-pony':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          <Box size={[0.1, 0.07, 0.1]} position={[0, 0.54, -0.22]} color={look.hatColor} />
          <Box size={[0.14, 0.34, 0.12]} position={[0, 0.36, -0.3]} color={c} />
        </>
      )
    case 'short':
    default:
      return (
        <>
          {top}
          <Box size={[0.5, 0.3, 0.12]} position={[0, 0.3, -0.19]} color={c} />
        </>
      )
  }
}

function Hat({ kind, color }: { kind: Look['hat']; color: string }) {
  switch (kind) {
    case 'beanie':
      return (
        <>
          <Box size={[0.52, 0.2, 0.5]} position={[0, 0.52, 0]} color={color} />
          <Box size={[0.54, 0.07, 0.52]} position={[0, 0.42, 0]} color={color} roughness={1} />
          <Box size={[0.1, 0.08, 0.1]} position={[0, 0.66, 0]} color="#f5f5f3" />
        </>
      )
    case 'cap':
    case 'cap-back':
      return (
        <>
          <Box size={[0.52, 0.14, 0.5]} position={[0, 0.5, 0]} color={color} />
          <Box size={[0.4, 0.04, 0.2]} position={[0, 0.45, kind === 'cap' ? 0.32 : -0.32]} color={color} />
        </>
      )
    case 'bucket':
      return (
        <>
          <Box size={[0.48, 0.16, 0.46]} position={[0, 0.56, 0]} color={color} />
          <Box size={[0.66, 0.03, 0.64]} position={[0, 0.47, 0]} color={color} />
        </>
      )
    case 'headphones':
      return (
        <>
          <Box size={[0.56, 0.05, 0.08]} position={[0, 0.57, 0]} color="#2a2d36" />
          {[-1, 1].map((s) => (
            <Box key={s} size={[0.04, 0.3, 0.06]} position={[s * 0.285, 0.42, 0]} color="#2a2d36" />
          ))}
          {[-1, 1].map((s) => (
            <Box key={s} size={[0.08, 0.17, 0.17]} position={[s * 0.29, 0.25, 0]} color={color} />
          ))}
        </>
      )
    case 'beret':
      return (
        <>
          <Box size={[0.52, 0.08, 0.5]} position={[0.03, 0.5, -0.01]} rotation={[0, 0, -0.14]} color={color} />
          <Box size={[0.04, 0.05, 0.04]} position={[0.04, 0.56, 0]} color={color} />
        </>
      )
    case 'visor':
      return (
        <>
          <Box size={[0.5, 0.06, 0.03]} position={[0, 0.42, 0.225]} color={color} />
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.03, 0.06, 0.44]} position={[sd * 0.245, 0.42, 0]} color={color} />
          ))}
          <Box size={[0.42, 0.03, 0.18]} position={[0, 0.41, 0.33]} color={color} />
        </>
      )
    case 'bandana':
      return (
        <>
          <Box size={[0.52, 0.1, 0.5]} position={[0, 0.44, 0]} color={color} />
          <Box size={[0.1, 0.08, 0.06]} position={[0, 0.42, -0.28]} color={color} />
          <Box size={[0.05, 0.12, 0.03]} position={[0.05, 0.34, -0.3]} rotation={[0, 0, 0.3]} color={color} />
        </>
      )
    case 'cat-ears':
      return (
        <>
          <Box size={[0.5, 0.04, 0.05]} position={[0, 0.5, 0.05]} color="#2a2d36" />
          {[-1, 1].map((sd) => (
            <group key={sd} position={[sd * 0.16, 0.56, 0.05]} rotation={[0, 0, Math.PI / 4]}>
              <Box size={[0.11, 0.11, 0.05]} color={color} />
              <Box size={[0.06, 0.06, 0.01]} position={[0, 0, 0.03]} color="#ffb3c7" noShadow />
            </group>
          ))}
        </>
      )
    case 'clips':
      // Y2K hair clips over the fringe
      return (
        <>
          {[[-0.16, 0.42, color], [-0.07, 0.44, '#ffd6a5'], [0.15, 0.43, '#a0c4ff']].map(([x, y, c]) => (
            <Box key={x as number} size={[0.08, 0.025, 0.02]} position={[x as number, y as number, 0.25]} rotation={[0, 0, 0.3]} color={c as string} noShadow />
          ))}
        </>
      )
    default:
      return null
  }
}

/** Earrings and earbuds, at the sides of the head (long hair may cover them). */
function Ear({ kind }: { kind: Look['ear'] }) {
  if (kind === 'none') return null
  return (
    <>
      {[-1, 1].map((sd) =>
        kind === 'stud' ? (
          <Box key={sd} size={[0.03, 0.03, 0.03]} position={[sd * 0.24, 0.17, 0.03]} color="#e3c15a" roughness={0.3} noShadow />
        ) : kind === 'hoops' ? (
          <mesh key={sd} position={[sd * 0.245, 0.12, 0.03]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.035, 0.008, 6, 14]} />
            <meshStandardMaterial color="#e3c15a" roughness={0.3} metalness={0.4} />
          </mesh>
        ) : (
          <group key={sd}>
            <Box size={[0.05, 0.05, 0.05]} position={[sd * 0.245, 0.2, 0.03]} color="#f5f5f3" roughness={0.2} noShadow />
            <Box size={[0.02, 0.07, 0.02]} position={[sd * 0.25, 0.15, 0.05]} color="#f5f5f3" roughness={0.2} noShadow />
          </group>
        ),
      )}
    </>
  )
}

/** What's over the shirt, in torso space (the chest faces +z at 0.15). */
function Top({ look }: { look: Look }) {
  const a = look.accent
  switch (look.top) {
    case 'graphic':
      return <Box size={[0.2, 0.16, 0.012]} position={[0, 0.3, 0.157]} color={a} noShadow />
    case 'hoodie':
      return (
        <>
          {/* the hood lying on the back, the strings and the front pocket */}
          <Box size={[0.44, 0.16, 0.12]} position={[0, 0.52, -0.19]} color={look.shirt} />
          {[-0.06, 0.06].map((x) => (
            <Box key={x} size={[0.02, 0.14, 0.012]} position={[x, 0.42, 0.157]} color={a} noShadow />
          ))}
          <Box size={[0.3, 0.12, 0.014]} position={[0, 0.12, 0.157]} color="#000000" opacity={0.14} noShadow />
        </>
      )
    case 'jacket':
      // open at the front: two panels over the shirt (its sleeves are the jacket's colour too)
      return (
        <>
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.17, 0.56, 0.02]} position={[sd * 0.165, 0.28, 0.157]} color={a} />
          ))}
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.12, 0.08, 0.03]} position={[sd * 0.12, 0.53, 0.16]} rotation={[0, 0, sd * 0.4]} color={a} />
          ))}
          <Box size={[0.52, 0.56, 0.02]} position={[0, 0.28, -0.157]} color={a} />
        </>
      )
    case 'vest':
      return <Box size={[0.44, 0.36, 0.02]} position={[0, 0.22, 0.157]} color={a} />
    default:
      return null
  }
}

/** A backpack (straps over the shoulders) or a crossbody bag, in torso space. */
function Bag({ look }: { look: Look }) {
  const c = look.bagColor
  if (look.bag === 'backpack')
    return (
      <>
        <Box size={[0.36, 0.38, 0.14]} position={[0, 0.28, -0.23]} color={c} />
        <Box size={[0.26, 0.12, 0.04]} position={[0, 0.18, -0.31]} color={c} opacity={0.9} />
        {[-0.13, 0.13].map((x) => (
          <Box key={x} size={[0.05, 0.3, 0.02]} position={[x, 0.38, 0.175]} color={c} noShadow />
        ))}
      </>
    )
  if (look.bag === 'crossbody')
    return (
      <>
        <Box size={[0.05, 0.62, 0.02]} position={[0, 0.3, 0.175]} rotation={[0, 0, 0.72]} color="#2a2d36" noShadow />
        <Box size={[0.18, 0.13, 0.08]} position={[0.2, 0.06, 0.17]} color={c} />
      </>
    )
  return null
}

function Eyewear({ kind }: { kind: Look['eyewear'] }) {
  if (kind === 'round')
    return (
      <group position={[0, 0.24, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <mesh key={x} position={[x, 0, 0]}>
            <torusGeometry args={[0.065, 0.012, 6, 16]} />
            <meshStandardMaterial color="#1b1b22" />
          </mesh>
        ))}
        <Box size={[0.07, 0.015, 0.01]} color="#1b1b22" noShadow />
      </group>
    )
  if (kind === 'square')
    return (
      <group position={[0, 0.24, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <Box size={[0.14, 0.02, 0.012]} position={[0, 0.05, 0]} color="#1b1b22" noShadow />
            <Box size={[0.14, 0.02, 0.012]} position={[0, -0.05, 0]} color="#1b1b22" noShadow />
            <Box size={[0.02, 0.1, 0.012]} position={[-0.06, 0, 0]} color="#1b1b22" noShadow />
            <Box size={[0.02, 0.1, 0.012]} position={[0.06, 0, 0]} color="#1b1b22" noShadow />
          </group>
        ))}
        <Box size={[0.06, 0.015, 0.012]} color="#1b1b22" noShadow />
      </group>
    )
  if (kind === 'y2k')
    // small tinted ovals
    return (
      <group position={[0, 0.245, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <Box key={x} size={[0.13, 0.065, 0.015]} position={[x, 0, 0]} color="#ff7eb6" opacity={0.75} roughness={0.2} noShadow />
        ))}
        <Box size={[0.07, 0.012, 0.012]} color="#c9c9d9" noShadow />
      </group>
    )
  if (kind === 'sport')
    // one wraparound shield
    return (
      <group position={[0, 0.25, 0.235]}>
        <Box size={[0.46, 0.09, 0.02]} color="#6ee7f9" roughness={0.1} opacity={0.85} noShadow />
        <Box size={[0.46, 0.015, 0.022]} position={[0, 0.05, 0]} color="#1b1b22" noShadow />
      </group>
    )
  if (kind === 'heart')
    return (
      <group position={[0, 0.24, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <Box size={[0.08, 0.08, 0.015]} position={[0, -0.01, 0]} rotation={[0, 0, Math.PI / 4]} color="#ff4d6d" roughness={0.3} noShadow />
            {[-0.025, 0.025].map((dx) => (
              <Box key={dx} size={[0.055, 0.055, 0.015]} position={[dx, 0.025, 0]} color="#ff4d6d" roughness={0.3} noShadow />
            ))}
          </group>
        ))}
        <Box size={[0.05, 0.012, 0.012]} position={[0, 0.02, 0]} color="#ff4d6d" noShadow />
      </group>
    )
  if (kind === 'shades')
    return (
      <group position={[0, 0.25, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <Box key={x} size={[0.15, 0.09, 0.015]} position={[x, 0, 0]} color="#101014" roughness={0.3} noShadow />
        ))}
        <Box size={[0.46, 0.02, 0.012]} position={[0, 0.035, 0]} color="#101014" noShadow />
      </group>
    )
  return null
}

/** Around the neck, in torso space (the chest is at z 0.15): a chain, a pendant, a scarf, a choker or a lanyard. */
function Neckwear({ kind, color }: { kind: Look['neckwear']; color: string }) {
  if (kind === 'none') return null
  const gold = '#e3c15a'
  if (kind === 'scarf')
    return (
      <group position={[0, 0.54, 0]}>
        <Box size={[0.52, 0.1, 0.34]} color={color} />
        <Box size={[0.1, 0.24, 0.03]} position={[0.1, -0.14, 0.17]} color={color} />
      </group>
    )
  if (kind === 'choker')
    return (
      <group position={[0, 0.555, 0.172]}>
        <Box size={[0.26, 0.03, 0.012]} color="#1b1b22" noShadow />
        <Box size={[0.03, 0.03, 0.014]} position={[0, -0.03, 0]} color={gold} roughness={0.3} noShadow />
      </group>
    )
  if (kind === 'lanyard')
    return (
      <group position={[0, 0.5, 0.174]}>
        {[-1, 1].map((s) => (
          <Box key={s} size={[0.02, 0.26, 0.01]} position={[s * 0.07, -0.1, 0]} rotation={[0, 0, s * 0.3]} color={color} noShadow />
        ))}
        <Box size={[0.1, 0.13, 0.012]} position={[0, -0.28, 0]} color="#f5f5f3" noShadow />
        <Box size={[0.06, 0.03, 0.014]} position={[0, -0.25, 0]} color={color} noShadow />
      </group>
    )
  return (
    <group position={[0, 0.5, 0.174]}>
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.022, 0.16, 0.012]} position={[s * 0.055, -0.05, 0]} rotation={[0, 0, s * 0.55]} color={gold} roughness={0.35} noShadow />
      ))}
      {kind === 'pendant' && <Box size={[0.06, 0.07, 0.015]} position={[0, -0.15, 0]} color="#7aa7e8" roughness={0.3} noShadow />}
      {kind === 'chain' && <Box size={[0.04, 0.03, 0.012]} position={[0, -0.12, 0]} color={gold} roughness={0.35} noShadow />}
    </group>
  )
}

/**
 * The selected agent stands out: a solid ring at its feet, a ring pulsing outwards, and a glow in its shirt colour
 * around it. The glow is an additive quad, not a real light: adding a light would recompile every shader (a hitch
 * on each click) and cost on every pixel.
 */
function SelectionHighlight({ color }: { color: string }) {
  const pulse = useRef<Mesh>(null)
  useFrame(({ clock }) => {
    const m = pulse.current
    if (!m) return
    const t = (clock.elapsedTime % 1.4) / 1.4 // 0 → 1 every 1.4 s
    const scale = 1 + t * 0.9
    m.scale.set(scale, scale, 1)
    ;(m.material as MeshBasicMaterial).opacity = 0.55 * (1 - t)
  })
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[0.42, 0.58, 40]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.42, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <ringGeometry args={[0.55, 0.62, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} renderOrder={1}>
        <planeGeometry args={[2.6, 2.6]} />
        <meshBasicMaterial map={poolTexture} color={color} transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}
