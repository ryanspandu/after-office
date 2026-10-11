import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CanvasTexture, SRGBColorSpace, type Mesh, type MeshStandardMaterial } from 'three'
import { useOffice } from '../../state/store'
import { env, lampBulb } from '../DayNight'
import { LOUNGE } from '../layout'
import { FloorLamp } from './Lamps'
import { Ball, Box, Cyl } from '../prims'
import { StaticBatch } from '../StaticBatch'

export const STROKE_PERIOD = 3
/** Phase offset per pool spot so the two players alternate shots. */
export const strokeOffset = (spotId: string) => (spotId === 'pool-1' ? STROKE_PERIOD / 2 : 0)
/** Moment within the period when the cue hits. */
export const STRIKE_AT = 2.3

export function Lounge() {
  return (
    <StaticBatch>
      <BilliardTable />
      <TvCorner />
      <Sofa />
      <CoffeeTable />
      <CatBed />
      <FloorLamp position={[LOUNGE.floorLamp[0], 0, LOUNGE.floorLamp[1]]} />
    </StaticBatch>
  )
}

/** Sofa facing -z (towards the TV); backrest on the +z side. */
function Sofa() {
  const { x, z, w, d } = LOUNGE.sofa
  const frame = '#4d6a96'
  return (
    <group position={[x, 0, z]}>
      <Box size={[w, 0.3, d]} position={[0, 0.2, 0]} color={frame} />
      <Box size={[w - 0.4, 0.12, d - 0.25]} position={[0, 0.41, -0.08]} color="#5f7fb0" />
      <Box size={[w, 0.9, 0.25]} position={[0, 0.5, d / 2 - 0.12]} color={frame} />
      {[-1, 1].map((sx) => (
        <Box key={sx} size={[0.18, 0.6, d]} position={[sx * (w / 2 - 0.09), 0.35, 0]} color={frame} />
      ))}
      <Box size={[0.4, 0.35, 0.18]} position={[-w / 2 + 0.45, 0.62, d / 2 - 0.3]} rotation={[0.3, 0, 0]} color="#e3b341" />
      <Box size={[0.4, 0.35, 0.18]} position={[w / 2 - 0.45, 0.62, d / 2 - 0.3]} rotation={[0.3, 0, 0]} color="#f07a1d" />
    </group>
  )
}

function CoffeeTable() {
  const { x, z, w, d } = LOUNGE.coffeeTable
  return (
    <group position={[x, 0, z]}>
      <Box size={[w, 0.06, d]} position={[0, 0.4, 0]} color="#8c6a4f" />
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => (
        <Box key={`${sx}${sz}`} size={[0.05, 0.38, 0.05]} position={[(sx * (w - 0.1)) / 2, 0.19, (sz * (d - 0.1)) / 2]} color="#6b5040" />
      ))}
      <Cyl r={0.06} h={0.1} position={[0.3, 0.48, -0.1]} color="#fbf7f0" />
      <Cyl r={0.06} h={0.1} position={[-0.4, 0.48, 0.1]} color="#d9644a" />
      {/* popcorn bowl + remote */}
      <Cyl r={0.14} rBottom={0.09} h={0.1} position={[0, 0.48, 0]} color="#f3ead9" />
      <Box size={[0.05, 0.02, 0.18]} position={[0.55, 0.44, 0.1]} color="#2a2a2a" noShadow />
    </group>
  )
}

