// Single source of truth for where everything sits in the office. World units ≈ meters.
// Back walls sit at x = floor.minX and z = -8, so the isometric camera (from +x, +y, +z) looks into the room.
//
// The right side (meeting room, pantry, lounge) is fixed. The open-plan desk area grows to the left
// by one column of 3 desks whenever more agents join, so there is no agent limit.

export type Vec2 = [x: number, z: number]

/** What an agent does once it reaches a spot. */
export type SpotKind = 'desk' | 'meeting' | 'sofa' | 'cat' | 'billiards' | 'pantry' | 'read' | 'pc'

export interface Spot {
  id: string
  kind: SpotKind
  x: number
  z: number
  /** Facing angle. Characters face +z at rotY = 0. */
  rotY: number
}

/** Axis-aligned rectangle (center + size), used for furniture footprints and pathfinding. */
export interface Rect {
  x: number
  z: number
  w: number
  d: number
}

export const MIN_Z = -8
export const MAX_Z = 8
export const MAX_X = 18
export const WALL_H = 3.9

// ── Desks: columns of 3, growing leftwards from x = -1 ──
export const DESK_ROWS = [-5, -1, 3]
export const DESK_COL_GAP = 4
export const MIN_DESK_COLS = 3
export const DESK_SIZE = { w: 2, d: 1, h: 0.75 }
export const CHAIR_OFFSET = 0.85
/** Desk lamp position relative to a desk center. */
export const DESK_LAMP: Vec2 = [0.78, -0.3]

export const deskPos = (i: number): Vec2 => [-1 - DESK_COL_GAP * Math.floor(i / DESK_ROWS.length), DESK_ROWS[i % DESK_ROWS.length]]
export const colsForDesks = (highestDesk: number) => Math.max(MIN_DESK_COLS, Math.ceil((highestDesk + 1) / DESK_ROWS.length))

// ── Meeting room (glass box, back-middle) ──
export const MEETING = {
  bounds: { minX: 1.5, maxX: 12, minZ: MIN_Z, maxZ: -1.5 },
  door: { from: 2.0, to: 3.5 },
  table: { x: 7, z: -4.8, w: 7.6, d: 1.8 },
}
/** 5 seats per side. When every seat is taken, extra agents stay at their desks. */
const SEAT_XS = [4, 5.5, 7, 8.5, 10]
const SEAT_GAP = MEETING.table.d / 2 + 0.45
export const MEETING_PENDANTS: Vec2[] = [
  [MEETING.table.x - 2, MEETING.table.z],
  [MEETING.table.x + 2, MEETING.table.z],
]

// ── Pantry (glass box, back-right) ──
export const PANTRY = {
  bounds: { minX: 12, maxX: MAX_X, minZ: MIN_Z, maxZ: -1.5 },
  door: { from: 12.6, to: 14.0 },
  counter: { x: 14.5, z: -7.6, w: 4.4, d: 0.7 },
  fridge: { x: 17.25, z: -7.5, w: 0.9, d: 0.8 },
  table: { x: 15, z: -4.4, r: 0.75 },
}

// ── The manager's office (glass box, back-left, next to the open plan; it moves left as the open plan grows) ──
/** How wide it is (the building grows by this much on the left). */
export const BOSS_W = 6.5
export interface BossRoom {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** the door in its glass front, at the open plan's end */
  door: { from: number; to: number }
  /** the executive desk: the manager sits behind it (back-wall side), facing the door */
  desk: Rect
  seat: Vec2
  guests: Vec2[]
  shelf: Rect
  rug: Rect
  plant: Vec2
  lamp: Vec2
  /** a two-seat sofa against its left wall */
  sofa: Rect
}
/** The open plan's left edge with `cols` desk columns (the manager's office is left of it). */
export const openMinX = (cols: number) => -1 - DESK_COL_GAP * (cols - 1) - 3
export function bossRoom(cols: number): BossRoom {
  const maxX = openMinX(cols)
  const minX = maxX - BOSS_W
  const cx = minX + BOSS_W / 2
  return {
    bounds: { minX, maxX, minZ: MIN_Z, maxZ: 0.5 },
    door: { from: maxX - 2.1, to: maxX - 0.6 },
    desk: { x: cx + 0.3, z: -4.4, w: DESK_SIZE.w, d: DESK_SIZE.d },
    seat: [cx + 0.3, -4.4 - CHAIR_OFFSET],
    guests: [
      [cx - 0.5, -3.0],
      [cx + 1.1, -3.0],
    ],
    shelf: { x: cx + 0.3, z: MIN_Z + 0.38, w: 3.6, d: 0.5 },
    rug: { x: cx + 0.3, z: -4.2, w: 4.4, d: 4.4 },
    plant: [maxX - 0.55, MIN_Z + 0.6],
    lamp: [minX + 0.55, MIN_Z + 0.55],
    sofa: { x: minX + 0.6, z: -3.0, w: 0.85, d: 2.0 },
  }
}
/**
 * Places in the manager's office, as `boss<name>@<desk columns>` (the room moves with them): its chair (`boss@N`,
 * working / waiting / offline, and idle at its desk), the sofa's two seats and the bookcase (idle), the chair when it
 * interviews someone (`boss-host`) and the visitors' chairs (`boss-guest0/1`, the one being interviewed).
 */
