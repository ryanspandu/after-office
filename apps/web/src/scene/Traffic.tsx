import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, CanvasTexture, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Group } from 'three'
import { env } from './DayNight'
import { Vehicle } from './Vehicle'

// Cars and motorbikes driving round the town's streets: a few of the town's own, and agents who are off (asleep) out
// for a ride (scene/Agent.tsx). Each picks its way at every crossroads (on, left or right, never back), keeps to its
// lane (on the left, as in Indonesia), sometimes waits a moment before it turns, and slows down behind whoever is in
// front: no two drives the same, nothing reads as a loop. The office's own stretch of the front road (its car park,
// where the agents come and go) is left to them.

type Dir = 0 | 1 | 2 | 3
/** +x, +z, −x, −z */
const DIRS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]
/** The lane's distance from the road's middle line, and how far before a crossroads a turn starts. */
const LANE = 1.1
const TURN = 1.7
/** Room kept behind the one in front (world units), how quickly they speed up and slow down. */
const GAP = 3.4
const ACCEL = 3
const BRAKE = 9

/**
 * The streets: `xs` the middle lines of the roads along z (west to east), `zs` of the roads along x (north to south);
 * a crossroads where each pair meets. `closed`: a stretch along x not driven, [z index, x index] (to x index + 1).
 * `home`: the crossroads by the office's car park, where the agents leave the streets for it.
 */
export type Streets = { xs: number[]; zs: number[]; closed?: [number, number]; home: [number, number] }

/** The town's streets, set by the city (scene/City.tsx) for the agents who drive out. */
export let streets: Streets | null = null
export const setStreets = (s: Streets) => void (streets = s)

type Piece =
  | { kind: 'line'; from: [number, number]; to: [number, number]; len: number }
  | { kind: 'curve'; from: [number, number]; via: [number, number]; to: [number, number]; len: number }
  | { kind: 'wait'; len: number }

/** Everyone on the streets now (to keep their distance from each other). */
const onRoad = new Set<Driver>()

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]

/** One vehicle finding its own way round the streets. */
export class Driver {
  x = 0
  z = 0
  heading = 0
  /** set by goHome: drives to the car park's crossroads, then `home` turns true and it stops there */
  home = false
  private homing = false
  /** the crossroads it drives towards, its heading */
  private i = 0
  private j = 0
  private dir: Dir = 0
  /** where the next leg starts */
  private at: [number, number] = [0, 0]
  private pieces: Piece[] = []
  /** along the first piece (world units, or seconds for a wait) */
  private s = 0
  private speed = 0
  /** a slow drift of its cruising speed, so none keeps one pace */
  private phase = Math.random() * 100

  constructor(
    private net: Streets,
    private cruise: number,
  ) {}

  private open(i: number, j: number, d: Dir) {
    const [dx, dz] = DIRS[d]
    const ni = i + dx
    const nj = j + dz
    if (ni < 0 || nj < 0 || ni >= this.net.xs.length || nj >= this.net.zs.length) return false
    const closed = this.net.closed
    if (closed && dz === 0 && j === closed[0] && Math.min(i, ni) === closed[1]) return false
    return true
  }
  /** the lane's offset for a heading: to the left of it */
  private static left(d: Dir): [number, number] {
    const [dx, dz] = DIRS[d]
    return [dz * LANE, -dx * LANE]
  }

  /** On a street at random, part way along it. */
  placeRandom() {
    const { xs, zs } = this.net
    for (;;) {
      const i = Math.floor(Math.random() * xs.length)
      const j = Math.floor(Math.random() * zs.length)
      const dir = Math.floor(Math.random() * 4) as Dir
      const back = ((dir + 2) % 4) as Dir
      if (!this.open(i, j, back)) continue
      const [bx, bz] = DIRS[back]
      const [lx, lz] = Driver.left(dir)
      this.start(i, j, dir, [xs[i + bx] + lx, zs[j + bz] + lz])
      this.s = Math.random() * (this.pieces[0]?.len ?? 0) * 0.8
      this.place()
      return this
    }
  }

  /** From `at`, heading `dir` for the crossroads (i, j). */
  start(i: number, j: number, dir: Dir, at: [number, number]) {
    Object.assign(this, { i, j, dir, at, pieces: [], s: 0, home: false, homing: false })
    this.x = at[0]
    this.z = at[1]
    this.heading = Math.atan2(DIRS[dir][0], DIRS[dir][1])
    this.plan()
    onRoad.add(this)
    return this
  }

  /** Off the streets (parked, or gone). */
  leave() {
    onRoad.delete(this)
  }

  /** Back to the car park: the shortest way to its crossroads from wherever it is. */
  goHome() {
    this.homing = true
  }

