import { windowGlass } from './DayNight'
import { ENTRANCE, MAX_Z, OUTSIDE, slotPos, vehicleKind, type Layout } from './layout'
import { Plant } from './Room'
import { StaticBatch } from './StaticBatch'
import { Box, Cyl } from './prims'
import { lampBulb } from './DayNight'

// Everything outside the front of the building: sidewalk, one long parking row, the road, lamps and trees.

const SIDEWALK = { from: MAX_Z, to: 10.2 }
const LOT = { from: 10.2, to: 13.6 }
const ROAD = { from: 13.6, to: 17.4 }

export function Parking({ layout, slots }: { layout: Layout; slots: number }) {
  const { lot } = layout
  const w = lot.maxX - lot.minX
  const cx = (lot.minX + lot.maxX) / 2
  const strip = (from: number, to: number, color: string, y = 0, h = 0.02) => (
    <Box size={[w, h, to - from]} position={[cx, y - h / 2 + 0.01, (from + to) / 2]} color={color} noShadow />
  )
  const lampXs: number[] = []
  for (let x = lot.maxX - 2; x > lot.minX + 1; x -= 7) lampXs.push(x)
  const treeXs: number[] = []
  for (let x = lot.maxX - 1.5; x > lot.minX + 0.5; x -= 4.5) treeXs.push(x)
  // slot lines for every slot in use plus a few spare ones
  const lineCount = Math.max(slots + 3, 8)

  return (
    <StaticBatch version={`${slots}:${lot.minX}:${lot.maxX}`}>
      {/* diorama base under the whole outdoor area */}
      <Box size={[w, 0.5, lot.maxZ - SIDEWALK.from + 0.2]} position={[cx, -0.26, (SIDEWALK.from + lot.maxZ + 0.2) / 2]} color="#8f8a82" noShadow />
      <Box size={[w + 0.2, 0.3, lot.maxZ - SIDEWALK.from + 0.4]} position={[cx, -0.55, (SIDEWALK.from + lot.maxZ + 0.2) / 2]} color="#4a4540" noShadow />

      {strip(SIDEWALK.from, SIDEWALK.to, '#d9d5cc')}
      {/* curb */}
      <Box size={[w, 0.08, 0.18]} position={[cx, 0.05, SIDEWALK.to]} color="#bdb8ae" />
      {strip(LOT.from, LOT.to, '#5b5d62')}
      {strip(ROAD.from, ROAD.to, '#3d3f44')}
      {strip(ROAD.to, lot.maxZ + 0.2, '#7fa85a')}

      {/* painted bays: one per slot, sized for the car or scooter that parks there */}
      {Array.from({ length: lineCount }, (_, i) => {
        const [x, z] = slotPos(i)
        if (x - 1.3 < lot.minX) return null
        return <Bay key={i} x={x} z={z} kind={vehicleKind(i)} />
      })}
      {/* road markings */}
      {Array.from({ length: Math.floor(w / 3) }, (_, i) => (
        <Box key={i} size={[1.4, 0.01, 0.1]} position={[lot.minX + 1.5 + i * 3, 0.025, (ROAD.from + ROAD.to) / 2]} color="#e9d27a" noShadow />
      ))}
      <Box size={[w, 0.01, 0.06]} position={[cx, 0.025, ROAD.from + 0.25]} color="#d9d5cc" noShadow />
      <Box size={[w, 0.01, 0.06]} position={[cx, 0.025, ROAD.to - 0.25]} color="#d9d5cc" noShadow />

      {/* entrance: doormat + glass door frame on the open front of the building */}
      <group position={[ENTRANCE[0], 0, MAX_Z]}>
        <Box size={[2.2, 0.02, 1.0]} position={[0, 0.02, 0.6]} color="#3a3230" noShadow />
        {[-1.3, 1.3].map((x) => (
          <Box key={x} size={[0.14, 2.5, 0.14]} position={[x, 1.25, 0]} color="#2a2a2a" />
        ))}
        <Box size={[2.74, 0.18, 0.18]} position={[0, 2.5, 0]} color="#2a2a2a" />
        {/* sliding panels, open */}
        {[-1.0, 1.0].map((x) => (
          <mesh key={x} position={[x, 1.2, -0.05]} material={windowGlass}>
            <boxGeometry args={[0.5, 2.3, 0.04]} />
          </mesh>
        ))}
        <Box size={[1.2, 0.26, 0.04]} position={[0, 2.78, 0.02]} color="#151515" noShadow />
        <Box size={[0.9, 0.08, 0.01]} position={[0, 2.78, 0.05]} color="#f5b914" emissive="#f5b914" emissiveIntensity={0.4} noShadow />
      </group>

      {/* street lamps along the sidewalk */}
      {lampXs.map((x) => (
        <group key={x} position={[x, 0, SIDEWALK.to - 0.35]}>
          <Cyl r={0.06} h={3} position={[0, 1.5, 0]} color="#2a2a2a" />
          <Box size={[0.08, 0.06, 0.7]} position={[0, 2.98, 0.3]} color="#2a2a2a" />
          <Box size={[0.3, 0.08, 0.4]} position={[0, 2.93, 0.62]} color="#2a2a2a" noShadow />
          <mesh position={[0, 2.87, 0.62]} material={lampBulb}>
            <boxGeometry args={[0.24, 0.03, 0.32]} />
          </mesh>
        </group>
      ))}

      {treeXs.map((x, i) => (
        <Tree key={x} x={x} z={ROAD.to + 0.35} tall={i % 2 === 0} />
      ))}
      <Plant at={[ENTRANCE[0] - 2, MAX_Z + 0.9]} tall />
      <Plant at={[ENTRANCE[0] + 2, MAX_Z + 0.9]} tall />
    </StaticBatch>
  )
}