export type BossPlace = '' | '-sofa0' | '-sofa1' | '-shelf' | '-host' | '-guest0' | '-guest1'
export const bossSpot = (cols: number, place: BossPlace = '') => `boss${place}@${cols}`
export const isBossSpot = (id?: string) => !!id && id.startsWith('boss')

function bossPlaceSpot(id: string): Spot {
  const [name, colsRaw] = id.slice(4).split('@')
  const room = bossRoom(Number(colsRaw) || MIN_DESK_COLS)
  const [sx, sz] = room.seat
  switch (name as BossPlace) {
    case '-sofa0':
    case '-sofa1':
      // on the sofa against the left wall, facing into the room (+x)
      return { id, kind: 'sofa', x: room.sofa.x + 0.12, z: room.sofa.z + (name === '-sofa0' ? -0.45 : 0.45), rotY: Math.PI / 2 }
    case '-shelf':
      // browsing the bookcase, facing it
      return { id, kind: 'read', x: room.shelf.x - 1.1, z: room.shelf.z + 0.75, rotY: Math.PI }
    case '-host':
      // at its desk, talking to whoever sits across
      return { id, kind: 'meeting', x: sx, z: sz, rotY: 0 }
    case '-guest0':
    case '-guest1': {
      const [gx, gz] = room.guests[name === '-guest0' ? 0 : 1]
      return { id, kind: 'meeting', x: gx, z: gz, rotY: Math.PI }
    }
    default:
      return { id, kind: 'desk', x: sx, z: sz, rotY: 0 }
  }
}

// ── Lounge (front-right, open) ──
export const LOUNGE = {
  tv: { x: 6.5, z: -1.1, w: 3.6, d: 0.45 },
  sofa: { x: 6.5, z: 1.95, w: 3.0, d: 0.9 },
  coffeeTable: { x: 6.5, z: 0.55, w: 1.4, d: 0.6 },
  floorLamp: [4.4, 2.2] as Vec2,
  billiards: { x: 12.8, z: 4.6, w: 3.2, d: 1.7 },
  catPlay: [5, 5.8] as Vec2,
  catBed: [2.6, 7.2] as Vec2,
  catArea: { minX: 3, maxX: 10, minZ: 3.6, maxZ: 7.6 },
}

export const ENTRANCE: Vec2 = [-3, 7.6]

// ── Outside: sidewalk, parking row, road (in front of the building, +z) ──
export const OUTSIDE = {
  sidewalkZ: 9.2,
  parkZ: 11.8,
  roadZ: 15.6,
  groundMaxZ: 18,
  slotGap: 2.7,
  firstSlotX: MAX_X - 2,
}

/** Each agent parks in its own slot (slot = desk index), filling leftwards like the desks do. */
export const slotPos = (i: number): Vec2 => [OUTSIDE.firstSlotX - OUTSIDE.slotGap * i, OUTSIDE.parkZ]
export type VehicleKind = 'car' | 'moto'
export const vehicleKind = (i: number): VehicleKind => (i % 3 === 1 ? 'moto' : 'car')

/** Where the driver gets out, next to the parked vehicle. */
export const doorPos = (i: number): Vec2 => {
  const [x, z] = slotPos(i)
  return [x + (vehicleKind(i) === 'moto' ? 0.6 : 0.95), z - 0.3]
}

