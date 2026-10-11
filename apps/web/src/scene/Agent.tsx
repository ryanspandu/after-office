import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, MathUtils, Vector3, type Group, type Mesh, type MeshBasicMaterial } from 'three'
import { useOffice, type Look, type OfficeAgent } from '../state/store'
import { doorPos, driveInRoute, ENTRANCE, slotPos, spotById, vehicleKind, walkInRoute, type SpotKind, type Vec2 } from './layout'
import { poolTexture } from './DayNight'
import { StaticBatch } from './StaticBatch'
import { Vehicle } from './Vehicle'
import { placeLabel } from './labels'
import { agentPose, agentWorld, setAgentWorld } from './focus'
import { findPath } from './pathing'
import { useLayout } from './useLayout'
import { dampAngle } from './math'
import { Cyl } from './prims'
import { Bag, ELBOW, ForearmShape, HipsShape, SHOULDER_X, UpperArmShape, Ear, Eyewear, Face, Hair, Hat, HEAD_SCALE, KNEE, NECK, Neckwear, SHOULDER, ShinShape, Skirt, ThighShape, Top, TORSO_FIT, TorsoShape } from './figure'
import { STRIKE_AT, STROKE_PERIOD, strokeOffset } from './furniture/Lounge'

type Pose = 'stand' | 'walk' | 'type' | 'wait' | 'meeting' | 'sofa' | 'relax' | 'eat' | 'pet' | 'billiards' | 'read' | 'watch' | 'write'

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
  /** elbows: negative bends the forearm forward */
  elbowL: number
  elbowR: number
  cue: number
}

/** How much longer the legs are than the chairs were made for (the hips sit that much lower when seated). */
const LEG_EXTRA = 0.3

const REST: Joints = { rootY: 0, torsoX: 0, headX: 0, headY: 0, armL: 0, armR: 0, armLz: 0.08, armRz: -0.08, legL: 0, legR: 0, kneeL: 0, kneeR: 0, elbowL: -0.12, elbowR: -0.12, cue: 0 }
const SIT = { rootY: -0.08 - LEG_EXTRA, legL: -Math.PI / 2, legR: -Math.PI / 2, kneeL: Math.PI / 2, kneeR: Math.PI / 2 }

