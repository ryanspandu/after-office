import { useRef, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Group, Vector3 } from 'three'
import { windowGlass } from './DayNight'
import { Box, Cyl, Sphere } from './prims'
import { frontLeftCenter, LOUNGE, MEETING, openPlanCenter, PANTRY, WALL_H, type BossRoom, type Layout, type Rect, type Vec2 } from './layout'
import { StaticBatch } from './StaticBatch'
import { WallSign } from './WallSign'
import { RingLamp } from './furniture/Lamps'

export function Room({ layout }: { layout: Layout }) {
  const { floor, cols } = layout
  const W = floor.maxX - floor.minX
  const D = floor.maxZ - floor.minZ
  const cx = (floor.minX + floor.maxX) / 2
  // the open plan starts right of the manager's office
  const deskMinX = layout.openMinX
  const deskMaxX = MEETING.bounds.minX - 0.3
  const deskColsX = Array.from({ length: cols }, (_, c) => -1 - 4 * c)

  return (
    <StaticBatch version={layout}>
      {/* diorama slab */}
      <Box size={[W + 0.4, 0.5, D + 0.4]} position={[cx, -0.26, 0]} color="#e8dccb" noShadow />
      <Box size={[W + 0.6, 0.3, D + 0.6]} position={[cx, -0.55, 0]} color="#8f8478" noShadow />
      {/* wood planks */}
      {Array.from({ length: Math.round(D / 0.8) }, (_, i) => (
        <Box key={i} size={[W, 0.02, 0.78]} position={[cx, 0, floor.minZ + 0.4 + i * 0.8]} color={i % 2 ? '#ead9bf' : '#e5d3b7'} noShadow />
      ))}
      {/* open-plan carpet */}
      <Box
        size={[deskMaxX - deskMinX - 1, 0.02, 13]}
        position={[(deskMinX + 0.5 + deskMaxX - 0.5) / 2, 0.02, -1]}
        color="#dfe1df"
        noShadow
      />
      {/* meeting room floor */}
      <Box size={[MEETING.bounds.maxX - MEETING.bounds.minX, 0.02, 6.4]} position={[(MEETING.bounds.minX + MEETING.bounds.maxX) / 2, 0.02, -4.75]} color="#e6e8ec" noShadow />
      <PantryFloor />
      {/* the manager's office: a warm wood floor of its own */}
      <Box size={[layout.boss.bounds.maxX - layout.boss.bounds.minX, 0.02, layout.boss.bounds.maxZ - layout.boss.bounds.minZ]} position={[(layout.boss.bounds.minX + layout.boss.bounds.maxX) / 2, 0.021, (layout.boss.bounds.minZ + layout.boss.bounds.maxZ) / 2]} color="#d8b791" noShadow />
      {/* lounge rugs */}
      <Cyl r={1.6} h={0.02} position={[LOUNGE.catPlay[0], 0.025, LOUNGE.catPlay[1]]} color="#f1e3cf" seg={40} noShadow />
      <Box size={[4.2, 0.02, 3.4]} position={[LOUNGE.sofa.x, 0.025, 0.9]} color="#d9a58a" noShadow />

      {/* skirting along the walls: stays when a wall is cut away */}
      <Box size={[W + 0.4, 0.12, 0.24]} position={[cx, 0.06, floor.minZ - 0.1]} color="#d4cdc3" noShadow />
      <Box size={[0.24, 0.12, D + 0.4]} position={[floor.minX - 0.1, 0.06, 0]} color="#d4cdc3" noShadow />

      {/* the back wall, its windows over every desk column, the sign and the clock */}
      <Cutaway inward={[0, 1]} version={layout}>
        <Box size={[W + 0.4, WALL_H, 0.2]} position={[cx, WALL_H / 2, floor.minZ - 0.1]} color="#f7f5f1" />
        {deskColsX.map((x) => (
          <Window key={x} position={[x, 1.55, floor.minZ + 0.01]} />
        ))}
        {/* animated: kept out of the batch */}
        <group userData={{ dynamic: true }}>
          <WallSign position={[(deskMinX + deskMaxX) / 2, 3.05, floor.minZ + 0.02]} width={Math.min(7, deskMaxX - deskMinX - 2)} />
          <WallClock position={[0.8, 2.3, floor.minZ + 0.02]} />
        </group>
      </Cutaway>
      {/* the side wall and its windows */}
      <Cutaway inward={[1, 0]} version={layout}>
        <Box size={[0.2, WALL_H, D + 0.4]} position={[floor.minX - 0.1, WALL_H / 2, 0]} color="#efece6" />
        {[-4, 0].map((z) => (
          <Window key={z} position={[floor.minX + 0.01, 1.55, z]} rotation={[0, Math.PI / 2, 0]} />
        ))}
      </Cutaway>
      {/* the big ring light over the open plan (lit at night: scene/DayNight.tsx) */}
      <RingLamp position={[openPlanCenter(layout)[0], 3.0, openPlanCenter(layout)[1]]} radius={1.3} />
      {/* and a smaller one over the floor in front of the manager's office */}
      <RingLamp position={[frontLeftCenter(layout)[0], 3.0, frontLeftCenter(layout)[1]]} radius={1.0} />
      <Bookshelf rect={layout.bookshelf} />
      <WaterCooler at={layout.waterCooler} />
      {layout.plants.map((p, i) => (
        <Plant key={i} at={p} tall={i % 2 === 0} />
      ))}
      <GlassRooms boss={layout.boss} />
    </StaticBatch>
  )
}