/** Seconds per scene of the cartoon, and of the fade to black between two. */
const SCENE_S = 9
const FADE_S = 0.6
type SceneId = 'day' | 'sunset' | 'night' | 'beach'
const SCENES: { id: SceneId; sky: string; hills: string; ground: string; sun: string }[] = [
  { id: 'day', sky: '#7cc6ff', hills: '#5fbf6a', ground: '#3f9a4f', sun: '#ffe066' },
  { id: 'sunset', sky: '#ff9a6b', hills: '#8a5a9c', ground: '#5b3d6b', sun: '#fff2b0' },
  { id: 'night', sky: '#18224a', hills: '#26345e', ground: '#1b2540', sun: '#eef2ff' },
  { id: 'beach', sky: '#8ee3f2', hills: '#f0d9a0', ground: '#2f9fd0', sun: '#ffffff' },
]
/** The film's canvas (16:9, like the TV): the picture fills the whole screen. */
const FILM = { w: 384, h: 216 }
const STARS: [number, number][] = [[0.08, 0.22], [0.2, 0.32], [0.33, 0.18], [0.47, 0.28], [0.62, 0.16], [0.74, 0.3], [0.88, 0.2], [0.55, 0.38]]

/** One frame of the cartoon: a walk in the hills, a drive at sunset, a quiet night, a boat at sea. */
function drawFilm(g: CanvasRenderingContext2D, t: number) {
  const { w, h } = FILM
  const n = Math.floor(t / SCENE_S)
  const sc = SCENES[n % SCENES.length]
  const p = (t % SCENE_S) / SCENE_S
  const top = 0
  const bottom = h
  const horizon = top + (bottom - top) * 0.62
  const circle = (x: number, y: number, r: number, c: string) => {
    g.fillStyle = c
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  // sky
  g.fillStyle = sc.sky
  g.fillRect(0, top, w, bottom - top)
  // stars (night) and the sun / moon
  if (sc.id === 'night')
    STARS.forEach(([x, y], i) => {
      g.globalAlpha = 0.5 + Math.sin(t * 3 + i * 1.7) * 0.5
      circle(x * w, top + y * (bottom - top), 1.6, '#ffffff')
      g.globalAlpha = 1
    })
  circle(sc.id === 'night' ? w * 0.8 : w * (0.18 + p * 0.15), top + 34 - Math.sin(p * Math.PI) * 10, 13, sc.sun)
  // a cloud drifting by
  if (sc.id !== 'night') {
    const cx = ((t * 14) % (w + 80)) - 40
    ;[[-12, 0, 9], [0, -4, 12], [13, 0, 9]].forEach(([dx, dy, r]) => circle(cx + dx, top + 30 + dy, r, '#ffffff'))
  }
  // hills on the horizon, the ground (the sea at the beach)
  g.fillStyle = sc.hills
  ;[[0.18, 70], [0.55, 85], [0.88, 66]].forEach(([x, r]) => {
    g.beginPath()
    g.arc(x * w, horizon + 18, r, Math.PI, 0)
    g.fill()
  })
  g.fillStyle = sc.ground
  g.fillRect(0, horizon + 18, w, bottom - horizon - 18)
  if (sc.id === 'beach') {
    g.fillStyle = 'rgba(255,255,255,0.55)'
    for (let i = 0; i < 6; i++) g.fillRect(((i * 70 + t * 20) % (w + 40)) - 20, horizon + 30 + (i % 2) * 14, 22, 2)
  }
  // the star of each scene, crossing the picture
  const x = -30 + p * (w + 60)
  const ground = horizon + 18
  if (sc.id === 'day') {
    const bob = Math.abs(Math.sin(t * 6)) * 2
    g.fillStyle = '#e8795b'
    g.fillRect(x - 5, ground - 22 - bob, 10, 16)
    circle(x, ground - 28 - bob, 6, '#f2d0b1')
    g.fillStyle = '#3a3f4b'
    g.fillRect(x - 4, ground - 6 - bob, 3, 6)
    g.fillRect(x + 1, ground - 6 - bob, 3, 6)
  } else if (sc.id === 'sunset') {
    const cx = w - x
    g.fillStyle = '#e03e3e'
    g.fillRect(cx - 24, ground - 16, 48, 10)
    g.fillRect(cx - 12, ground - 24, 24, 9)
    circle(cx - 14, ground - 5, 5, '#1b1b1b')
    circle(cx + 14, ground - 5, 5, '#1b1b1b')
  } else if (sc.id === 'night') {
    g.fillStyle = '#3a2f4a'
    g.fillRect(w * 0.22, ground - 30, 46, 30)
    g.fillStyle = '#2a2238'
    g.beginPath()
    g.moveTo(w * 0.22 - 6, ground - 30)
    g.lineTo(w * 0.22 + 23, ground - 50)
    g.lineTo(w * 0.22 + 52, ground - 30)
    g.fill()
    g.fillStyle = '#ffd27a'
    g.fillRect(w * 0.22 + 28, ground - 22, 10, 10)
  } else {
    const by = ground + 12 + Math.sin(t * 2.2) * 2
    g.fillStyle = '#7a4a2a'
    g.fillRect(x - 18, by, 36, 6)
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.moveTo(x, by - 2)
    g.lineTo(x, by - 30)
    g.lineTo(x + 16, by - 2)
    g.fill()
  }
  // the cut between scenes: a fade to black
  const edge = Math.min(t % SCENE_S, SCENE_S - (t % SCENE_S))
  if (edge < FADE_S) {
    g.fillStyle = `rgba(0,0,0,${1 - edge / FADE_S})`
    g.fillRect(0, top, w, bottom - top)
  }
}

/**
 * What's on the TV while someone watches: the cartoon, drawn on a small canvas each frame and shown on the screen as
 * its picture (flat on the glass, cut at its edges like a real screen).
 */
function TvMovie({ watching }: { watching: boolean }) {
  const mesh = useRef<Mesh>(null!)
  const film = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = FILM.w
    canvas.height = FILM.h
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    return { g: canvas.getContext('2d')!, texture }
  }, [])
  useEffect(() => () => film?.texture.dispose(), [film])
  useFrame(({ clock }) => {
    mesh.current.visible = watching
    if (!watching || !film) return
    drawFilm(film.g, clock.elapsedTime)
    film.texture.needsUpdate = true
  })
  return (
    <mesh ref={mesh} position={[0, 0, 0.047]} visible={false} userData={{ dynamic: true }}>
      <planeGeometry args={[3.16, 1.76]} />
      <meshBasicMaterial map={film?.texture ?? null} toneMapped={false} />
    </mesh>
  )
}

