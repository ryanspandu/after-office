import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CanvasTexture, SRGBColorSpace } from 'three'
import type { OfficeAgent } from '../../state/store'
import { WALL_H, type BossRoom, type Vec2 } from '../layout'
import { agentPose } from '../focus'
import { Box, Cyl } from '../prims'
import { Chair } from './Chair'
import { Workstation } from './Workstation'
import { Pendant } from './Lamps'
import { lampBulb } from '../DayNight'

// The manager's office (scene/layout.ts bossRoom, left of the open plan): its desk turned round so the manager sits with its back to the wall,
// facing the door; two chairs for visitors, a sofa, a whiteboard, a rug, a lamp and a plant; a crown sign on the wall.

// ── the whiteboard: what the manager writes on it appears stroke by stroke (scene/Agent.tsx 'write' pose) ──

/** The board's canvas (2:1, like the board). */
const BOARD = { w: 512, h: 256 }
/** Seconds to fill the board, to look at it full, then it's wiped and started again. */
const WRITE_S = 26
const HOLD_S = 5

interface Stroke {
  color: string
  width: number
  pts: [number, number][]
}

/** A plan in marker: a title, bullet points (two ticked off), a little flow of boxes and arrows, a bar chart. */
function boardStrokes(): Stroke[] {
  const out: Stroke[] = []
  const ink = '#1f2a44'
  const blue = '#2f6fd9'
  const red = '#d9442f'
  const wave = (x0: number, x1: number, y: number, amp: number, color: string, width = 3) => {
    const pts: [number, number][] = []
    for (let x = x0; x <= x1; x += 6) pts.push([x, y + Math.sin(x * 0.35) * amp + Math.sin(x * 0.11) * amp * 0.6])
    out.push({ color, width, pts })
  }
  // the title and its underline
  wave(36, 210, 40, 5, ink, 4)
  out.push({ color: ink, width: 3, pts: [[32, 60], [222, 58]] })
  // bullets: a dot, a line of writing; the first two ticked off in red
  ;[92, 128, 164, 200].forEach((y, i) => {
    const pts: [number, number][] = []
    for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.6) pts.push([44 + Math.cos(a) * 3, y + Math.sin(a) * 3])
    out.push({ color: ink, width: 3, pts })
    wave(58, 150 + ((i * 47) % 70), y, 3.5, ink)
    if (i < 2) out.push({ color: red, width: 4, pts: [[214, y - 2], [222, y + 7], [238, y - 10]] })
  })
  // a flow: three boxes with arrows between them
  const box = (x: number, y: number) => out.push({ color: blue, width: 3, pts: [[x, y], [x + 62, y], [x + 62, y + 36], [x, y + 36], [x, y]] })
  const arrow = (x0: number, x1: number, y: number) => {
    out.push({ color: blue, width: 3, pts: [[x0, y], [x1, y]] })
    out.push({ color: blue, width: 3, pts: [[x1 - 8, y - 6], [x1, y], [x1 - 8, y + 6]] })
  }
  box(282, 34)
  arrow(348, 372, 52)
  box(376, 34)
  out.push({ color: blue, width: 3, pts: [[407, 74], [407, 96]] })
  out.push({ color: blue, width: 3, pts: [[401, 90], [407, 98], [413, 90]] })
  box(376, 102)
  // a bar chart going up
  out.push({ color: ink, width: 3, pts: [[284, 140], [284, 222], [372, 222]] })
  ;[[298, 196], [318, 178], [338, 160], [358, 146]].forEach(([x, top]) =>
    out.push({ color: red, width: 3, pts: [[x, 220], [x, top], [x + 12, top], [x + 12, 220]] }),
  )
  return out
}