/**
 * A wall the camera may end up behind once the view is turned: then it's cut away (hidden), so it never stands between
 * the camera and the office. `inward`: the direction (x, z) from the wall into the room.
 */
function Cutaway({ inward, version, children }: { inward: [number, number]; version: unknown; children: ReactNode }) {
  const group = useRef<Group>(null!)
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3 } | null
  useFrame(({ camera }) => {
    const t = controls?.target
    const dx = camera.position.x - (t?.x ?? 0)
    const dz = camera.position.z - (t?.z ?? 0)
    // the camera looks from outside the room through this wall
    const behind = dx * inward[0] + dz * inward[1] < -1
    if (group.current.visible === behind) group.current.visible = !behind
  })
  return (
    <group ref={group} userData={{ dynamic: true }}>
      <StaticBatch version={version}>{children}</StaticBatch>
    </group>
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
      <Box size={[2.3, 1.9, 0.04]} color="#2f333c" noShadow />
      <mesh material={windowGlass} receiveShadow>
        <boxGeometry args={[2.2, 1.8, 0.05]} />
      </mesh>
      <Box size={[0.04, 1.8, 0.07]} color="#2f333c" noShadow />
      <Box size={[2.2, 0.04, 0.07]} position={[0, 0.3, 0]} color="#2f333c" noShadow />
      {/* the sill */}
      <Box size={[2.4, 0.05, 0.16]} position={[0, -0.97, 0.06]} color="#ffffff" noShadow />
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
      <Box size={[w, 2.0, d]} position={[0, 1.0, 0]} color="#d9bf98" />
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
  return (
    <group position={[at[0], 0, at[1]]}>
      <Cyl r={0.24} rBottom={0.19} h={0.42} position={[0, 0.21, 0]} color="#f3f1ec" seg={20} />
      <Cyl r={0.22} h={0.03} position={[0, 0.41, 0]} color="#5a4636" noShadow seg={20} />
      {tall ? (
        // a tall leafy plant: a stem with round clumps of leaves up it
        <>
          <Cyl r={0.025} h={1.1} position={[0, 0.95, 0]} color="#6b5a3e" seg={6} />
          {[
            [0, 0.85, 0, 0.26],
            [0.12, 1.15, 0.05, 0.22],
            [-0.1, 1.3, -0.04, 0.2],
            [0.02, 1.55, 0.02, 0.18],
          ].map(([x, y, z, r], i) => (
            <Sphere key={i} r={r} position={[x, y, z]} seg={12} color={i % 2 ? '#6dbb6a' : '#53a259'} />
          ))}
        </>
      ) : (
        // a round bush
        <>
          {[
            [0, 0.62, 0, 0.27],
            [0.14, 0.72, 0.06, 0.2],
            [-0.13, 0.74, -0.04, 0.19],
            [0.02, 0.86, -0.02, 0.17],
          ].map(([x, y, z, r], i) => (
            <Sphere key={i} r={r} position={[x, y, z]} seg={12} color={i % 2 ? '#6dbb6a' : '#53a259'} />
          ))}
        </>
      )}
    </group>
  )
}

/** Glass walls of the meeting room and the pantry. */
function GlassRooms({ boss }: { boss: BossRoom }) {
  const h = 2.2
  const glass = { color: '#d8ecf5', opacity: 0.25, roughness: 0.05 }
  const frame = '#2b2f38'
  // [x1, z1, x2, z2] segments; doors are the gaps
  const { bounds: mb, door: md } = MEETING
  const { bounds: pb, door: pd } = PANTRY
  const { bounds: bb, door: bd } = boss
  const segs: [number, number, number, number][] = [
    // the manager's office: glass on its right (the open plan's end), its front has the door
    [bb.maxX, bb.minZ, bb.maxX, bb.maxZ],
    [bb.minX, bb.maxZ, bd.from, bb.maxZ],
    [bd.to, bb.maxZ, bb.maxX, bb.maxZ],
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
    [bb.minX + 0.05, bb.maxZ], [bd.from, bb.maxZ], [bd.to, bb.maxZ], [bb.maxX, bb.maxZ],
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
            <Box size={alongX ? [len, 0.05, 0.07] : [0.07, 0.05, len]} position={[pos[0], h, pos[2]]} color={frame} />
            <Box size={alongX ? [len, 0.05, 0.07] : [0.07, 0.05, len]} position={[pos[0], 0.025, pos[2]]} color={frame} noShadow />
          </group>
        )
      })}
      {posts.map(([x, z]) => (
        <Box key={`${x}:${z}`} size={[0.05, h, 0.07]} position={[x, h / 2, z]} color={frame} />
      ))}
    </group>
  )
}