/** Big TV on a low console, facing the sofa. Plays a cartoon when someone is watching. */
function TvCorner() {
  const { x, z, w, d } = LOUNGE.tv
  const watching = useOffice((s) => s.agents.some((a) => a.status === 'idle' && a.spotId.startsWith('sofa')))
  const screen = useRef<MeshStandardMaterial>(null!)

  useFrame(() => {
    screen.current.emissiveIntensity = watching ? 0.25 : 0.12 + env.night * 0.1
  })

  return (
    <group position={[x, 0, z]}>
      {/* console */}
      <Box size={[w, 0.5, d]} position={[0, 0.25, 0]} color="#3a3230" />
      {[-1, 0, 1].map((k) => (
        <Box key={k} size={[w / 3 - 0.08, 0.36, 0.02]} position={[(k * w) / 3, 0.27, d / 2 + 0.005]} color="#4a3f3b" noShadow />
      ))}
      <Box size={[0.5, 0.1, 0.3]} position={[-1.3, 0.55, 0]} color="#1b1b1b" />
      <Cyl r={0.08} rBottom={0.1} h={0.25} position={[1.4, 0.62, 0]} color="#63b36e" />
      {/* TV */}
      <group position={[0, 1.5, -0.05]}>
        <Box size={[3.3, 1.9, 0.08]} color="#111" />
        <mesh position={[0, 0, 0.045]} userData={{ dynamic: true }}>
          <planeGeometry args={[3.16, 1.76]} />
          <meshStandardMaterial ref={screen} color="#0c0f14" emissive="#9fc3ff" emissiveIntensity={0.12} />
        </mesh>
        <TvMovie watching={watching} />
      </group>
    </group>
  )
}