  /** How many crossroads from (i, j) to the car park's, by the open streets. */
  private hops(i: number, j: number) {
    const { xs, zs, home } = this.net
    const seen = new Map<string, number>([[`${i},${j}`, 0]])
    const queue: Array<[number, number]> = [[i, j]]
    while (queue.length) {
      const [a, b] = queue.shift()!
      const n = seen.get(`${a},${b}`)!
      if (a === home[0] && b === home[1]) return n
      for (const d of [0, 1, 2, 3] as Dir[]) {
        if (!this.open(a, b, d)) continue
        const key = `${a + DIRS[d][0]},${b + DIRS[d][1]}`
        if (seen.has(key)) continue
        seen.set(key, n + 1)
        queue.push([a + DIRS[d][0], b + DIRS[d][1]])
      }
    }
    return xs.length + zs.length
  }

  /** The next leg: to the crossroads (i, j), then on through it or round a corner. */
  private plan() {
    const { xs, zs, home } = this.net
    const [nx, nz] = [xs[this.i], zs[this.j]]
    const [lx, lz] = Driver.left(this.dir)
    const [dx, dz] = DIRS[this.dir]
    const line = (from: [number, number], to: [number, number]) => this.pieces.push({ kind: 'line', from, to, len: Math.hypot(to[0] - from[0], to[1] - from[1]) })
    // heading home and this is its crossroads: up to it, and stop there
    if (this.homing && this.i === home[0] && this.j === home[1]) {
      const end: [number, number] = [nx, nz]
      line(this.at, end)
      this.at = end
      this.pieces.push({ kind: 'wait', len: Infinity })
      return
    }
    let options = ([0, 1, 2, 3] as Dir[]).filter((d) => d !== (this.dir + 2) % 4 && this.open(this.i, this.j, d))
    // no way on but back (shouldn't happen on a grid): turn round
    if (!options.length) options = [((this.dir + 2) % 4) as Dir]
    let next: Dir
    if (this.homing) {
      // the way that gets it home soonest
      next = options.reduce((a, b) => (this.hops(this.i + DIRS[b][0], this.j + DIRS[b][1]) < this.hops(this.i + DIRS[a][0], this.j + DIRS[a][1]) ? b : a))
    } else {
      // on more often than a turn
      const turns = options.filter((d) => d !== this.dir)
      next = options.includes(this.dir) && (Math.random() < 0.55 || !turns.length) ? this.dir : pick(turns)
    }
    if (next === this.dir) {
      const end: [number, number] = [nx + lx, nz + lz]
      line(this.at, end)
      this.at = end
    } else {
      const [ox, oz] = Driver.left(next)
      const [ex, ez] = DIRS[next]
      // the corner where the two lanes cross, and a curve round it
      const corner: [number, number] = [nx + lx + ox, nz + lz + oz]
      const into: [number, number] = [corner[0] - dx * TURN, corner[1] - dz * TURN]
      const out: [number, number] = [corner[0] + ex * TURN, corner[1] + ez * TURN]
      line(this.at, into)
      // now and then a stop before turning (crossing traffic, a light)
      if (Math.random() < 0.3) this.pieces.push({ kind: 'wait', len: 0.6 + Math.random() * 2.2 })
      this.pieces.push({ kind: 'curve', from: into, via: corner, to: out, len: TURN * 1.6 })
      this.at = out
    }
    this.i += DIRS[next][0]
    this.j += DIRS[next][1]
    this.dir = next
  }

