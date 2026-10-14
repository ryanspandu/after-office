import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CanvasTexture, SRGBColorSpace, type Group } from 'three'
import type { OfficeTask } from '@after-office/shared'
import { useDashboard } from '../../state/dashboard'
import { BELL_X, MIN_Z, WORK_CORNER } from '../layout'
import { Box, Cyl } from '../prims'
import { StaticBatch } from '../StaticBatch'
import { toonRamp } from '../toon'

// The open plan's work corner, on the back wall between the first two desk columns' windows: the team's kanban board
// (sticky notes for the office's real tasks: to do, in progress, done) over a low counter with an espresso machine and
// the printer; and, under the wall clock, a brass bell that rings when a task is finished.

const WALL = MIN_Z + 0.02
const COUNTER = { w: WORK_CORNER.w, d: WORK_CORNER.d, h: 0.9 }

export function WorkCorner() {
  const x = WORK_CORNER.x
  return (
    <group position={[x, 0, 0]}>
      <KanbanBoard />
      <StaticBatch>
        {/* the counter: cupboard doors, a wood top */}
        <group position={[0, 0, WALL + COUNTER.d / 2]}>
          <Box size={[COUNTER.w, COUNTER.h - 0.05, COUNTER.d]} position={[0, (COUNTER.h - 0.05) / 2, 0]} color="#f1ece3" />
          {[-0.36, 0.36].map((dx) => (
            <Box key={dx} size={[0.68, 0.7, 0.02]} position={[dx, 0.42, COUNTER.d / 2 + 0.01]} color="#e4ddd1" noShadow />
          ))}
          {[-0.06, 0.06].map((dx) => (
            <Box key={dx} size={[0.02, 0.12, 0.03]} position={[dx, 0.55, COUNTER.d / 2 + 0.03]} color="#9a948a" noShadow />
          ))}
          <Box size={[COUNTER.w + 0.06, 0.05, COUNTER.d + 0.04]} position={[0, COUNTER.h, 0]} color="#c9a57a" />
          <Espresso position={[-0.38, COUNTER.h + 0.025, -0.02]} />
          <Printer position={[0.4, COUNTER.h + 0.025, 0]} />
        </group>
      </StaticBatch>
      <Bell position={[BELL_X - x, 1.45, WALL]} />
    </group>
  )
}

/** A chrome espresso machine: two group heads with their handles, a drip tray, cups warming on top. */
function Espresso(props: { position: [number, number, number] }) {
  const CHROME = '#c9ced6'
  return (
    <group {...props}>
      <Box size={[0.62, 0.42, 0.42]} position={[0, 0.21, 0]} color={CHROME} roughness={0.3} />
      <Box size={[0.62, 0.06, 0.42]} position={[0, 0.45, 0]} color="#3b3340" />
      {/* a red stripe across the front, and its gauge */}
      <Box size={[0.62, 0.05, 0.01]} position={[0, 0.34, 0.215]} color="#d9644a" noShadow />
      <Cyl r={0.045} h={0.02} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.34, 0.225]} color="#fbf7f0" noShadow />
      {[-0.15, 0.15].map((dx) => (
        <group key={dx} position={[dx, 0.2, 0.22]}>
          <Cyl r={0.05} h={0.06} position={[0, 0, 0.02]} color="#8a8f98" />
          <Box size={[0.03, 0.03, 0.16]} position={[0, -0.03, 0.12]} color="#2a2a2a" />
        </group>
      ))}
      <Box size={[0.5, 0.03, 0.14]} position={[0, 0.015, 0.27]} color="#3b3340" noShadow />
      {[-0.15, 0.15].map((dx) => (
        <Cyl key={dx} r={0.04} h={0.06} position={[dx, 0.06, 0.27]} color="#fbf7f0" />
      ))}
      {['#fbf7f0', '#e3b341', '#57b894'].map((c, i) => (
        <Cyl key={c} r={0.045} h={0.07} position={[-0.17 + i * 0.17, 0.515, 0]} color={c} />
      ))}
    </group>
  )
}

/** The office printer: grey, a paper tray out front with a printed sheet, a little green light. */
function Printer(props: { position: [number, number, number] }) {
  return (
    <group {...props}>
      <Box size={[0.56, 0.3, 0.44]} position={[0, 0.15, 0]} color="#d7d9dd" />
      <Box size={[0.56, 0.06, 0.44]} position={[0, 0.33, 0]} color="#5a5f68" />
      <Box size={[0.4, 0.02, 0.18]} position={[0, 0.12, 0.3]} color="#5a5f68" noShadow />
      <Box size={[0.3, 0.01, 0.2]} position={[0, 0.135, 0.3]} color="#ffffff" noShadow />
      <Box size={[0.04, 0.02, 0.01]} position={[0.2, 0.25, 0.225]} color="#333" emissive="#5dff9b" emissiveIntensity={2} noShadow />
    </group>
  )
}

// ── the kanban board ──

const COLUMNS: { title: string; has: (t: OfficeTask) => boolean }[] = [
  { title: 'To do', has: (t) => t.status === 'todo' },
  { title: 'In progress', has: (t) => t.status === 'in_progress' },
  { title: 'Done', has: (t) => t.status === 'review' || t.status === 'done' },
]
const NOTE_COLORS = ['#f7d154', '#7fd18b', '#f28fb0', '#7cc4ef', '#f6a35b', '#b99bff']
/** Notes per column at most (2 across, 3 down). */
const NOTES = 6
const BOARD = { w: 1.45, h: 1.0 }
const TEX = { w: 580, h: 400 }