/** Walk from the vehicle door to the office entrance (outdoor legs only; A* handles indoors). */
export const walkInRoute = (i: number): Vec2[] => {
  const [dx] = doorPos(i)
  return [
    [dx, OUTSIDE.sidewalkZ],
    [ENTRANCE[0], OUTSIDE.sidewalkZ],
    ENTRANCE,
  ]
}

/** Vehicle route from the road into slot i (reverse it to leave). Starts off to the right of the lot. */
export const driveInRoute = (i: number, lotMaxX: number): Vec2[] => {
  const [x, z] = slotPos(i)
  return [
    [lotMaxX + 4, OUTSIDE.roadZ],
    [x, OUTSIDE.roadZ],
    [x, z + 1.2],
    [x, z],
  ]
}

// ── Fixed spots (desk spots are generated per desk, see spotById) ──
const facing = (from: Vec2, to: Vec2) => Math.atan2(to[0] - from[0], to[1] - from[1])

function around(id: string, kind: SpotKind, center: Vec2, radius: number, angleDeg: number): Spot {
  const a = (angleDeg * Math.PI) / 180
  const p: Vec2 = [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]
  return { id, kind, x: p[0], z: p[1], rotY: facing(p, center) }
}

export const FIXED_SPOTS: Spot[] = [
  ...SEAT_XS.map((x, i): Spot => ({ id: `meet-${i}`, kind: 'meeting', x, z: MEETING.table.z - SEAT_GAP, rotY: 0 })),
  ...SEAT_XS.map((x, i): Spot => ({ id: `meet-${i + SEAT_XS.length}`, kind: 'meeting', x, z: MEETING.table.z + SEAT_GAP, rotY: Math.PI })),
  ...[-0.9, 0, 0.9].map((dx, i): Spot => ({ id: `sofa-${i}`, kind: 'sofa', x: LOUNGE.sofa.x + dx, z: LOUNGE.sofa.z - 0.1, rotY: Math.PI })),
  around('cat-0', 'cat', LOUNGE.catPlay, 0.8, 200),
  around('cat-1', 'cat', LOUNGE.catPlay, 0.8, 250),
  around('cat-2', 'cat', LOUNGE.catPlay, 0.8, 330),
  { id: 'pool-0', kind: 'billiards', x: LOUNGE.billiards.x - LOUNGE.billiards.w / 2 - 0.55, z: LOUNGE.billiards.z + 0.2, rotY: Math.PI / 2 },
  { id: 'pool-1', kind: 'billiards', x: LOUNGE.billiards.x + LOUNGE.billiards.w / 2 + 0.55, z: LOUNGE.billiards.z - 0.2, rotY: -Math.PI / 2 },
  ...[45, 135, 225, 315].map((deg, i) => around(`pantry-${i}`, 'pantry', [PANTRY.table.x, PANTRY.table.z], 1.1, deg)),
]

const FIXED_BY_ID = new Map(FIXED_SPOTS.map((s) => [s.id, s]))

export function deskSpot(i: number): Spot {
  const [x, z] = deskPos(i)
  return { id: `desk-${i}`, kind: 'desk', x, z: z + CHAIR_OFFSET, rotY: Math.PI }
}

export function spotById(id: string): Spot {
  if (isBossSpot(id)) return bossPlaceSpot(id)
  if (id.startsWith('desk-')) return deskSpot(Number(id.slice(5)))
  // idle at its own desk, watching something on its screen (`pc-<desk>`): the desk's chair, another pose
  if (id.startsWith('pc-')) return { ...deskSpot(Number(id.slice(3))), id, kind: 'pc' }
  return FIXED_BY_ID.get(id) ?? deskSpot(0)
}

// ── Layout that depends on how many desk columns exist ──

export interface Layout {
  cols: number
  /** the open plan's left edge (the manager's office is left of it) */
  openMinX: number
  boss: BossRoom
  floor: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** Outdoor ground (parking + road), wide enough for every parking slot in use. */
  lot: { minX: number; maxX: number; minZ: number; maxZ: number }
  desks: Vec2[]
  plants: Vec2[]
  bookshelf: Rect
  waterCooler: Vec2
  obstacles: Rect[]
}

const cache = new Map<number, Layout>()

