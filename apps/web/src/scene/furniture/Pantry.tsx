import { FIXED_SPOTS, PANTRY } from '../layout'
import { Box, Cyl } from '../prims'
import { StaticBatch } from '../StaticBatch'
import { Pendant } from './Lamps'

// Kitchen corner: counter with sink, coffee machine and microwave, a fridge, and a round table with stools.

const WOOD = '#8c6a4f'
const CABINET = '#e9e2d6'
const STEEL = '#c0c4cc'

export function Pantry() {
  const { counter, fridge, table } = PANTRY
  const top = 0.95
  return (
    <StaticBatch>
      {/* base cabinets + worktop */}
      <group position={[counter.x, 0, counter.z]}>
        <Box size={[counter.w, top - 0.05, counter.d]} position={[0, (top - 0.05) / 2, 0]} color={CABINET} />
        {Array.from({ length: 5 }, (_, i) => (
          <Box
            key={i}
            size={[counter.w / 5 - 0.06, 0.02, 0.02]}
            position={[-counter.w / 2 + (i + 0.5) * (counter.w / 5), top - 0.2, counter.d / 2 + 0.01]}
            color="#9a948a"
            noShadow
          />
        ))}
        <Box size={[counter.w + 0.05, 0.05, counter.d + 0.05]} position={[0, top, 0]} color="#3a3230" />
        {/* sink */}
        <Box size={[0.6, 0.02, 0.4]} position={[-1.2, top + 0.03, 0.05]} color={STEEL} roughness={0.3} noShadow />
        <Box size={[0.04, 0.3, 0.04]} position={[-1.2, top + 0.15, -0.2]} color={STEEL} />
        <Box size={[0.04, 0.04, 0.2]} position={[-1.2, top + 0.3, -0.12]} color={STEEL} />
        {/* coffee machine */}
        <group position={[0.1, top + 0.02, -0.05]}>
          <Box size={[0.45, 0.5, 0.4]} position={[0, 0.25, 0]} color={STEEL} roughness={0.3} />
          <Box size={[0.3, 0.06, 0.1]} position={[0, 0.2, 0.22]} color="#2a2d36" />
          <Box size={[0.03, 0.03, 0.03]} position={[0.15, 0.42, 0.21]} color="#333" emissive="#5dff9b" emissiveIntensity={2} noShadow />
        </group>
        {/* mugs */}
        {['#fbf7f0', '#d9644a', '#57b894', '#f5b914'].map((c, i) => (
          <Cyl key={c} r={0.05} h={0.09} position={[0.55 + i * 0.14, top + 0.07, 0.15]} color={c} />
        ))}
        {/* microwave */}
        <group position={[1.6, top + 0.02, -0.05]}>
          <Box size={[0.6, 0.35, 0.4]} position={[0, 0.175, 0]} color="#2a2a2a" />
          <Box size={[0.38, 0.24, 0.01]} position={[-0.07, 0.18, 0.205]} color="#111" emissive="#ffb35c" emissiveIntensity={0.15} noShadow />
        </group>
        {/* upper cabinets on the wall */}
        <Box size={[counter.w, 0.7, 0.35]} position={[0, 2.1, -0.15]} color={CABINET} />
        {Array.from({ length: 4 }, (_, i) => (
          <Box key={i} size={[0.02, 0.6, 0.02]} position={[-counter.w / 2 + (i + 1) * (counter.w / 5), 2.1, 0.03]} color="#9a948a" noShadow />
        ))}
      </group>

      {/* fridge */}
      <group position={[fridge.x, 0, fridge.z]}>
        <Box size={[fridge.w, 2.0, fridge.d]} position={[0, 1.0, 0]} color="#f3f3f1" roughness={0.4} />
        <Box size={[fridge.w - 0.02, 0.02, 0.01]} position={[0, 1.3, fridge.d / 2 + 0.005]} color="#bdbdb8" noShadow />
        <Box size={[0.04, 0.4, 0.04]} position={[-fridge.w / 2 + 0.12, 1.6, fridge.d / 2 + 0.03]} color={STEEL} />
        <Box size={[0.04, 0.5, 0.04]} position={[-fridge.w / 2 + 0.12, 0.85, fridge.d / 2 + 0.03]} color={STEEL} />
        {/* magnets */}
        <Box size={[0.12, 0.08, 0.01]} position={[0.15, 1.7, fridge.d / 2 + 0.01]} color="#f07a1d" noShadow />
        <Box size={[0.1, 0.1, 0.01]} position={[0.05, 1.5, fridge.d / 2 + 0.01]} color="#f5b914" noShadow />
      </group>

      {/* round table + stools */}
      <group position={[table.x, 0, table.z]}>
        <Cyl r={table.r} h={0.05} position={[0, 0.74, 0]} color={WOOD} seg={28} />
        <Cyl r={0.06} h={0.72} position={[0, 0.36, 0]} color="#2a2a2a" />
        <Cyl r={0.35} h={0.03} position={[0, 0.015, 0]} color="#2a2a2a" seg={20} />
        <Cyl r={0.06} h={0.1} position={[0.2, 0.82, 0.1]} color="#fbf7f0" />
        <Box size={[0.3, 0.02, 0.22]} position={[-0.2, 0.775, -0.1]} rotation={[0, 0.4, 0]} color="#f3ead9" noShadow />
      </group>
      {FIXED_SPOTS.filter((s) => s.kind === 'pantry').map((s) => (
        <group key={s.id} position={[s.x, 0, s.z]}>
          <Cyl r={0.2} h={0.05} position={[0, 0.44, 0]} color="#f5b914" />
          <Cyl r={0.03} h={0.42} position={[0, 0.21, 0]} color="#2a2a2a" />
          <Cyl r={0.16} h={0.02} position={[0, 0.01, 0]} color="#2a2a2a" />
        </group>
      ))}
      <Pendant position={[table.x, 1.8, table.z]} color="#f5b914" />

      {/* "PANTRY" plate above the door */}
      <Box size={[1.1, 0.26, 0.04]} position={[(PANTRY.door.from + PANTRY.door.to) / 2, 2.4, PANTRY.bounds.maxZ]} color="#151515" noShadow />
    </StaticBatch>
  )
}
