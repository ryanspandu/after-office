import type { OfficeAgent } from '../../state/store'
import { WALL_H, type BossRoom } from '../layout'
import { Box, Cyl } from '../prims'
import { Chair } from './Chair'
import { Workstation } from './Workstation'
import { Pendant } from './Lamps'
import { lampBulb } from '../DayNight'

// The manager's office (scene/layout.ts bossRoom, left of the open plan): its desk turned round so the manager sits with its back to the wall,
// facing the door; two chairs for visitors, a sofa, a bookcase, a rug, a lamp and a plant; a crown sign on the wall.

const WOOD = '#6b4a34'
const BOOKS = ['#d9644a', '#4a7fd9', '#e3b341', '#57b894', '#a879e0', '#3b3340']

export function BossOffice({ room, manager }: { room: BossRoom; manager?: OfficeAgent }) {
  const { desk, guests, shelf, rug, plant, lamp, sofa, bounds } = room
  return (
    <group>
      {/* rug under the desk and the visitors' chairs */}
      <Box size={[rug.w, 0.02, rug.d]} position={[rug.x, 0.03, rug.z]} color="#7d4b4b" noShadow />
      <Box size={[rug.w - 0.4, 0.021, rug.d - 0.4]} position={[rug.x, 0.031, rug.z]} color="#9a5c55" noShadow />

      {/* the desk, turned round: the chair behind it (wall side), the screen facing the manager */}
      <group position={[desk.x, 0, desk.z]} rotation={[0, Math.PI, 0]}>
        <Workstation at={[0, 0]} owner={manager} index={2} />
      </group>

      {/* a pendant over the desk, lit at night (DayNight bossLamps) */}
      <Pendant position={[desk.x, 2.3, desk.z + 0.3]} color="#3b3340" />

      {/* visitors face the desk */}
      {guests.map(([x, z], i) => (
        <Chair key={i} position={[x, 0, z]} rotY={Math.PI} color="#8b5e3c" />
      ))}

      {/* bookcase on the back wall */}
      <group position={[shelf.x, 0, shelf.z]}>
        <Box size={[shelf.w, 2.1, shelf.d]} position={[0, 1.05, 0]} color={WOOD} />
        {[0.5, 1.1, 1.7].map((y, row) =>
          Array.from({ length: 9 }, (_, i) => (
            <Box
              key={`${row}-${i}`}
              size={[0.22, 0.36 + ((i + row) % 3) * 0.06, 0.3]}
              position={[-shelf.w / 2 + 0.35 + i * 0.36, y + 0.02, 0.06]}
              color={BOOKS[(i + row * 2) % BOOKS.length]}
              noShadow
            />
          )),
        )}
      </group>

      {/* a two-seat sofa against the left wall */}
      <group position={[sofa.x, 0, sofa.z]}>
        <Box size={[sofa.w, 0.4, sofa.d]} position={[0, 0.25, 0]} color="#3f5a7a" />
        <Box size={[0.22, 0.55, sofa.d]} position={[-(sofa.w / 2 - 0.11), 0.6, 0]} color="#344b66" />
        {[-1, 1].map((s) => (
          <Box key={s} size={[sofa.w, 0.5, 0.18]} position={[0, 0.45, s * (sofa.d / 2 - 0.09)]} color="#344b66" />
        ))}
      </group>

      {/* floor lamp in the corner */}
      <group position={[lamp[0], 0, lamp[1]]}>
        <Cyl r={0.18} h={0.05} position={[0, 0.025, 0]} color="#2a2d36" />
        <Cyl r={0.03} h={1.6} position={[0, 0.85, 0]} color="#2a2d36" />
        <Cyl r={0.12} rBottom={0.28} h={0.35} position={[0, 1.75, 0]} color="#f3e3c3" emissive="#ffd99a" emissiveIntensity={0.6} />
        {/* the bulb under the shade glows after dusk (DayNight) */}
        <mesh position={[0, 1.62, 0]} material={lampBulb}>
          <sphereGeometry args={[0.09, 12, 8]} />
        </mesh>
      </group>

      {/* a plant by the glass */}
      <group position={[plant[0], 0, plant[1]]}>
        <Cyl r={0.25} rBottom={0.2} h={0.45} position={[0, 0.225, 0]} color="#3b3340" />
        <Cyl r={0} rBottom={0.4} h={1.4} position={[0, 1.15, 0]} color="#4f9a5b" seg={7} />
      </group>

      {/* the crown sign on the back wall, above the bookcase */}
      <group position={[shelf.x, WALL_H - 0.95, bounds.minZ + 0.03]}>
        <Box size={[2.2, 0.7, 0.04]} color="#2a2d36" noShadow />
        <Box size={[0.9, 0.12, 0.05]} position={[0, -0.12, 0.01]} color="#e8b94a" emissive="#e8b94a" emissiveIntensity={0.4} noShadow />
        {[-0.3, 0, 0.3].map((x, i) => (
          <Box key={i} size={[0.14, i === 1 ? 0.3 : 0.22, 0.05]} position={[x, i === 1 ? 0.08 : 0.04, 0.01]} color="#e8b94a" emissive="#e8b94a" emissiveIntensity={0.4} noShadow />
        ))}
      </group>
    </group>
  )
}
