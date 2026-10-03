import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group, Mesh, MeshStandardMaterial } from 'three'
import type { OfficeAgent } from '../../state/store'
import { env } from '../DayNight'
import { CHAIR_OFFSET, DESK_LAMP, DESK_SIZE, type Vec2 } from '../layout'
import { isBossSpot } from '../layout'
import { Box, Cyl } from '../prims'
import { Chair } from './Chair'
import { DeskLamp } from './Lamps'

// play: idle but still at the desk (the few seconds after a reply): a little Pac-Man game on the screen
type ScreenMode = 'off' | 'work' | 'wait' | 'sleep' | 'play'

const SYNTAX = ['#f78c6c', '#82aaff', '#c3e88d', '#c792ea', '#ffcb6b', '#89ddff']
const LINES = 7
// the game: Pac-Man eats a row of dots left to right, a ghost behind him; one run takes RUN seconds, then again
const DOTS = [-0.3, -0.18, -0.06, 0.06, 0.18, 0.3]
const RUN = 4.5
const LANE = 0.5

function Computer({ mode, accent }: { mode: ScreenMode; accent: string }) {
  const face = useRef<Mesh>(null!)
  const lines = useRef<(Mesh | null)[]>([])
  const game = useRef<Group>(null!)
  const pac = useRef<Group>(null!)
  const mouth = useRef<Mesh>(null!)
  const ghost = useRef<Group>(null!)
  const dots = useRef<(Mesh | null)[]>([])
  const state = useRef({ acc: 0, widths: Array.from({ length: LINES }, () => Math.random()), indents: Array.from({ length: LINES }, () => 0) })

  useFrame((_, dt) => {
    const mat = face.current.material as MeshStandardMaterial
    const t = performance.now() / 1000
    const s = state.current
    if (mode === 'work') {
      s.acc += dt
      if (s.acc > 0.18) {
        s.acc = 0
        s.widths.shift()
        s.indents.shift()
        s.widths.push(0.2 + Math.random() * 0.8)
        s.indents.push(Math.floor(Math.random() * 3))
      }
      mat.emissive.set('#26304d')
      mat.emissiveIntensity = 1 + env.night * 1.5
    } else if (mode === 'wait') {
      mat.emissive.set('#ff9b3d')
      mat.emissiveIntensity = (0.5 + Math.sin(t * 6) * 0.4) * (1 + env.night)
    } else if (mode === 'play') {
      mat.emissive.set('#0b1030')
      mat.emissiveIntensity = 1 + env.night
      // each desk starts its run at another moment, so neighbours aren't in step
      const x = -0.46 + (((t + accent.length * 0.7) % RUN) / RUN) * 0.92
      pac.current.position.x = x
      mouth.current.scale.y = 0.15 + Math.abs(Math.sin(t * 12)) * 0.85
      ghost.current.position.x = x - 0.2
      ghost.current.visible = x - 0.2 > -0.42
      ghost.current.position.y = LANE + Math.sin(t * 8) * 0.006
      dots.current.forEach((d, i) => d && (d.visible = DOTS[i] > x + 0.02))
    } else if (mode === 'sleep') {
      mat.emissive.set('#23304a')
      mat.emissiveIntensity = (0.4 + Math.sin(t * 1.2) * 0.15) * (1 + env.night)
    } else {
      mat.emissiveIntensity = 0
    }
    game.current.visible = mode === 'play'
    lines.current.forEach((m, i) => {
      if (!m) return
      m.visible = mode === 'work'
      const w = s.widths[i] * (0.6 - s.indents[i] * 0.08)
      m.scale.x = w
      m.position.x = -0.38 + s.indents[i] * 0.08 + w / 2
    })
  })

  return (
    <group position={[0, DESK_SIZE.h, -0.28]}>
      <Box size={[0.2, 0.03, 0.16]} position={[0, 0.015, 0]} color="#2a2d36" />
      <Box size={[0.05, 0.28, 0.05]} position={[0, 0.16, -0.02]} color="#2a2d36" />
      <Box size={[0.98, 0.6, 0.05]} position={[0, 0.5, 0]} color="#22252e" />
      <mesh ref={face} position={[0, 0.5, 0.027]} userData={{ dynamic: true }}>
        <planeGeometry args={[0.9, 0.52]} />
        <meshStandardMaterial color="#0d0f16" emissive="#000" roughness={0.4} />
      </mesh>
      {Array.from({ length: LINES }, (_, i) => (
        <mesh key={i} ref={(m) => void (lines.current[i] = m)} position={[0, 0.7 - i * 0.065, 0.03]} userData={{ dynamic: true }}>
          <planeGeometry args={[1, 0.03]} />
          <meshBasicMaterial color={i === LINES - 1 ? accent : SYNTAX[i % SYNTAX.length]} toneMapped={false} />
        </mesh>
      ))}
      <group ref={game} visible={false} userData={{ dynamic: true }}>
        {/* the maze's walls above and below the lane */}
        {[LANE + 0.1, LANE - 0.1].map((y) => (
          <mesh key={y} position={[0, y, 0.03]}>
            <planeGeometry args={[0.84, 0.018]} />
            <meshBasicMaterial color="#2f4bff" toneMapped={false} />
          </mesh>
        ))}
        {DOTS.map((x, i) => (
          <mesh key={x} ref={(m) => void (dots.current[i] = m)} position={[x, LANE, 0.03]}>
            <planeGeometry args={[0.022, 0.022]} />
            <meshBasicMaterial color="#ffd9b0" toneMapped={false} />
          </mesh>
        ))}
        <group ref={pac} position={[0, LANE, 0.031]}>
          <mesh>
            <circleGeometry args={[0.055, 20]} />
            <meshBasicMaterial color="#ffd400" toneMapped={false} />
          </mesh>
          {/* the mouth: a wedge in the screen's colour, opening and closing */}
          <mesh ref={mouth} position={[0, 0, 0.001]}>
            <circleGeometry args={[0.057, 8, -0.6, 1.2]} />
            <meshBasicMaterial color="#0d0f16" toneMapped={false} />
          </mesh>
        </group>
        <group ref={ghost} position={[0, LANE, 0.031]}>
          <mesh position={[0, 0.012, 0]}>
            <circleGeometry args={[0.045, 16, 0, Math.PI]} />
            <meshBasicMaterial color={accent} toneMapped={false} />
          </mesh>
          <mesh position={[0, -0.012, 0]}>
            <planeGeometry args={[0.09, 0.05]} />
            <meshBasicMaterial color={accent} toneMapped={false} />
          </mesh>
          {[-0.017, 0.017].map((ex) => (
            <mesh key={ex} position={[ex, 0.008, 0.001]}>
              <planeGeometry args={[0.018, 0.022]} />
              <meshBasicMaterial color="#ffffff" toneMapped={false} />
            </mesh>
          ))}
        </group>
      </group>
    </group>
  )
}

