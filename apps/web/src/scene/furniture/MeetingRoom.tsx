import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MeshStandardMaterial } from 'three'
import { useOffice } from '../../state/store'
import { FIXED_SPOTS, MEETING, MEETING_PENDANTS } from '../layout'
import { Box, Cyl } from '../prims'
import { Chair } from './Chair'
import { StaticBatch } from '../StaticBatch'
import { Pendant } from './Lamps'

export function MeetingRoom() {
  const { table } = MEETING
  const inMeeting = useOffice((s) => s.agents.some((a) => a.status === 'meeting'))
  const tv = useRef<MeshStandardMaterial>(null!)

  useFrame(() => {
    const t = performance.now() / 1000
    tv.current.emissiveIntensity = inMeeting ? 0.8 + Math.sin(t * 2) * 0.1 : 0.05
  })

  return (
    <StaticBatch version={inMeeting}>
      {/* table */}
      <group position={[table.x, 0, table.z]}>
        <Box size={[table.w, 0.08, table.d]} position={[0, 0.72, 0]} color="#8c6a4f" />
        {[-1, 0, 1].map((k) => (
          <Cyl key={k} r={0.12} h={0.7} position={[(k * table.w) / 3, 0.35, 0]} color="#3b3340" />
        ))}
        {/* laptops & notes */}
        {[-3, -1.5, 0, 1.5, 3].map((x) => (
          <Box key={x} size={[0.3, 0.02, 0.22]} position={[x, 0.77, -0.35]} color="#fbf7f0" noShadow />
        ))}
        <Cyl r={0.08} h={0.14} position={[0.7, 0.83, 0.3]} color="#d9644a" />
      </group>
      {FIXED_SPOTS.filter((s) => s.kind === 'meeting').map((s) => (
        <Chair key={s.id} position={[s.x, 0, s.z]} rotY={s.rotY} color="#4a5d7a" />
      ))}

      {MEETING_PENDANTS.map(([x, z]) => (
        <Pendant key={x} position={[x, 1.85, z]} />
      ))}

      {/* TV on the back wall */}
      <group position={[table.x, 1.5, MEETING.bounds.minZ + 0.06]}>
        <Box size={[3.4, 1.8, 0.08]} color="#1b1d24" />
        <mesh position={[0, 0, 0.045]} userData={{ dynamic: true }}>
          <planeGeometry args={[3.25, 1.65]} />
          <meshStandardMaterial ref={tv} color="#10131c" emissive="#4f7fd9" emissiveIntensity={0.05} />
        </mesh>
        {inMeeting &&
          [0.35, 0.15, -0.05, -0.25].map((y, i) => (
            <mesh key={y} position={[-0.9 + i * 0.1, y, 0.05]}>
              <planeGeometry args={[0.6 + (i % 2) * 0.5, 0.08]} />
              <meshBasicMaterial color={['#ffcb6b', '#c3e88d', '#fbf7f0', '#f78c6c'][i]} toneMapped={false} />
            </mesh>
          ))}
      </group>

      {/* whiteboard on the right side */}
      <group position={[11.65, 0, table.z]} rotation={[0, -Math.PI / 2, 0]}>
        <Box size={[2.0, 1.2, 0.05]} position={[0, 1.4, 0]} color="#fbfbf8" />
        <Box size={[2.1, 0.06, 0.1]} position={[0, 0.78, 0.03]} color="#8a8f99" />
        {[0.2, 0, -0.2].map((y, i) => (
          <Box key={y} size={[1.2 - i * 0.3, 0.04, 0.01]} position={[-0.3, 1.55 + y, 0.03]} color={['#d9644a', '#4a7fd9', '#57b894'][i]} noShadow />
        ))}
        {[-0.9, 0.9].map((x) => (
          <Box key={x} size={[0.04, 1.4, 0.04]} position={[x, 0.7, -0.05]} color="#8a8f99" />
        ))}
      </group>
    </StaticBatch>
  )
}
