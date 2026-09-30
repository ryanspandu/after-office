import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import { windowGlass } from './DayNight'
import { Box, Cyl } from './prims'
import { LOUNGE, MEETING, PANTRY, WALL_H, type Layout, type Rect, type Vec2 } from './layout'
import { StaticBatch } from './StaticBatch'
import { WallSign } from './WallSign'

export function Room({ layout }: { layout: Layout }) {
  const { floor, cols } = layout
  const W = floor.maxX - floor.minX
  const D = floor.maxZ - floor.minZ
  const cx = (floor.minX + floor.maxX) / 2
  const deskMinX = floor.minX
  const deskMaxX = MEETING.bounds.minX - 0.3
  const deskColsX = Array.from({ length: cols }, (_, c) => -1 - 4 * c)

  return (
    <StaticBatch version={layout}>
      {/* diorama slab */}
      <Box size={[W + 0.4, 0.5, D + 0.4]} position={[cx, -0.26, 0]} color="#c9a57a" noShadow />
      <Box size={[W + 0.6, 0.3, D + 0.6]} position={[cx, -0.55, 0]} color="#5b4a3c" noShadow />
      {/* wood planks */}
      {Array.from({ length: Math.round(D / 0.8) }, (_, i) => (
        <Box key={i} size={[W, 0.02, 0.78]} position={[cx, 0, floor.minZ + 0.4 + i * 0.8]} color={i % 2 ? '#d8b88e' : '#d2b085'} noShadow />
      ))}
      {/* open-plan carpet */}
      <Box
        size={[deskMaxX - deskMinX - 1, 0.02, 13]}
        position={[(deskMinX + 0.5 + deskMaxX - 0.5) / 2, 0.02, -1]}
        color="#8ea7b5"
        noShadow
      />
      {/* meeting room floor */}
      <Box size={[MEETING.bounds.maxX - MEETING.bounds.minX, 0.02, 6.4]} position={[(MEETING.bounds.minX + MEETING.bounds.maxX) / 2, 0.02, -4.75]} color="#b9bec7" noShadow />
      <PantryFloor />
      {/* lounge rugs */}
      <Cyl r={1.6} h={0.02} position={[LOUNGE.catPlay[0], 0.025, LOUNGE.catPlay[1]]} color="#e7c7a0" seg={32} noShadow />
      <Box size={[4.2, 0.02, 3.4]} position={[LOUNGE.sofa.x, 0.025, 0.9]} color="#c07a5b" noShadow />

      {/* back walls */}
      <Box size={[W + 0.4, WALL_H, 0.2]} position={[cx, WALL_H / 2, floor.minZ - 0.1]} color="#efe6da" />
      <Box size={[0.2, WALL_H, D + 0.4]} position={[floor.minX - 0.1, WALL_H / 2, 0]} color="#e8ddcf" />
      <Box size={[W + 0.4, 0.15, 0.24]} position={[cx, 0.075, floor.minZ - 0.1]} color="#8b6f55" noShadow />
      <Box size={[0.24, 0.15, D + 0.4]} position={[floor.minX - 0.1, 0.075, 0]} color="#8b6f55" noShadow />

      {/* windows over every desk column, plus the side wall */}
      {deskColsX.map((x) => (
        <Window key={x} position={[x, 1.55, floor.minZ + 0.01]} />
      ))}
      {[-4, 0].map((z) => (
        <Window key={z} position={[floor.minX + 0.01, 1.55, z]} rotation={[0, Math.PI / 2, 0]} />
      ))}

      {/* animated: kept out of the batch */}
      <group userData={{ dynamic: true }}>
        <WallSign position={[(deskMinX + deskMaxX) / 2, 3.05, floor.minZ + 0.02]} width={Math.min(7, deskMaxX - deskMinX - 2)} />
        <WallClock position={[0.8, 2.3, floor.minZ + 0.02]} />
      </group>
      <Bookshelf rect={layout.bookshelf} />
      <WaterCooler at={layout.waterCooler} />
      {layout.plants.map((p, i) => (
        <Plant key={i} at={p} tall={i % 2 === 0} />
      ))}
      <GlassRooms />
    </StaticBatch>
  )
}

function PantryFloor() {
  const { minX, maxX, minZ, maxZ } = PANTRY.bounds
  const tiles: [number, number][] = []
  for (let x = minX; x < maxX - 0.01; x += 0.75) for (let z = minZ; z < maxZ - 0.01; z += 0.75) tiles.push([x, z])
  return (
    <group>
      {tiles.map(([x, z]) => (
        <Box
          key={`${x}:${z}`}
          size={[0.75, 0.02, 0.75]}
          position={[x + 0.375, 0.022, z + 0.375]}
          color={(Math.round((x - minX) / 0.75) + Math.round((z - minZ) / 0.75)) % 2 ? '#ecebe6' : '#d9d6cf'}
          noShadow
        />
      ))}
    </group>
  )
}

function Window(props: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <group {...props}>
      <Box size={[2.2, 1.4, 0.04]} color="#6b5645" noShadow />
      <mesh material={windowGlass} receiveShadow>
        <boxGeometry args={[2.0, 1.2, 0.05]} />
      </mesh>
      <Box size={[0.06, 1.2, 0.07]} color="#6b5645" noShadow />
      <Box size={[2.0, 0.06, 0.07]} color="#6b5645" noShadow />
    </group>
  )
}

