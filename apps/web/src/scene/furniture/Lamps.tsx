import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Material } from 'three'
import { env, lampBulb } from '../DayNight'
import { Box, Cyl } from '../prims'

// Visible light fixtures. Their bulbs share `lampBulb`, which DayNight turns up after dusk.

function Bulb({ r, position, material = lampBulb }: { r: number; position: [number, number, number]; material?: Material }) {
  return (
    <mesh position={position} material={material}>
      <sphereGeometry args={[r, 12, 8]} />
    </mesh>
  )
}

/** Adjustable desk lamp; `position` is the base on the desk top. Only glows when `on` (someone working). */
export function DeskLamp({ position, on }: { position: [number, number, number]; on: boolean }) {
  const bulb = useMemo(() => lampBulb.clone(), [])
  useFrame(() => {
    bulb.emissiveIntensity = on ? 0.1 + env.night * 2.4 : 0.02
  })
  return (
    <group position={position}>
      <Cyl r={0.09} h={0.03} position={[0, 0.015, 0]} color="#2a2a2a" />
      <Box size={[0.03, 0.42, 0.03]} position={[0, 0.22, 0]} rotation={[0.25, 0, 0]} color="#2a2a2a" />
      <group position={[0, 0.42, 0.1]} rotation={[0.6, 0, 0]}>
        <Cyl r={0.05} rBottom={0.12} h={0.14} color="#f5b914" />
        <group userData={{ dynamic: true }}>
          <Bulb r={0.05} position={[0, -0.06, 0]} material={bulb} />
        </group>
      </group>
    </group>
  )
}

/** Pendant hanging from the (invisible) ceiling; `position` is the shade. */
export function Pendant({ position, color = '#2a2a2a' }: { position: [number, number, number]; color?: string }) {
  return (
    <group position={position}>
      <Box size={[0.02, 1.2, 0.02]} position={[0, 0.65, 0]} color="#333" noShadow />
      <Cyl r={0.08} rBottom={0.32} h={0.22} color={color} noShadow />
      <Bulb r={0.09} position={[0, -0.1, 0]} />
    </group>
  )
}

export function FloorLamp({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <Cyl r={0.16} h={0.04} position={[0, 0.02, 0]} color="#2a2a2a" />
      <Cyl r={0.025} h={1.5} position={[0, 0.77, 0]} color="#2a2a2a" />
      <Cyl r={0.16} rBottom={0.24} h={0.3} position={[0, 1.6, 0]} color="#f3ead9" />
      <Bulb r={0.08} position={[0, 1.5, 0]} />
    </group>
  )
}