function CatBed() {
  const [x, z] = LOUNGE.catBed
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
        <torusGeometry args={[0.38, 0.12, 8, 20]} />
        <meshStandardMaterial color="#d9644a" roughness={0.9} />
      </mesh>
      <Cyl r={0.36} h={0.06} position={[0, 0.04, 0]} color="#f1d9b5" seg={20} />
      {/* scratching post */}
      <Cyl r={0.08} h={0.9} position={[0.7, 0.5, -0.1]} color="#c9a57a" />
      <Box size={[0.4, 0.06, 0.4]} position={[0.7, 0.03, -0.1]} color="#8c6a4f" />
      <Box size={[0.35, 0.06, 0.35]} position={[0.7, 0.96, -0.1]} color="#8c6a4f" />
    </group>
  )
}

// ── Billiards ─────────────────────────────────────────────────────────────

const BALL_R = 0.06
const TOP_Y = 0.8
const BALL_COLORS = ['#fbfbf8', '#f2c230', '#2f5ecf', '#d63a2f', '#6b3fa0', '#f07f22', '#2f8f4a', '#8a2a2a', '#1a1a1a', '#f2c230', '#2f5ecf', '#d63a2f', '#6b3fa0', '#f07f22', '#2f8f4a', '#8a2a2a']

interface BallState {
  x: number
  z: number
  vx: number
  vz: number
  live: boolean
}

function rack(): BallState[] {
  const balls: BallState[] = [{ x: -0.8, z: 0, vx: 0, vz: 0, live: true }]
  let n = 1
  for (let row = 0; row < 5; row++)
    for (let k = 0; k <= row; k++) {
      balls.push({ x: 0.55 + row * 0.105, z: (k - row / 2) * 0.125, vx: 0, vz: 0, live: true })
      n++
    }
  return balls.slice(0, n)
}