const PAINT = '#efece4'

/** Painted parking bay: side lines, back line, a wheel stop for cars and a small marker for scooters. */
function Bay({ x, z, kind }: { x: number; z: number; kind: 'car' | 'moto' }) {
  const w = kind === 'car' ? 2.3 : 1.3
  const d = kind === 'car' ? 3.0 : 2.0
  const back = z - d / 2 + 0.2 // side nearest the building
  return (
    <group position={[x, 0.025, 0]}>
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.07, 0.01, d]} position={[(s * w) / 2, 0, z + 0.2]} color={PAINT} noShadow />
      ))}
      <Box size={[w + 0.07, 0.01, 0.07]} position={[0, 0, back - 0.1]} color={PAINT} noShadow />
      {kind === 'car' ? (
        <Box size={[1.1, 0.1, 0.16]} position={[0, 0.04, back + 0.25]} color="#c9c3b6" />
      ) : (
        <Box size={[0.5, 0.01, 0.5]} position={[0, 0, z + 1.1]} color="#f5b914" noShadow />
      )}
    </group>
  )
}

function Tree({ x, z, tall }: { x: number; z: number; tall?: boolean }) {
  const h = tall ? 1.8 : 1.3
  return (
    <group position={[x, 0, z]}>
      <Cyl r={0.08} rBottom={0.11} h={0.7} position={[0, 0.35, 0]} color="#6b4a33" />
      <mesh position={[0, 0.7 + h / 2, 0]} castShadow>
        <icosahedronGeometry args={[h / 2, 0]} />
        <meshStandardMaterial color={tall ? '#5a9a55' : '#6fae5d'} flatShading roughness={0.9} />
      </mesh>
    </group>
  )
}

/** Street-lamp light positions for DayNight. */
export function streetLampLights(layout: Layout): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let x = layout.lot.maxX - 2; x > layout.lot.minX + 1; x -= 7) out.push([x, 2.7, SIDEWALK.to + 0.3])
  // cap the count: every point light costs on every pixel
  return out.slice(0, 6)
}