export function Workstation({ at, owner, index }: { at: Vec2; owner?: OfficeAgent; index: number }) {
  const mode: ScreenMode = !owner
    ? 'off'
    : owner.status === 'working'
      ? 'work'
      : owner.status === 'waiting'
        ? 'wait'
        : // done but still sitting there (the wind-down after a reply): playing a game
          owner.status === 'idle' && (owner.spotId === `desk-${owner.desk}` || isBossSpot(owner.spotId))
          ? 'play'
          : 'sleep'
  const { w, d, h } = DESK_SIZE
  return (
    <group position={[at[0], 0, at[1]]}>
      {/* desk */}
      <Box size={[w, 0.06, d]} position={[0, h - 0.03, 0]} color="#f3ede4" />
      {[-1, 1].map((sx) => (
        <Box key={sx} size={[0.06, h - 0.06, d - 0.1]} position={[sx * (w / 2 - 0.06), (h - 0.06) / 2, 0]} color="#c9c3b8" />
      ))}
      <Box size={[w - 0.2, 0.35, 0.04]} position={[0, h - 0.25, -d / 2 + 0.05]} color="#c9c3b8" />

      <Computer mode={mode} accent={owner?.look.shirt ?? '#888'} />
      <Box size={[0.62, 0.03, 0.2]} position={[0, h + 0.015, 0.18]} color="#3a3d48" />
      <Box size={[0.08, 0.03, 0.12]} position={[0.46, h + 0.015, 0.2]} color="#3a3d48" />
      {/* mug */}
      <Cyl r={0.06} h={0.12} position={[-0.72, h + 0.06, 0.12]} color={owner?.look.shirt ?? '#dcd6cc'} />
      {/* PC tower with status LED */}
      <group position={[0.7, 0, -0.15]}>
        <Box size={[0.25, 0.5, 0.5]} position={[0, 0.25, 0]} color="#2a2d36" />
        {/* follows the owner's status: kept out of the desk batch, so a status change doesn't rebuild it */}
        <group userData={{ dynamic: true }}>
          <Box
            size={[0.04, 0.04, 0.02]}
            position={[0.05, 0.42, 0.26]}
            color="#333"
            emissive={mode === 'off' ? undefined : mode === 'wait' ? '#ff9b3d' : '#5dff9b'}
            emissiveIntensity={2}
            noShadow
          />
        </group>
      </group>
      {/* little desk toy varies per desk */}
      {index % 3 === 0 && <Cyl r={0.07} rBottom={0.06} h={0.1} position={[-0.45, h + 0.05, -0.3]} color="#c56a4a" />}
      {index % 3 === 0 && <Cyl r={0} rBottom={0.09} h={0.2} position={[-0.45, h + 0.2, -0.3]} color="#4f9a5b" seg={6} />}
      {index % 3 === 1 && (
        <group position={[-0.6, h, -0.3]}>
          <Box size={[0.25, 0.3, 0.2]} position={[0, 0.15, 0]} color="#e3b341" />
        </group>
      )}

      <DeskLamp position={[DESK_LAMP[0], h, DESK_LAMP[1]]} on={mode === 'work' || mode === 'wait'} />
      {/* the manager's desk: a brass name plate on the front edge */}
      {owner?.kind === 'manager' && (
        <group position={[0.25, h, 0.36]}>
          <Box size={[0.42, 0.1, 0.04]} position={[0, 0.05, 0]} rotation={[-0.35, 0, 0]} color="#c9a227" roughness={0.3} />
          <Box size={[0.46, 0.02, 0.1]} position={[0, 0.01, -0.02]} color="#3a3d48" noShadow />
        </group>
      )}
      <Chair position={[0, 0, CHAIR_OFFSET]} rotY={Math.PI} color={owner ? '#3b3f4d' : '#6b6f7b'} />
    </group>
  )
}