  /** Drive on by `dt` seconds (`t`: the clock, for the pace's drift). */
  step(dt: number, t: number) {
    // a gap ahead: brake for whoever is in front in the same lane
    let blocked = false
    const hx = Math.sin(this.heading)
    const hz = Math.cos(this.heading)
    for (const o of onRoad) {
      if (o === this) continue
      const vx = o.x - this.x
      const vz = o.z - this.z
      const along = vx * hx + vz * hz
      if (along > 0 && along < GAP && Math.abs(vx * hz - vz * hx) < 1) blocked = true
    }
    const p = this.pieces[0]
    const waiting = p?.kind === 'wait'
    // home: stopped at its crossroads
    if (waiting && p.len === Infinity) {
      this.home = true
      this.speed = 0
      return
    }
    const want = blocked || waiting ? 0 : this.cruise * (1 + 0.12 * Math.sin(t * 0.21 + this.phase))
    this.speed += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, want - this.speed))
    this.s += waiting ? dt : this.speed * dt
    // on to the next piece(s)
    while (this.pieces.length && this.s >= this.pieces[0].len) {
      this.s -= this.pieces[0].len
      this.pieces.shift()
      if (this.pieces.length < 2 && !(this.pieces[0]?.kind === 'wait' && this.pieces[0].len === Infinity)) this.plan()
    }
    this.place()
  }

  private place() {
    const cur = this.pieces[0]
    if (!cur || cur.kind === 'wait') return
    const k = Math.min(1, this.s / cur.len)
    let tx: number, tz: number
    if (cur.kind === 'line') {
      this.x = cur.from[0] + (cur.to[0] - cur.from[0]) * k
      this.z = cur.from[1] + (cur.to[1] - cur.from[1]) * k
      tx = cur.to[0] - cur.from[0]
      tz = cur.to[1] - cur.from[1]
    } else {
      // a quadratic curve through the corner's control point
      const u = 1 - k
      this.x = u * u * cur.from[0] + 2 * u * k * cur.via[0] + k * k * cur.to[0]
      this.z = u * u * cur.from[1] + 2 * u * k * cur.via[1] + k * k * cur.to[1]
      tx = 2 * u * (cur.via[0] - cur.from[0]) + 2 * k * (cur.to[0] - cur.via[0])
      tz = 2 * u * (cur.via[1] - cur.from[1]) + 2 * k * (cur.to[1] - cur.via[1])
    }
    if (tx || tz) this.heading = Math.atan2(tx, tz)
  }
}

const CAR_COLORS = ['#d9644a', '#3e7cc4', '#e8e4dc', '#2f3136', '#c9a03a', '#5f8f6a', '#a3a7ad']
const MOTO_COLORS = ['#d22b2b', '#1f4fa8', '#2a2a2a', '#efefec']
const RIDERS = ['#3b6fb6', '#d9644a', '#5f8f6a', '#e3b341', '#6b4a8a']

/**
 * At night each throws its headlights on the road ahead: a soft warm patch, painted (additive, no real light), the
 * shared material's strength following the night.
 */
const beam = (() => {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  // brightest near the car (the bottom of the picture), fading out ahead and to the sides
  const g = ctx.createRadialGradient(32, 120, 4, 32, 96, 90)
  g.addColorStop(0, 'rgba(255,240,200,1)')
  g.addColorStop(0.5, 'rgba(255,225,160,0.45)')
  g.addColorStop(1, 'rgba(255,220,150,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 128)
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  return new MeshBasicMaterial({ map: t, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false })
})()
const BEAM = new PlaneGeometry(1, 1)

/** A vehicle's headlights on the road ahead (put it in the vehicle's group: it faces +z). */
export function Headlights({ kind }: { kind: 'car' | 'moto' }) {
  return (
    <mesh
      geometry={BEAM}
      material={beam}
      position={[0, 0.05, kind === 'car' ? 3.4 : 2.4]}
      rotation={[-Math.PI / 2, 0, Math.PI]}
      scale={kind === 'car' ? [2.4, 4, 1] : [1.4, 3, 1]}
    />
  )
}

/** The town's own traffic (the agents' rides are drawn with the agents). */
export function Traffic({ net, cars = 4, motos = 3 }: { net: Streets; cars?: number; motos?: number }) {
  const fleet = useMemo(() => {
    const make = (kind: 'car' | 'moto') => ({
      kind,
      color: kind === 'car' ? pick(CAR_COLORS) : pick(MOTO_COLORS),
      rider: kind === 'moto' ? pick(RIDERS) : undefined,
      driver: new Driver(net, kind === 'car' ? 4 + Math.random() * 2 : 5 + Math.random() * 2.2).placeRandom(),
    })
    return [...Array.from({ length: cars }, () => make('car')), ...Array.from({ length: motos }, () => make('moto'))]
    // the streets are fixed for a layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net.xs.join(), net.zs.join(), net.closed?.join(), cars, motos])

  // off the streets with the city
  useEffect(() => () => fleet.forEach((c) => c.driver.leave()), [fleet])

  const groups = useRef<Array<Group | null>>([])

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.1)
    beam.opacity = env.night * 0.6
    fleet.forEach((c, n) => {
      c.driver.step(dt, clock.elapsedTime)
      const g = groups.current[n]
      if (!g) return
      g.position.set(c.driver.x, 0.02, c.driver.z)
      g.rotation.y = c.driver.heading
    })
  })

  return (
    <group>
      {fleet.map((c, n) => (
        <group key={n} ref={(g) => void (groups.current[n] = g)} userData={{ dynamic: true }}>
          <Vehicle kind={c.kind} color={c.color} riderColor={c.rider} />
          <Headlights kind={c.kind} />
        </group>
      ))}
    </group>
  )
}