export function getLayout(cols: number): Layout {
  const hit = cache.get(cols)
  if (hit) return hit

  // the open plan, and the manager's office left of it
  const minX = openMinX(cols)
  const boss = bossRoom(cols)
  const floor = { minX: boss.bounds.minX, maxX: MAX_X, minZ: MIN_Z, maxZ: MAX_Z }
  const desks = Array.from({ length: cols * DESK_ROWS.length }, (_, i) => deskPos(i))
  const plants: Vec2[] = [
    [minX + 0.7, MIN_Z + 0.7],
    [0.8, MIN_Z + 0.7],
    [minX + 0.7, MAX_Z - 0.8],
    [MAX_X - 0.6, MAX_Z - 0.6],
    [0.9, -0.9],
    [MAX_X - 0.6, -0.9],
    [10.2, MAX_Z - 0.6],
    [boss.bounds.minX + 0.7, MAX_Z - 0.8],
  ]
  // against the building's left wall (in front of the manager's office)
  const bookshelf: Rect = { x: floor.minX + 0.35, z: 5.2, w: 0.5, d: 2.4 }
  const waterCooler: Vec2 = [floor.minX + 0.6, 1.4]
  const { bounds: mb, door: md } = MEETING
  const { bounds: pb, door: pd } = PANTRY

  const obstacles: Rect[] = [
    ...desks.map(([x, z]) => ({ x, z, w: DESK_SIZE.w, d: DESK_SIZE.d })),
    MEETING.table,
    // meeting glass: front (door gap) + left
    { x: (md.to + mb.maxX) / 2, z: mb.maxZ, w: mb.maxX - md.to, d: 0.1 },
    { x: (mb.minX + md.from) / 2, z: mb.maxZ, w: md.from - mb.minX, d: 0.1 },
    { x: mb.minX, z: (mb.minZ + mb.maxZ) / 2, w: 0.1, d: mb.maxZ - mb.minZ },
    { x: 11.6, z: MEETING.table.z, w: 0.3, d: 2.2 }, // whiteboard
    // pantry glass: left (shared with meeting) + front (door gap)
    { x: pb.minX, z: (pb.minZ + pb.maxZ) / 2, w: 0.1, d: pb.maxZ - pb.minZ },
    { x: (pb.minX + pd.from) / 2, z: pb.maxZ, w: pd.from - pb.minX, d: 0.1 },
    { x: (pd.to + pb.maxX) / 2, z: pb.maxZ, w: pb.maxX - pd.to, d: 0.1 },
    PANTRY.counter,
    PANTRY.fridge,
    { x: PANTRY.table.x, z: PANTRY.table.z, w: PANTRY.table.r * 2, d: PANTRY.table.r * 2 },
    // the manager's office: glass on its right (the open plan's end) and in front (door gap), its furniture
    { x: boss.bounds.maxX, z: (boss.bounds.minZ + boss.bounds.maxZ) / 2, w: 0.1, d: boss.bounds.maxZ - boss.bounds.minZ },
    { x: (boss.bounds.minX + boss.door.from) / 2, z: boss.bounds.maxZ, w: boss.door.from - boss.bounds.minX, d: 0.1 },
    { x: (boss.door.to + boss.bounds.maxX) / 2, z: boss.bounds.maxZ, w: boss.bounds.maxX - boss.door.to, d: 0.1 },
    boss.desk,
    boss.shelf,
    boss.sofa,
    ...boss.guests.map(([x, z]) => ({ x, z, w: 0.6, d: 0.6 })),
    { x: boss.plant[0], z: boss.plant[1], w: 0.6, d: 0.6 },
    { x: boss.lamp[0], z: boss.lamp[1], w: 0.4, d: 0.4 },
    LOUNGE.tv,
    LOUNGE.sofa,
    LOUNGE.coffeeTable,
    LOUNGE.billiards,
    { x: LOUNGE.floorLamp[0], z: LOUNGE.floorLamp[1], w: 0.4, d: 0.4 },
    bookshelf,
    { x: waterCooler[0], z: waterCooler[1], w: 0.5, d: 0.5 },
    ...plants.map(([x, z]) => ({ x, z, w: 0.6, d: 0.6 })),
  ]

  const slotsMinX = slotPos(desks.length - 1)[0] - 2
  const lot = { minX: Math.min(floor.minX, slotsMinX) - 1, maxX: MAX_X + 3, minZ: MAX_Z, maxZ: OUTSIDE.groundMaxZ }
  const layout = { cols, openMinX: minX, boss, floor, lot, desks, plants, bookshelf, waterCooler, obstacles }
  cache.set(cols, layout)
  return layout
}