function poseJoints(pose: Pose, t: number, seed: number, spotId: string): Joints {
  switch (pose) {
    case 'walk': {
      const s = Math.sin(t * 9)
      return { ...REST, rootY: Math.abs(Math.cos(t * 9)) * 0.05, legL: s * 0.6, legR: -s * 0.6, kneeL: Math.max(0, s) * 0.5, kneeR: Math.max(0, -s) * 0.5, armL: -s * 0.45, armR: s * 0.45, elbowL: -0.25 - Math.max(0, s) * 0.3, elbowR: -0.25 - Math.max(0, -s) * 0.3 }
    }
    case 'type':
      return {
        ...REST, ...SIT, torsoX: 0.12, headX: 0.15 + Math.sin(t * 2 + seed) * 0.04, headY: Math.sin(t * 0.7 + seed) * 0.12,
        armL: -0.55, armR: -0.55, armLz: 0.15, armRz: -0.15,
        elbowL: -1.05 + Math.sin(t * 17 + seed) * 0.08, elbowR: -1.05 + Math.sin(t * 17 + seed + Math.PI) * 0.08,
      }
    case 'wait': {
      // looking around, scratching head
      const scratch = Math.sin(t * 10) * 0.08
      return { ...REST, ...SIT, torsoX: -0.05, headX: -0.12, headY: Math.sin(t * 1.4 + seed) * 0.5, armL: -0.45, elbowL: -0.7, armR: -2.5 + scratch, elbowR: -1.4, armRz: -0.45 }
    }
    case 'meeting': {
      const gesture = Math.max(0, Math.sin(t * 1.1 + seed * 3)) ** 3
      return { ...REST, ...SIT, torsoX: 0.05, headX: Math.sin(t * 3 + seed) * 0.07, headY: Math.sin(t * 0.5 + seed) * 0.35, armL: -0.45, elbowL: -1.0, armR: -0.45 - gesture * 0.6, elbowR: -1.0 - gesture * 0.3, armRz: -0.1 - gesture * 0.3 }
    }
    case 'sofa':
    case 'relax':
      return { ...REST, ...SIT, rootY: -0.12 - LEG_EXTRA, torsoX: -0.25, headX: -0.15 + Math.sin(t * 0.8 + seed) * 0.05, headY: Math.sin(t * 0.3 + seed) * 0.3, armL: -0.35, elbowL: -0.5, armR: -1.9, elbowR: -0.5, armRz: 0.25 }
    case 'eat': {
      // sipping / snacking: right hand up to the mouth every few seconds
      const bite = Math.max(0, Math.sin(t * 1.4 + seed * 2)) ** 2
      return { ...REST, ...SIT, torsoX: 0.1, headX: 0.05 - bite * 0.15, headY: Math.sin(t * 0.4 + seed) * 0.3, armL: -0.45, elbowL: -0.9, armR: -0.45 - bite * 0.45, elbowR: -0.8 - bite * 1.3, armRz: -0.1 - bite * 0.3 }
    }
    case 'pet': {
      const stroke = Math.sin(t * 3.5 + seed)
      return { ...REST, rootY: -0.24 - LEG_EXTRA, torsoX: 0.5, headX: 0.35, headY: Math.sin(t * 0.9) * 0.15, legL: -1.15, kneeL: 2.1, legR: -0.35, kneeR: 1.6, armL: -0.3, armR: -0.8 + stroke * 0.3, elbowR: -0.35, armRz: -0.05 }
    }
    case 'billiards': {
      // slow pull back, then a snappy shot at STRIKE_AT
      const phase = (t + strokeOffset(spotId)) % STROKE_PERIOD
      const cue = phase < STRIKE_AT ? -(phase / STRIKE_AT) * 0.25 : Math.min(0.12, -0.25 + ((phase - STRIKE_AT) / 0.08) * 0.37)
      return { ...REST, torsoX: 0.75, headX: -0.55, legL: -0.25, legR: 0.25, armL: -1.3, elbowL: -0.1, armLz: 0.25, armR: -0.6 + cue * 2, elbowR: -0.7, armRz: -0.2, cue }
    }
    case 'read': {
      // standing at the bookcase, a book held up, turning a page now and then, head tilted to it
      const page = Math.max(0, Math.sin(t * 0.7 + seed * 2)) ** 6
      return { ...REST, torsoX: 0.08, headX: 0.32, headY: Math.sin(t * 0.25 + seed) * 0.12, armL: -0.55, elbowL: -1.1, armLz: 0.3, armR: -0.55 - page * 0.3, elbowR: -1.1, armRz: -0.3 }
    }
    case 'write': {
      // at the whiteboard: the right hand up on the board, moving along a line and down to the next; the head follows
      const line = (t * 0.55 + seed) % 1
      const row = Math.floor((t * 0.55 + seed) % 4)
      const across = -0.35 + line * 0.7
      return {
        ...REST, headX: -0.12 - row * 0.03, headY: across * 0.35,
        armR: -1.75 + row * 0.12 + Math.sin(t * 9) * 0.04, armRz: -0.15 - across * 0.45, elbowR: -0.55 + Math.sin(t * 14) * 0.06,
        armL: -0.1, elbowL: -0.35, armLz: 0.1,
      }
    }
    case 'watch': {
      // leaning back at its own desk, eyes on the screen: a hand on the mouse, the other on the lap; a laugh now and then
      const laugh = Math.max(0, Math.sin(t * 0.45 + seed * 2)) ** 12
      return {
        ...REST, ...SIT, rootY: -0.1 - LEG_EXTRA, torsoX: -0.14 - laugh * 0.08, headX: 0.04 - laugh * 0.12 + Math.sin(t * 9) * laugh * 0.05,
        headY: Math.sin(t * 0.2 + seed) * 0.06, armL: -0.3, elbowL: -0.9, armLz: 0.2, armR: -0.55, elbowR: -0.95 + Math.sin(t * 0.7 + seed) * 0.05, armRz: -0.12,
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
  if (kind === 'board') return 'write'
  if (kind === 'pc') return 'watch'
  return 'billiards'
}


const SPEED = 2.4
const HIP = 0.55 + LEG_EXTRA

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
  const elbowL = useRef<Group>(null!)
  const elbowR = useRef<Group>(null!)
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

  useEffect(
    () => () => {
      agentWorld.delete(agent.id)
      agentPose.delete(agent.id)
    },
    [agent.id],
  )

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
    elbowL.current.rotation.x = j.elbowL
    elbowR.current.rotation.x = j.elbowR
    legL.current.rotation.x = j.legL
    legR.current.rotation.x = j.legR
    kneeL.current.rotation.x = j.kneeL
    kneeR.current.rotation.x = j.kneeR
    cue.current.visible = pose === 'billiards'
    cue.current.position.z = 0.35 + j.cue

    // label follows the vehicle while the agent is inside it
    const tagAt: Vec2 = shown ? n.pos : c.pos
    // where the camera looks when this agent is clicked (scene/focus.ts)
    setAgentWorld(agent.id, tagAt[0], 1.2 + j.rootY, tagAt[1])
    agentPose.set(agent.id, shown ? pose : 'away')
    const tag = placeLabel(agent.id, anchor.set(tagAt[0], shown ? 2.3 + j.rootY : 1.9, tagAt[1]), camera, size.width, size.height)
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
        {([[legL, kneeL, -0.11], [legR, kneeR, 0.11]] as const).map(([leg, knee, x]) => (
          <group key={x} ref={leg} position={[x, 0, 0]}>
            <ThighShape color={look.pants} />
            <group ref={knee} position={[0, -KNEE, 0]}>
              <StaticBatch version={lookKey}>
                <ShinShape color={look.pants} shoes={look.shoes} />
              </StaticBatch>
            </group>
          </group>
        ))}

        {/* woman: a short skirt over the hips (the legs move under it) */}
        <HipsShape color={look.pants} />
        {look.figure === 'woman' && <Skirt color={look.pants} />}

        <group ref={torso}>
          <TorsoShape color={look.shirt} skin={look.skin} woman={look.figure === 'woman'} />
          <group position={[0, TORSO_FIT.y, 0]} scale={[TORSO_FIT.x, TORSO_FIT.scale, TORSO_FIT.z]}>
            <StaticBatch version={lookKey}>
              <Top look={look} />
              <Bag look={look} />
            </StaticBatch>
            <Neckwear kind={look.neckwear} color={look.accent} />
          </group>

          {/* arms pivot at the shoulder, forearms at the elbow (their own batch: the elbow moves) */}
          {([[armL, elbowL, -SHOULDER_X], [armR, elbowR, SHOULDER_X]] as const).map(([arm, elbow, x]) => (
            <group key={x} ref={arm} position={[x, SHOULDER, 0]}>
              <UpperArmShape sleeve={look.top === 'jacket' ? look.accent : look.shirt} />
              <group ref={elbow} position={[0, -ELBOW, 0]} userData={{ dynamic: true }}>
                <StaticBatch version={lookKey}>
                  <ForearmShape sleeve={look.top === 'jacket' ? look.accent : look.shirt} skin={look.skin} />
                </StaticBatch>
              </group>
            </group>
          ))}

          {/* billiard cue, held in front */}
          <group ref={cue} position={[0.1, 0.18, 0.35]} rotation={[0.35, 0, 0]} visible={false}>
            <Cyl r={0.015} rBottom={0.03} h={1.5} rotation={[Math.PI / 2, 0, 0]} color="#d9b37a" />
            <Cyl r={0.017} h={0.04} position={[0, 0, 0.75]} rotation={[Math.PI / 2, 0, 0]} color="#4a7fd9" noShadow />
          </group>

          <group ref={head} position={[0, NECK, 0]}>
            {/* the head is rigid: one batch instead of a dozen draw calls (rebuilt when the look changes) */}
            <StaticBatch version={lookKey}>
              <group scale={HEAD_SCALE}>
              <Face skin={look.skin} />
              <Hair look={look} />
              <Ear kind={look.ear} />
              <Eyewear kind={look.eyewear} />
              <Hat kind={look.hat} color={look.hatColor} />
              </group>
            </StaticBatch>
          </group>
        </group>
      </group>

    </group>
    </>
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
