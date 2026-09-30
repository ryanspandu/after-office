import { Box, Cyl } from '../prims'

/** Office chair. Faces +z at rotY = 0 (backrest on -z). */
export function Chair({ position, rotY = 0, color = '#3b3f4d' }: { position: [number, number, number]; rotY?: number; color?: string }) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Box size={[0.52, 0.08, 0.5]} position={[0, 0.42, 0]} color={color} />
      <Box size={[0.5, 0.5, 0.07]} position={[0, 0.72, -0.24]} color={color} />
      <Cyl r={0.04} h={0.36} position={[0, 0.2, 0]} color="#8a8f99" />
      <Box size={[0.5, 0.04, 0.08]} position={[0, 0.04, 0]} color="#2a2d36" />
      <Box size={[0.08, 0.04, 0.5]} position={[0, 0.04, 0]} color="#2a2d36" />
    </group>
  )
}
