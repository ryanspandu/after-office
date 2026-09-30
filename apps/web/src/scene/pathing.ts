import type { Layout, Vec2 } from './layout'

// Tiny grid A* over the office floor. One grid is baked per layout (desk column count) and cached.

const CELL = 0.5
const PAD = 0.3 // body radius-ish clearance around obstacles
const WALL_PAD = 0.4

interface Grid {
  minX: number
  minZ: number
  w: number
  h: number
  blocked: Uint8Array
}

const grids = new WeakMap<Layout, Grid>()

function gridFor(layout: Layout): Grid {
  const hit = grids.get(layout)
  if (hit) return hit
  const { floor, obstacles } = layout
  const w = Math.round((floor.maxX - floor.minX) / CELL)
  const h = Math.round((floor.maxZ - floor.minZ) / CELL)
  const grid: Grid = { minX: floor.minX, minZ: floor.minZ, w, h, blocked: new Uint8Array(w * h) }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const [x, z] = center(grid, i, j)
      const nearWall = x < floor.minX + WALL_PAD || z < floor.minZ + WALL_PAD || x > floor.maxX - 0.25 || z > floor.maxZ - 0.25
      const hit = obstacles.some((r) => Math.abs(x - r.x) < r.w / 2 + PAD && Math.abs(z - r.z) < r.d / 2 + PAD)
      grid.blocked[j * w + i] = nearWall || hit ? 1 : 0
    }
  grids.set(layout, grid)
  return grid
}

function center(g: Grid, i: number, j: number): Vec2 {
  return [g.minX + (i + 0.5) * CELL, g.minZ + (j + 0.5) * CELL]
}

function cellOf(g: Grid, [x, z]: Vec2): [number, number] {
  const i = Math.min(g.w - 1, Math.max(0, Math.floor((x - g.minX) / CELL)))
  const j = Math.min(g.h - 1, Math.max(0, Math.floor((z - g.minZ) / CELL)))
  return [i, j]
}

const isFree = (g: Grid, i: number, j: number) => i >= 0 && j >= 0 && i < g.w && j < g.h && !g.blocked[j * g.w + i]

/** Nearest walkable cell (ring search), for targets that sit inside furniture like chairs/sofas. */
function nearestFree(g: Grid, i: number, j: number): [number, number] {
  if (isFree(g, i, j)) return [i, j]
  for (let r = 1; r < 8; r++) {
    let best: [number, number] | null = null
    let bestD = Infinity
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !isFree(g, i + di, j + dj)) continue
        const d = di * di + dj * dj
        if (d < bestD) (bestD = d), (best = [i + di, j + dj])
      }
    if (best) return best
  }
  return [i, j]
}

function lineOfSight(g: Grid, a: Vec2, b: Vec2): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const steps = Math.ceil(len / 0.2)
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    const [i, j] = cellOf(g, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    if (!isFree(g, i, j)) return false
  }
  return true
}

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
] as const

/** Returns waypoints from `from` to `to` (excluding `from`, including exact `to`). */
export function findPath(layout: Layout, from: Vec2, to: Vec2): Vec2[] {
  const G = gridFor(layout)
  const W = G.w
  const H = G.h
  const [si, sj] = nearestFree(G, ...cellOf(G, from))
  const [gi, gj] = nearestFree(G, ...cellOf(G, to))
  const start = sj * W + si
  const goal = gj * W + gi

  const g = new Float32Array(W * H).fill(Infinity)
  const came = new Int32Array(W * H).fill(-1)
  const closed = new Uint8Array(W * H)
  const open: number[] = [start]
  const f = new Float32Array(W * H).fill(Infinity)
  const h = (n: number) => Math.hypot((n % W) - gi, Math.floor(n / W) - gj)
  g[start] = 0
  f[start] = h(start)

  while (open.length) {
    let bi = 0
    for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k
    const cur = open.splice(bi, 1)[0]
    if (cur === goal) break
    closed[cur] = 1
    const ci = cur % W
    const cj = Math.floor(cur / W)
    for (const [di, dj, cost] of NEIGHBORS) {
      const ni = ci + di
      const nj = cj + dj
      if (!isFree(G, ni, nj)) continue
      if (di && dj && (!isFree(G, ci + di, cj) || !isFree(G, ci, cj + dj))) continue // no corner cutting
      const n = nj * W + ni
      if (closed[n]) continue
      const ng = g[cur] + cost
      if (ng < g[n]) {
        if (g[n] === Infinity) open.push(n)
        g[n] = ng
        f[n] = ng + h(n)
        came[n] = cur
      }
    }
  }

  const cells: Vec2[] = []
  for (let n = goal; n !== -1; n = came[n]) {
    cells.push(center(G, n % W, Math.floor(n / W)))
    if (n === start) break
  }
  cells.reverse()
  const raw: Vec2[] = [from, ...cells, to]

  // String-pull: skip waypoints we can see past.
  const out: Vec2[] = []
  let i = 0
  while (i < raw.length - 1) {
    let j = raw.length - 1
    while (j > i + 1 && !lineOfSight(G, raw[i], raw[j])) j--
    out.push(raw[j])
    i = j
  }
  return out
}