function BilliardTable() {
  const { x, z, w, d } = LOUNGE.billiards
  const playerSpots = useOffice((s) =>
    s.agents
      .filter((a) => a.status === 'idle' && a.spotId.startsWith('pool-'))
      .map((a) => a.spotId)
      .join(','),
  )
  const refs = useRef<(Mesh | null)[]>([])
  const balls = useRef<BallState[]>(rack())
  const lastPhase = useRef<Record<string, number>>({})

  const inner = { hx: (w - 0.3) / 2 - BALL_R, hz: (d - 0.3) / 2 - BALL_R }
  const pockets = useMemo(
    () =>
      [-1, 0, 1].flatMap((px) => [-1, 1].map((pz) => [px * (inner.hx + BALL_R * 0.6), pz * (inner.hz + BALL_R * 0.6)] as const)),
    [inner.hx, inner.hz],
  )

  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(rawDt, 1 / 30)
    const t = clock.elapsedTime
    const bs = balls.current

    // A player's cue strike → push the cue ball at a random live ball.
    for (const spot of playerSpots ? playerSpots.split(',') : []) {
      const phase = (t + strokeOffset(spot)) % STROKE_PERIOD
      const prev = lastPhase.current[spot] ?? phase
      lastPhase.current[spot] = phase
      if (prev < STRIKE_AT && phase >= STRIKE_AT) {
        const cue = bs[0]
        const targets = bs.filter((b, i) => i > 0 && b.live)
        if (!targets.length) balls.current = rack()
        else {
          const tgt = targets[Math.floor(Math.random() * targets.length)]
          const a = Math.atan2(tgt.z - cue.z, tgt.x - cue.x) + (Math.random() - 0.5) * 0.15
          const speed = 2 + Math.random() * 1.5
          cue.vx = Math.cos(a) * speed
          cue.vz = Math.sin(a) * speed
        }
      }
    }

    // integrate + rails + friction
    for (const b of bs) {
      if (!b.live) continue
      b.x += b.vx * dt
      b.z += b.vz * dt
      if (Math.abs(b.x) > inner.hx) (b.x = Math.sign(b.x) * inner.hx), (b.vx *= -0.8)
      if (Math.abs(b.z) > inner.hz) (b.z = Math.sign(b.z) * inner.hz), (b.vz *= -0.8)
      const f = Math.exp(-0.9 * dt)
      b.vx *= f
      b.vz *= f
      if (Math.hypot(b.vx, b.vz) < 0.02) b.vx = b.vz = 0
      for (const [px, pz] of pockets)
        if (Math.hypot(b.x - px, b.z - pz) < 0.1) {
          b.live = false
        }
    }
    // cue ball scratched → put it back
    if (!bs[0].live) Object.assign(bs[0], { x: -0.8, z: 0, vx: 0, vz: 0, live: true })

    // ball-ball collisions (equal mass, elastic)
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]
        const c = bs[j]
        if (!a.live || !c.live) continue
        const dx = c.x - a.x
        const dz = c.z - a.z
        const dist = Math.hypot(dx, dz)
        if (dist === 0 || dist >= BALL_R * 2) continue
        const nx = dx / dist
        const nz = dz / dist
        const overlap = BALL_R * 2 - dist
        a.x -= (nx * overlap) / 2
        a.z -= (nz * overlap) / 2
        c.x += (nx * overlap) / 2
        c.z += (nz * overlap) / 2
        const vn = (a.vx - c.vx) * nx + (a.vz - c.vz) * nz
        if (vn > 0) {
          a.vx -= vn * nx
          a.vz -= vn * nz
          c.vx += vn * nx
          c.vz += vn * nz
        }
      }

    bs.forEach((b, i) => {
      const m = refs.current[i]
      if (!m) return
      m.visible = b.live
      m.position.set(b.x, TOP_Y + BALL_R, b.z)
    })
  })

  return (
    <group position={[x, 0, z]}>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => (
        <Box key={`${sx}${sz}`} size={[0.16, 0.55, 0.16]} position={[(sx * (w - 0.3)) / 2, 0.275, (sz * (d - 0.3)) / 2]} color="#5b3a26" />
      ))}
      <Box size={[w, 0.25, d]} position={[0, 0.66, 0]} color="#6b4530" />
      <Box size={[w - 0.3, 0.02, d - 0.3]} position={[0, TOP_Y, 0]} color="#2f8f5b" roughness={1} />
      {/* rails */}
      {[-1, 1].map((s) => (
        <Box key={`x${s}`} size={[w, 0.08, 0.15]} position={[0, TOP_Y + 0.03, s * (d / 2 - 0.075)]} color="#7a4f36" />
      ))}
      {[-1, 1].map((s) => (
        <Box key={`z${s}`} size={[0.15, 0.08, d]} position={[s * (w / 2 - 0.075), TOP_Y + 0.03, 0]} color="#7a4f36" />
      ))}
      {pockets.map(([px, pz], i) => (
        <Cyl key={i} r={0.075} h={0.03} position={[px, TOP_Y + 0.01, pz]} color="#111" noShadow />
      ))}
      <group userData={{ dynamic: true }}>
        {BALL_COLORS.map((c, i) => (
          <Ball key={i} r={BALL_R} ref={(m) => void (refs.current[i] = m)} color={c} roughness={0.25} />
        ))}
      </group>
      {/* lamp above the table */}
      <group position={[0, 1.75, 0]}>
        <Box size={[1.6, 0.12, 0.35]} color="#2f6b4a" noShadow />
        <mesh position={[0, -0.07, 0]} material={lampBulb}>
          <boxGeometry args={[1.5, 0.02, 0.3]} />
        </mesh>
        <Box size={[0.02, 1.0, 0.02]} position={[0, 0.55, 0]} color="#333" noShadow />
      </group>
    </group>
  )
}
