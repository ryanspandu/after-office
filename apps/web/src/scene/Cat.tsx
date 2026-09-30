import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { MathUtils, Vector3, type Group } from 'three'
import { useOffice } from '../state/store'
import { placeLabel } from './labels'
import { LOUNGE, type Vec2 } from './layout'
import { dampAngle } from './math'
import { Ball, Box } from './prims'

// The office cat: wanders the lounge, naps in its bed, and comes over when an idle agent wants to play.

const FUR = '#f0a24b'
const STRIPE = '#c97a2c'
const SPEED = 1.1

type Mode = 'walk' | 'sit' | 'loaf'

export function Cat() {
  const petting = useOffice((s) => s.agents.some((a) => a.status === 'idle' && a.spotId.startsWith('cat-')))
  const root = useRef<Group>(null!)
  const tail = useRef<Group>(null!)
  const head = useRef<Group>(null!)
  const legs = useRef<(Group | null)[]>([])
  const body = useRef<Group>(null!)
  const anchor = useRef(new Vector3())
  const yarn = useRef<Group>(null!)

  const s = useRef({
    pos: [...LOUNGE.catBed] as Vec2,
    rotY: 0,
    target: null as Vec2 | null,
    mode: 'loaf' as Mode,
    until: 4,
    yarn: [LOUNGE.catPlay[0] + 0.3, LOUNGE.catPlay[1] + 0.2] as Vec2,
    yarnV: [0, 0] as Vec2,
  })

  useFrame(({ clock, camera, size }, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const t = clock.elapsedTime
    const c = s.current

    // decide where to go
    if (petting) {
      const p = LOUNGE.catPlay
      if (!c.target || c.target[0] !== p[0] || c.target[1] !== p[1]) {
        if (Math.hypot(c.pos[0] - p[0], c.pos[1] - p[1]) > 0.05) (c.target = [...p] as Vec2), (c.mode = 'walk')
      }
    } else if (!c.target && t > c.until) {
      const a = LOUNGE.catArea
      c.target = Math.random() < 0.25 ? ([...LOUNGE.catBed] as Vec2) : [MathUtils.randFloat(a.minX, a.maxX), MathUtils.randFloat(a.minZ, a.maxZ)]
      c.mode = 'walk'
    }

    if (c.target) {
      const dx = c.target[0] - c.pos[0]
      const dz = c.target[1] - c.pos[1]
      const dist = Math.hypot(dx, dz)
      const step = SPEED * dt
      if (dist <= step) {
        c.pos = c.target
        const atBed = c.pos[0] === LOUNGE.catBed[0] && c.pos[1] === LOUNGE.catBed[1]
        c.mode = atBed ? 'loaf' : 'sit'
        c.target = petting ? c.target : null
        c.until = t + (atBed ? 10 : 3) + Math.random() * 5
        if (petting) c.target = null
      } else {
        c.pos = [c.pos[0] + (dx / dist) * step, c.pos[1] + (dz / dist) * step]
        c.rotY = dampAngle(c.rotY, Math.atan2(dx, dz), 10, dt)
      }
    }

    // when sitting next to someone, bat at the yarn ball
    if (petting && c.mode === 'sit' && Math.random() < dt * 0.6) {
      const a = Math.random() * Math.PI * 2
      c.yarnV = [Math.cos(a) * 0.8, Math.sin(a) * 0.8]
    }
    c.yarn = [c.yarn[0] + c.yarnV[0] * dt, c.yarn[1] + c.yarnV[1] * dt]
    const pull = Math.exp(-2 * dt)
    c.yarnV = [c.yarnV[0] * pull, c.yarnV[1] * pull]
    // keep the yarn near the play rug
    const [px, pz] = LOUNGE.catPlay
    const off = [c.yarn[0] - px, c.yarn[1] - pz]
    const r = Math.hypot(off[0], off[1])
    if (r > 0.6) c.yarn = [px + (off[0] / r) * 0.6, pz + (off[1] / r) * 0.6]
    yarn.current.position.set(c.yarn[0], 0.09, c.yarn[1])
    yarn.current.rotation.x += c.yarnV[1] * dt * 8
    yarn.current.rotation.z -= c.yarnV[0] * dt * 8

    // pose
    const walking = c.mode === 'walk'
    root.current.position.set(c.pos[0], 0, c.pos[1])
    root.current.rotation.y = c.rotY
    legs.current.forEach((leg, i) => {
      if (!leg) return
      leg.rotation.x = walking ? Math.sin(t * 12 + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI : 0)) * 0.6 : 0
      leg.scale.y = MathUtils.damp(leg.scale.y, c.mode === 'loaf' ? 0.3 : 1, 6, dt)
    })
    const sitting = c.mode === 'sit'
    body.current.rotation.x = MathUtils.damp(body.current.rotation.x, sitting ? -0.5 : 0, 6, dt)
    body.current.position.y = MathUtils.damp(body.current.position.y, c.mode === 'loaf' ? -0.12 : 0, 6, dt)
    tail.current.rotation.y = Math.sin(t * (petting ? 7 : 2.5)) * 0.6
    tail.current.rotation.x = -0.9 + Math.sin(t * 1.3) * 0.1
    head.current.rotation.y = walking ? 0 : Math.sin(t * 0.8) * 0.5
    head.current.rotation.x = c.mode === 'loaf' ? 0.3 : sitting ? 0.4 : 0

    const tag = placeLabel('cat', anchor.current.set(c.pos[0], 0.75, c.pos[1]), camera, size.width, size.height)
    const hearts = tag?.firstElementChild as HTMLElement | null
    if (hearts) {
      // written only when it changes, and the float only while the hearts show
      const on = petting && !walking
      const opacity = on ? '1' : '0'
      if (hearts.style.opacity !== opacity) hearts.style.opacity = opacity
      if (on) hearts.style.transform = `translateY(${(-((t * 12) % 14)).toFixed(1)}px)`
    }
  })

  return (
    <>
      <group ref={yarn}>
        <Ball r={0.09} color="#e06c9f" />
      </group>
      <group ref={root}>
        <group ref={body}>
          {/* legs */}
          {[[-0.08, 0.14], [0.08, 0.14], [-0.08, -0.14], [0.08, -0.14]].map(([x, z], i) => (
            <group key={i} ref={(g) => void (legs.current[i] = g)} position={[x, 0.16, z]}>
              <Box size={[0.07, 0.16, 0.07]} position={[0, -0.08, 0]} color={FUR} />
            </group>
          ))}
          <Box size={[0.24, 0.2, 0.46]} position={[0, 0.24, 0]} color={FUR} />
          {[-0.1, 0.05].map((z) => (
            <Box key={z} size={[0.25, 0.05, 0.06]} position={[0, 0.33, z]} color={STRIPE} noShadow />
          ))}
          <group ref={head} position={[0, 0.34, 0.25]}>
            <Box size={[0.24, 0.2, 0.2]} position={[0, 0.04, 0.02]} color={FUR} />
            {[-1, 1].map((sx) => (
              <mesh key={sx} position={[sx * 0.08, 0.17, 0.02]} castShadow>
                <coneGeometry args={[0.05, 0.1, 4]} />
                <meshStandardMaterial color={FUR} />
              </mesh>
            ))}
            {[-0.06, 0.06].map((x) => (
              <Box key={x} size={[0.035, 0.045, 0.01]} position={[x, 0.06, 0.125]} color="#1b1b22" noShadow />
            ))}
            <Box size={[0.03, 0.02, 0.01]} position={[0, 0.02, 0.125]} color="#f19a8a" noShadow />
          </group>
          <group ref={tail} position={[0, 0.3, -0.22]}>
            <Box size={[0.05, 0.05, 0.36]} position={[0, 0, -0.17]} color={STRIPE} />
          </group>
        </group>
      </group>
    </>
  )
}
