import { forwardRef } from 'react'
import type { ThreeElements } from '@react-three/fiber'
import type { Mesh } from 'three'

// Low-poly building blocks. Everything in the office is made from these.

type MeshProps = ThreeElements['mesh']
type Tuple3 = [number, number, number]

interface MatProps {
  color: string
  emissive?: string
  emissiveIntensity?: number
  opacity?: number
  roughness?: number
}

function Mat({ color, emissive, emissiveIntensity = 1, opacity, roughness = 0.85 }: MatProps) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={roughness}
      emissive={emissive ?? '#000000'}
      emissiveIntensity={emissive ? emissiveIntensity : 0}
      transparent={opacity !== undefined}
      opacity={opacity ?? 1}
      depthWrite={opacity === undefined}
    />
  )
}

export const Box = forwardRef<Mesh, MeshProps & MatProps & { size: Tuple3; noShadow?: boolean }>(function Box(
  { size, color, emissive, emissiveIntensity, opacity, roughness, noShadow, ...props },
  ref,
) {
  return (
    <mesh ref={ref} castShadow={!noShadow} receiveShadow {...props}>
      <boxGeometry args={size} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})

export const Cyl = forwardRef<
  Mesh,
  MeshProps & MatProps & { r: number; h: number; rBottom?: number; seg?: number; noShadow?: boolean }
>(function Cyl({ r, h, rBottom, seg = 16, color, emissive, emissiveIntensity, opacity, roughness, noShadow, ...props }, ref) {
  return (
    <mesh ref={ref} castShadow={!noShadow} receiveShadow {...props}>
      <cylinderGeometry args={[r, rBottom ?? r, h, seg]} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})

export const Ball = forwardRef<Mesh, MeshProps & MatProps & { r: number }>(function Ball(
  { r, color, emissive, emissiveIntensity, opacity, roughness, ...props },
  ref,
) {
  return (
    <mesh ref={ref} castShadow receiveShadow {...props}>
      <sphereGeometry args={[r, 16, 12]} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})