/** Draw the strokes up to `progress` (0 → 1 of all of them, the current one partly). */
function drawBoard(g: CanvasRenderingContext2D, strokes: Stroke[], progress: number) {
  g.fillStyle = '#fbfbf8'
  g.fillRect(0, 0, BOARD.w, BOARD.h)
  // faint traces of earlier wipes
  g.fillStyle = 'rgba(120,130,150,0.06)'
  g.fillRect(260, 20, 220, 50)
  const lengths = strokes.map((s) => s.pts.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - s.pts[i - 1][0], p[1] - s.pts[i - 1][1]) : 0), 0))
  const total = lengths.reduce((a, b) => a + b, 0)
  let left = progress * total
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (let i = 0; i < strokes.length && left > 0; i++) {
    const s = strokes[i]
    g.strokeStyle = s.color
    g.lineWidth = s.width
    g.beginPath()
    g.moveTo(s.pts[0][0], s.pts[0][1])
    for (let k = 1; k < s.pts.length && left > 0; k++) {
      const [ax, ay] = s.pts[k - 1]
      const [bx, by] = s.pts[k]
      const seg = Math.hypot(bx - ax, by - ay)
      if (seg <= left) g.lineTo(bx, by)
      else g.lineTo(ax + ((bx - ax) * left) / seg, ay + ((by - ay) * left) / seg)
      left -= seg
    }
    g.stroke()
  }
}

/**
 * A whiteboard on a stand. While the manager stands at it (`writing`), the plan appears stroke by stroke; full, it
 * stays a moment, is wiped, and starts again. Otherwise it shows the last plan as it was left.
 */
function Whiteboard({ at, width, writerId }: { at: Vec2; width: number; writerId?: string }) {
  const h = width / 2
  const board = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = BOARD.w
    canvas.height = BOARD.h
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    const g = canvas.getContext('2d')!
    const strokes = boardStrokes()
    drawBoard(g, strokes, 1)
    return { g, texture, strokes }
  }, [])
  useEffect(() => () => board?.texture.dispose(), [board])
  // seconds of writing done so far: it only moves on while the manager is at the board, writing (not on its way, not
  // gone): a stroke stops where it was and goes on when it's back
  const written = useRef(WRITE_S)
  const last = useRef(-1)
  useFrame((_, dt) => {
    if (!board) return
    const writing = !!writerId && agentPose.get(writerId) === 'write'
    if (!writing) return
    // a full board when it starts writing again: wiped first
    if (written.current >= WRITE_S + HOLD_S) written.current = 0
    written.current += Math.min(dt, 0.1)
    const t = written.current
    const progress = Math.min(1, t / WRITE_S)
    // redraw only when it moved on visibly
    if (Math.abs(progress - last.current) < 0.004) return
    last.current = progress
    drawBoard(board.g, board.strokes, progress)
    board.texture.needsUpdate = true
  })
  return (
    <group position={[at[0], 0, at[1]]}>
      {/* the stand: two legs on wheeled feet */}
      {[-1, 1].map((sd) => (
        <group key={sd} position={[sd * (width / 2 - 0.1), 0, 0]}>
          <Box size={[0.05, 1.95, 0.05]} position={[0, 0.975, 0]} color="#b9bec7" />
          <Box size={[0.08, 0.05, 0.5]} position={[0, 0.06, 0]} color="#8a8f99" />
          {[-0.2, 0.2].map((z) => (
            <Cyl key={z} r={0.035} h={0.04} position={[0, 0.02, z]} rotation={[0, 0, Math.PI / 2]} color="#2a2d36" />
          ))}
        </group>
      ))}
      {/* the board: an aluminium frame, the white surface (its writing), a tray with markers */}
      <group position={[0, 1.45, 0.03]}>
        <Box size={[width + 0.08, h + 0.08, 0.05]} color="#c9ccd2" roughness={0.4} />
        <mesh position={[0, 0, 0.027]} userData={{ dynamic: true }}>
          <planeGeometry args={[width, h]} />
          <meshStandardMaterial map={board?.texture ?? null} roughness={0.35} />
        </mesh>
        <Box size={[width * 0.6, 0.03, 0.08]} position={[0, -h / 2 - 0.05, 0.05]} color="#b9bec7" />
        {['#1f2a44', '#2f6fd9', '#d9442f'].map((c, i) => (
          <Box key={c} size={[0.12, 0.025, 0.025]} position={[-0.2 + i * 0.16, -h / 2 - 0.025, 0.06]} color={c} noShadow />
        ))}
      </group>
    </group>
  )
}

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

      {/* the whiteboard on its stand: the manager plans on it when idle */}
      <Whiteboard at={[shelf.x, shelf.z]} width={shelf.w - 0.3} writerId={manager?.id} />

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
