import { forwardRef, useMemo } from 'react'
import type { ThreeElements } from '@react-three/fiber'
import { Vector2, type Mesh } from 'three'

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

// ── rounded shapes: the people (scene/figure.tsx) are made of these ──

type Shape = MeshProps & MatProps & { noShadow?: boolean }

/** A pill: two half-spheres joined by a cylinder, along y. `length` is the straight middle (total height + 2r). */
export const Capsule = forwardRef<Mesh, Shape & { r: number; length: number }>(function Capsule(
  { r, length, color, emissive, emissiveIntensity, opacity, roughness, noShadow, ...props },
  ref,
) {
  return (
    <mesh ref={ref} castShadow={!noShadow} receiveShadow {...props}>
      <capsuleGeometry args={[r, length, 6, 14]} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})

/** A ball (optionally only its top part: `cap` is how far down from the top it goes, in radians; π = whole). */
export const Sphere = forwardRef<Mesh, Shape & { r: number; cap?: number; seg?: number }>(function Sphere(
  { r, cap = Math.PI, seg = 18, color, emissive, emissiveIntensity, opacity, roughness, noShadow, ...props },
  ref,
) {
  return (
    <mesh ref={ref} castShadow={!noShadow} receiveShadow {...props}>
      <sphereGeometry args={[r, seg, Math.max(6, Math.round((seg * 2) / 3)), 0, Math.PI * 2, 0, cap]} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})

/** A ring (around y unless rotated): a scarf, a band, a lens. `arc` < 2π for part of it. */
export const Ring = forwardRef<Mesh, Shape & { r: number; tube: number; arc?: number }>(function Ring(
  { r, tube, arc = Math.PI * 2, color, emissive, emissiveIntensity, opacity, roughness, noShadow, ...props },
  ref,
) {
  return (
    <mesh ref={ref} castShadow={!noShadow} receiveShadow {...props}>
      <torusGeometry args={[r, tube, 8, 24, arc]} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})

/** A shape turned around y from a side profile ([radius, y] pairs, bottom to top): a torso, a vase. */
export const Lathe = forwardRef<Mesh, Shape & { profile: [number, number][]; seg?: number }>(function Lathe(
  { profile, seg = 20, color, emissive, emissiveIntensity, opacity, roughness, noShadow, ...props },
  ref,
) {
  const points = useMemo(() => profile.map(([r, y]) => new Vector2(r, y)), [profile])
  return (
    <mesh ref={ref} castShadow={!noShadow} receiveShadow {...props}>
      <latheGeometry args={[points, seg]} />
      <Mat {...{ color, emissive, emissiveIntensity, opacity, roughness }} />
    </mesh>
  )
})
