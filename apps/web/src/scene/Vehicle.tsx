import { forwardRef } from 'react'
import { Color, MeshStandardMaterial, type Group } from 'three'
import type { VehicleKind } from './layout'
import { Box, Cyl } from './prims'
import { StaticBatch } from './StaticBatch'

// Low-poly car and scooter. Both face +z at rotY = 0. Positioned by the owning Agent each frame.

/** Head/tail lights shared by every vehicle; DayNight turns them up after dusk. */
export const headlight = new MeshStandardMaterial({ color: '#fffbe6', emissive: new Color('#fff1c4'), emissiveIntensity: 0.2, toneMapped: false })
export const taillight = new MeshStandardMaterial({ color: '#7a1b14', emissive: new Color('#ff3b2f'), emissiveIntensity: 0.2, toneMapped: false })
// animated by DayNight: StaticBatch keeps these exact instances
headlight.userData.live = true
taillight.userData.live = true

function Wheel({ position, r = 0.2, w = 0.16 }: { position: [number, number, number]; r?: number; w?: number }) {
  return (
    <group position={position}>
      <Cyl r={r} h={w} rotation={[0, 0, Math.PI / 2]} color="#1b1b1b" seg={14} />
      <Cyl r={r * 0.5} h={w + 0.02} rotation={[0, 0, Math.PI / 2]} color="#b8bcc4" seg={10} noShadow />
    </group>
  )
}

function Car({ color }: { color: string }) {
  return (
    <group>
      <Box size={[1.05, 0.42, 2.1]} position={[0, 0.38, 0]} color={color} roughness={0.35} />
      <Box size={[0.95, 0.38, 1.15]} position={[0, 0.78, -0.1]} color={color} roughness={0.35} />
      {/* glass */}
      <Box size={[0.97, 0.3, 0.02]} position={[0, 0.78, 0.48]} rotation={[-0.35, 0, 0]} color="#1d2733" roughness={0.1} noShadow />
      <Box size={[0.97, 0.3, 0.02]} position={[0, 0.78, -0.68]} rotation={[0.35, 0, 0]} color="#1d2733" roughness={0.1} noShadow />
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.02, 0.26, 0.95]} position={[s * 0.485, 0.8, -0.1]} color="#1d2733" roughness={0.1} noShadow />
      ))}
      {/* lights */}
      {[-0.35, 0.35].map((x) => (
        <mesh key={`h${x}`} position={[x, 0.42, 1.055]} material={headlight}>
          <boxGeometry args={[0.22, 0.1, 0.02]} />
        </mesh>
      ))}
      {[-0.38, 0.38].map((x) => (
        <mesh key={`t${x}`} position={[x, 0.45, -1.055]} material={taillight}>
          <boxGeometry args={[0.2, 0.08, 0.02]} />
        </mesh>
      ))}
      <Box size={[1.08, 0.1, 0.06]} position={[0, 0.2, 1.06]} color="#2a2a2a" noShadow />
      {[
        [-0.5, 0.2, 0.68],
        [0.5, 0.2, 0.68],
        [-0.5, 0.2, -0.68],
        [0.5, 0.2, -0.68],
      ].map((p) => (
        <Wheel key={p.join()} position={p as [number, number, number]} />
      ))}
    </group>
  )
}

function Moto({ color, rider }: { color: string; rider?: string }) {
  return (
    <group>
      <Wheel position={[0, 0.22, 0.52]} r={0.22} w={0.1} />
      <Wheel position={[0, 0.22, -0.52]} r={0.22} w={0.1} />
      <Box size={[0.3, 0.22, 0.9]} position={[0, 0.42, -0.05]} color={color} roughness={0.35} />
      <Box size={[0.26, 0.1, 0.5]} position={[0, 0.58, -0.2]} color="#1b1b1b" />
      <Box size={[0.28, 0.5, 0.12]} position={[0, 0.62, 0.38]} rotation={[-0.3, 0, 0]} color={color} roughness={0.35} />
      <Box size={[0.6, 0.04, 0.04]} position={[0, 0.9, 0.42]} color="#2a2a2a" />
      <mesh position={[0, 0.72, 0.46]} material={headlight}>
        <boxGeometry args={[0.12, 0.08, 0.02]} />
      </mesh>
      <mesh position={[0, 0.5, -0.52]} material={taillight}>
        <boxGeometry args={[0.1, 0.06, 0.02]} />
      </mesh>
      {rider && (
        // helmeted rider, only shown while driving (the agent itself is hidden then)
        <group name="rider" position={[0, 0.62, -0.18]} userData={{ dynamic: true }}>
          <Box size={[0.36, 0.5, 0.26]} position={[0, 0.3, 0]} rotation={[0.2, 0, 0]} color={rider} />
          <Box size={[0.34, 0.32, 0.34]} position={[0, 0.72, 0.06]} color="#f5f5f2" roughness={0.3} />
          <Box size={[0.26, 0.1, 0.02]} position={[0, 0.72, 0.24]} color="#1d2733" noShadow />
        </group>
      )}
    </group>
  )
}

export const Vehicle = forwardRef<Group, { kind: VehicleKind; color: string; riderColor?: string }>(function Vehicle({ kind, color, riderColor }, ref) {
  // the body is rigid: one batch (a car is ~19 meshes otherwise); the rider is shown/hidden, so it stays separate
  return (
    <group ref={ref}>
      <StaticBatch version={`${kind}:${color}`}>{kind === 'car' ? <Car color={color} /> : <Moto color={color} rider={riderColor} />}</StaticBatch>
    </group>
  )
})