/** The board's face: the three columns' titles, a line between them, a sticky note per task (up to six each). */
function drawBoard(counts: number[]) {
  const canvas = document.createElement('canvas')
  canvas.width = TEX.w
  canvas.height = TEX.h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fbfaf7'
  ctx.fillRect(0, 0, TEX.w, TEX.h)
  const col = TEX.w / 3
  ctx.strokeStyle = '#c9c4ba'
  ctx.lineWidth = 3
  for (let i = 1; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(col * i, 18)
    ctx.lineTo(col * i, TEX.h - 18)
    ctx.stroke()
  }
  ctx.fillStyle = '#2a2d36'
  ctx.font = '700 30px Inter, "Helvetica Neue", Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  COLUMNS.forEach((c, i) => ctx.fillText(c.title, col * i + col / 2, 38))
  ctx.beginPath()
  ctx.moveTo(18, 64)
  ctx.lineTo(TEX.w - 18, 64)
  ctx.stroke()
  // the notes: a little tilted, each with two scribbled lines
  const size = 62
  counts.forEach((n, i) => {
    for (let k = 0; k < Math.min(n, NOTES); k++) {
      const cx = col * i + col / 2 + (k % 2 === 0 ? -38 : 38)
      const cy = 112 + Math.floor(k / 2) * 92
      const tilt = (((i * 7 + k * 13) % 5) - 2) * 0.04
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(tilt)
      ctx.fillStyle = 'rgba(0,0,0,0.12)'
      ctx.fillRect(-size / 2 + 3, -size / 2 + 4, size, size)
      ctx.fillStyle = NOTE_COLORS[(i * 3 + k) % NOTE_COLORS.length]
      ctx.fillRect(-size / 2, -size / 2, size, size)
      ctx.strokeStyle = 'rgba(40,30,20,0.45)'
      ctx.lineWidth = 3
      for (const ly of [-10, 6]) {
        ctx.beginPath()
        ctx.moveTo(-20, ly)
        ctx.lineTo(16 - (k % 3) * 6, ly)
        ctx.stroke()
      }
      ctx.restore()
    }
    // more than fit: "+3"
    if (n > NOTES) {
      ctx.fillStyle = '#6b6457'
      ctx.font = '700 22px Inter, "Helvetica Neue", Arial, sans-serif'
      ctx.fillText(`+${n - NOTES}`, col * i + col / 2, TEX.h - 22)
    }
  })
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

function KanbanBoard() {
  const tasks = useDashboard((s) => s.tasks)
  const key = COLUMNS.map((c) => tasks.filter((t) => !t.forOwner && c.has(t)).length).join(',')
  const texture = useMemo(() => drawBoard(key.split(',').map(Number)), [key])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <group position={[0, 1.82, WALL]}>
      {/* the frame, then the face (redrawn as tasks move: kept out of any batch) */}
      <Box size={[BOARD.w + 0.1, BOARD.h + 0.1, 0.04]} position={[0, 0, 0.02]} color="#9aa0a8" noShadow />
      <mesh position={[0, 0, 0.045]} userData={{ dynamic: true }}>
        <planeGeometry args={[BOARD.w, BOARD.h]} />
        <meshToonMaterial map={texture} gradientMap={toonRamp} />
      </mesh>
      {/* the marker tray, a marker and an eraser on it */}
      <Box size={[BOARD.w * 0.7, 0.04, 0.08]} position={[0, -BOARD.h / 2 - 0.07, 0.06]} color="#9aa0a8" noShadow />
      <Box size={[0.14, 0.03, 0.03]} position={[-0.25, -BOARD.h / 2 - 0.035, 0.07]} color="#4a7fd9" noShadow />
      <Box size={[0.16, 0.05, 0.05]} position={[0.2, -BOARD.h / 2 - 0.03, 0.07]} color="#3b3340" noShadow />
    </group>
  )
}

// ── the bell ──

/** How long it swings after a task is finished (s). */
const RING_S = 2.4

/** A brass bell on a wall bracket: it swings when a task reaches review or done. */
function Bell(props: { position: [number, number, number] }) {
  const finished = useDashboard((s) => s.tasks.filter((t) => t.status === 'review' || t.status === 'done').length)
  const swing = useRef<Group>(null!)
  const ringAt = useRef(-Infinity)
  const seen = useRef<number | null>(null)
  useEffect(() => {
    // the first count is what was already done: no ring on load
    if (seen.current !== null && finished > seen.current) ringAt.current = performance.now()
    seen.current = finished
  }, [finished])
  useFrame(() => {
    const t = (performance.now() - ringAt.current) / 1000
    swing.current.rotation.z = t < RING_S ? Math.sin(t * 14) * 0.45 * (1 - t / RING_S) : 0
  })
  return (
    <group {...props}>
      <StaticBatch>
        {/* the bracket: a plate on the wall, an arm out */}
        <Box size={[0.16, 0.22, 0.03]} position={[0, 0.12, 0.015]} color="#5a4636" noShadow />
        <Box size={[0.04, 0.04, 0.26]} position={[0, 0.2, 0.14]} color="#5a4636" noShadow />
      </StaticBatch>
      <group ref={swing} position={[0, 0.18, 0.25]} userData={{ dynamic: true }}>
        <Cyl r={0.05} rBottom={0.12} h={0.18} position={[0, -0.11, 0]} color="#d9a33a" seg={18} />
        <Cyl r={0.125} h={0.025} position={[0, -0.2, 0]} color="#b8862a" seg={18} />
        <Cyl r={0.03} h={0.04} position={[0, 0, 0]} color="#b8862a" />
        <Cyl r={0.02} h={0.06} position={[0, -0.22, 0]} color="#5a4636" />
      </group>
    </group>
  )
}