function WallClock(props: { position: [number, number, number] }) {
  const hour = useRef<Group>(null!)
  const minute = useRef<Group>(null!)
  useFrame(() => {
    const d = new Date()
    const m = d.getMinutes() + d.getSeconds() / 60
    minute.current.rotation.z = -(m / 60) * Math.PI * 2
    hour.current.rotation.z = -(((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2
  })
  return (
    <group {...props}>
      <Cyl r={0.35} h={0.06} rotation={[Math.PI / 2, 0, 0]} color="#fbf7f0" seg={24} noShadow />
      <Cyl r={0.38} h={0.04} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.01]} color="#3b3340" seg={24} noShadow />
      <group ref={hour} position={[0, 0, 0.05]}>
        <Box size={[0.04, 0.18, 0.02]} position={[0, 0.09, 0]} color="#3b3340" noShadow />
      </group>
      <group ref={minute} position={[0, 0, 0.06]}>
        <Box size={[0.03, 0.27, 0.02]} position={[0, 0.13, 0]} color="#e0664a" noShadow />
      </group>
    </group>
  )
}

const BOOK_COLORS = ['#d9644a', '#4a7fd9', '#e3b341', '#57b894', '#a879e0', '#3b3340']

function Bookshelf({ rect }: { rect: Rect }) {
  const { x, z, w, d } = rect
  return (
    <group position={[x, 0, z]}>
      <Box size={[w, 2.0, d]} position={[0, 1.0, 0]} color="#7a5c43" />
      {[0.45, 1.05, 1.65].map((y, row) =>
        Array.from({ length: 7 }, (_, i) => (
          <Box
            key={`${row}-${i}`}
            size={[0.3, 0.38 + ((i * 7 + row) % 3) * 0.05, 0.16]}
            position={[w / 2 - 0.1, y + 0.02, -d / 2 + 0.3 + i * 0.3]}
            color={BOOK_COLORS[(i + row * 2) % BOOK_COLORS.length]}
            noShadow
          />
        )),
      )}
    </group>
  )
}

function WaterCooler({ at }: { at: Vec2 }) {
  return (
    <group position={[at[0], 0, at[1]]}>
      <Box size={[0.45, 0.9, 0.45]} position={[0, 0.45, 0]} color="#e9edf2" />
      <Cyl r={0.2} h={0.5} position={[0, 1.15, 0]} color="#7cc4ef" opacity={0.75} />
      <Box size={[0.1, 0.06, 0.08]} position={[0.24, 0.7, 0]} color="#4a7fd9" noShadow />
    </group>
  )
}

export function Plant({ at, tall }: { at: Vec2; tall?: boolean }) {
  const h = tall ? 1.3 : 0.8
  return (
    <group position={[at[0], 0, at[1]]}>
      <Cyl r={0.25} rBottom={0.2} h={0.45} position={[0, 0.225, 0]} color="#c56a4a" />
      <Cyl r={0.23} h={0.04} position={[0, 0.44, 0]} color="#4b3a2f" noShadow />
      <Cyl r={0} rBottom={0.38} h={h} position={[0, 0.45 + h / 2, 0]} color="#4f9a5b" seg={7} />
      <Cyl r={0} rBottom={0.3} h={h * 0.7} position={[0.05, 0.45 + h * 0.75, 0.02]} color="#63b36e" seg={7} />
    </group>
  )
}

/** Glass walls of the meeting room and the pantry. */
function GlassRooms() {
  const h = 2.2
  const glass = { color: '#cfe8f5', opacity: 0.22, roughness: 0.1 }
  const frame = '#4a4f5c'
  // [x1, z1, x2, z2] segments; doors are the gaps
  const { bounds: mb, door: md } = MEETING
  const { bounds: pb, door: pd } = PANTRY
  const segs: [number, number, number, number][] = [
    [mb.minX, mb.maxZ, md.from, mb.maxZ],
    [md.to, mb.maxZ, mb.maxX, mb.maxZ],
    [mb.minX, mb.minZ, mb.minX, mb.maxZ],
    [pb.minX, pb.minZ, pb.minX, pb.maxZ],
    [pb.minX, pb.maxZ, pd.from, pb.maxZ],
    [pd.to, pb.maxZ, pb.maxX, pb.maxZ],
  ]
  const posts = [
    [mb.minX, mb.maxZ], [md.from, mb.maxZ], [md.to, mb.maxZ], [pb.minX, pb.maxZ],
    [pd.from, pb.maxZ], [pd.to, pb.maxZ], [pb.maxX - 0.05, pb.maxZ],
  ]
  return (
    <group>
      {segs.map(([x1, z1, x2, z2], i) => {
        const alongX = z1 === z2
        const len = alongX ? x2 - x1 : z2 - z1
        const pos: [number, number, number] = [(x1 + x2) / 2, h / 2, (z1 + z2) / 2]
        return (
          <group key={i}>
            <Box size={alongX ? [len, h, 0.06] : [0.06, h, len]} position={pos} {...glass} noShadow />
            <Box size={alongX ? [len, 0.08, 0.1] : [0.1, 0.08, len]} position={[pos[0], h, pos[2]]} color={frame} />
          </group>
        )
      })}
      {posts.map(([x, z]) => (
        <Box key={`${x}:${z}`} size={[0.08, h, 0.1]} position={[x, h / 2, z]} color={frame} />
      ))}
    </group>
  )
}
