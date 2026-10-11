import { Box, Capsule, Cyl, Sphere } from '../prims'

/** Office chair: a soft rounded seat and back on a five-star base. Faces +z at rotY = 0 (backrest on -z). */
export function Chair({ position, rotY = 0, color = '#3b3f4d' }: { position: [number, number, number]; rotY?: number; color?: string }) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Sphere r={0.29} position={[0, 0.44, 0.01]} scale={[1, 0.2, 0.95]} color={color} />
      <Sphere r={0.27} position={[0, 0.78, -0.25]} scale={[1, 0.95, 0.22]} color={color} />
      <Capsule r={0.025} length={0.22} position={[0, 0.58, -0.27]} rotation={[0.2, 0, 0]} color="#8a8f99" />
      <Cyl r={0.035} h={0.36} position={[0, 0.22, 0]} color="#8a8f99" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Box key={i} size={[0.05, 0.035, 0.3]} position={[Math.sin((i * 2 * Math.PI) / 5) * 0.14, 0.05, Math.cos((i * 2 * Math.PI) / 5) * 0.14]} rotation={[0, (i * 2 * Math.PI) / 5, 0]} color="#2a2d36" />
      ))}
    </group>
  )
}
