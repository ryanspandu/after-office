import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, BoxGeometry, DoubleSide, BufferGeometry, Float32BufferAttribute, CanvasTexture, CircleGeometry, Color, MathUtils, MeshBasicMaterial, MeshToonMaterial, SRGBColorSpace, type Group, type PointLight, type Material, type Mesh, type Vector3 } from 'three'
import { env, lampBulb, windowGlass } from './DayNight'
import { ENTRANCE, OUTSIDE, type Layout, type Vec2 } from './layout'
import { useRenderConfig } from './quality'
import { Box, Cyl } from './prims'
import { StaticBatch } from './StaticBatch'
import poplinkLogo from '../assets/brands/poplink.png'
import orenjusLogo from '../assets/brands/orenjus.svg'
import driftlessLogo from '../assets/brands/driftless.svg'
import { setSeats, type Seat } from './outings'
import { setStreets, Traffic, type Streets } from './Traffic'
import { toonRamp } from './toon'

// The town around the office: a grid of streets (the front one, with the parking lot, is one of them) and city blocks
// between them, the office's in the middle. Each block has a pavement with big trees round it and two rows of buildings
// of many kinds (plain, glass towers, stepped, rooftop gardens), some with banners, billboards or a giant video screen.
// Taller behind and to the left (behind the office from the usual view), lower to the right and in front. On the block
// left of the office: a coffee shop and a warung pecel lele under its painted tarp. Windows light up at night. All
// static: each part is one batch (StaticBatch); the tall parts are cut away like the office's walls when the view is
// turned so that they'd stand between the camera and the office.

/** One storey of the town's buildings (the office itself is one tall storey, 3.9). */
const FLOOR = 2.6
// the palette: sunny yellow, orange and red-orange for warmth and accents, lavender grey and deep purple for the rest
const P = { yellow: '#f2c230', orange: '#f2921d', red: '#f24f13', lavender: '#8082a6', purple: '#46334f' }
/** The buildings' neutrals: concrete, stone, ivory, greige, warm greys, charcoal. */
const N = { charcoal: '#4a4a4f', graphite: '#3c3d42', steel: '#5d6168', concrete: '#b9b6b0', stone: '#d6d2ca', ivory: '#efebe3', greige: '#c8c0b4', warmGrey: '#a39d94', light: '#e6e4df' }
const ROAD = '#3b3a40'
const PAVING = '#ddd7d4'
const KERB = '#b9b3c4'
const MARK = P.yellow

// ── shared materials ──

/** Windows that light up at night (warm), and ones that stay dark. */
const litWindow = new MeshToonMaterial({ color: '#a9b4c2', emissive: new Color('#ffc46b'), emissiveIntensity: 0, gradientMap: toonRamp })
litWindow.userData.live = true
const darkWindow = new MeshToonMaterial({ color: '#4f5560', gradientMap: toonRamp })
const WIN = new BoxGeometry(0.8, 1.15, 0.06)
/** The shop signs' materials: they glow at night (their emissive is their own picture). */
const glowing = new Set<MeshToonMaterial>()

/** Inside a shop at night: a warm glow behind its glass, under its tarp. */
const shopGlow = new MeshToonMaterial({ color: '#3a3230', emissive: new Color('#ffb85c'), emissiveIntensity: 0, gradientMap: toonRamp })
shopGlow.userData.live = true
/** Warm light pools on the pavement in front of the shops at night (painted light, not real lights: cheap). */
const pools = new Set<MeshBasicMaterial>()
const POOL = new CircleGeometry(1, 32)
function LightPool({ r, position }: { r: number; position: [number, number, number] }) {
  const material = useMemo(() => {
    const m = new MeshBasicMaterial({ color: '#ffb85c', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false })
    pools.add(m)
    return m
  }, [])
  return <mesh geometry={POOL} material={material} position={position} rotation={[-Math.PI / 2, 0, 0]} scale={r} />
}
/** A bare bulb (glows at night: the office's lamp material). */
const Bulb = ({ position }: { position: [number, number, number] }) => (
  <mesh position={position} material={lampBulb}>
    <sphereGeometry args={[0.07, 10, 8]} />
  </mesh>
)

/**
 * The town's banners and billboards: one material per picture, shared by every sign showing it (lit at night like the
 * other signs), so all the signs of a batch draw together (StaticBatch keeps a material marked live by identity).
 */
const adMaterials = new Map<string, MeshToonMaterial>()
function adMaterial(texture: CanvasTexture) {
  let m = adMaterials.get(texture.uuid)
  if (!m) {
    m = new MeshToonMaterial({ map: texture, gradientMap: toonRamp, emissive: new Color('#ffffff'), emissiveMap: texture, emissiveIntensity: 0 })
    m.userData.live = true
    glowing.add(m)
    adMaterials.set(texture.uuid, m)
  }
  return m
}
/** A banner or billboard face (a plane facing +z). */
function AdSign({ texture, w, h, ...props }: { texture: CanvasTexture; w: number; h: number; position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <mesh {...props} material={adMaterial(texture)}>
      <planeGeometry args={[w, h]} />
    </mesh>
  )
}

/** A sign painted on a canvas (text lines, each with its own size and colour). */
function signTexture(w: number, h: number, bg: string, lines: { text: string; size: number; color: string; y: number; weight?: number }[], border?: string) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  if (border) {
    ctx.strokeStyle = border
    ctx.lineWidth = Math.max(4, h * 0.04)
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const l of lines) {
    ctx.fillStyle = l.color
    ctx.font = `${l.weight ?? 900} ${l.size}px Inter, "Arial Black", "Helvetica Neue", Arial, sans-serif`
    ctx.fillText(l.text, w / 2, l.y)
  }
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  return t
}

/** A flat painted sign (a plane facing +z). */
function Sign({ texture, w, h, glow, ...props }: { texture: CanvasTexture; w: number; h: number; glow?: boolean; position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <mesh {...props} userData={glow ? { dynamic: true } : undefined}>
      <planeGeometry args={[w, h]} />
      <meshToonMaterial
        ref={(m: MeshToonMaterial | null) => {
          if (m && glow) glowing.add(m)
        }}
        map={texture}
        gradientMap={toonRamp}
        emissive={glow ? '#ffffff' : '#000000'}
        emissiveMap={glow ? texture : null}
        emissiveIntensity={0}
      />
    </mesh>
  )
}

// ── a deterministic "random" so the town is the same on every visit ──

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Light greys, nearly white (the colour is in the signs); now and then a yellow one. */
// light greys a touch cool: the warm grade (scene/Outline.tsx) pulls light colours towards cream, which is the office's
// own wall colour; a cool grey comes out of it still grey
const FACADES = ['#d4d8de', '#cdd1d8', '#dadde2', '#c6cad1', '#d0d4da', '#dfe2e6', '#c9cdd4', '#d6d9df', '#ccd0d6', P.yellow]
const ROOFS = ['#a3a4a9', '#9a9ba0', '#b3b4b8', '#8f9096']

/** What the banners and billboards say (made up: a town's shops, not real brands), and their colours. */
const AD_TEXTS = [
  'SALE 50%', 'NOW OPEN', 'GYM 24/7', 'HOTEL', 'RAMEN', 'COWORKING', 'LAUNDRY', 'KARAOKE', 'PHARMACY', 'BOOKS',
  'ARCADE', 'SUSHI', 'PIZZA', 'BURGERS', 'BAKERY', 'FLOWERS', 'BARBER', 'DENTIST', 'BANK', 'TOYS',
  'PET SHOP', 'SHOES', 'CINEMA', 'BOBA TEA', 'DONUTS', 'TACOS', 'YOGA', 'SPA', 'GAMES', 'TECH STORE',
]
/** Banner colours (background, text): the palette's warm accents, cream, lavender, a few others. */
const AD_COLORS: [string, string][] = [
  [P.red, '#fff6e0'], [P.yellow, P.purple], [P.purple, P.yellow], [P.lavender, '#ffffff'], [P.orange, P.purple],
  ['#efe6d6', P.purple], ['#7fb6d9', '#ffffff'], [P.red, P.yellow], ['#3fae5a', '#ffffff'], [P.yellow, P.red],
  ['#b99bff', P.purple], ['#fff3dc', P.red], ['#1f4fa8', '#ffffff'],
]
const ADS: { text: string; bg: string; fg: string }[] = AD_TEXTS.map((text, i) => ({ text, bg: AD_COLORS[(i * 5) % AD_COLORS.length][0], fg: AD_COLORS[(i * 5) % AD_COLORS.length][1] }))
const adTextures = new Map<string, CanvasTexture>()
/** A vertical banner (the text read top to bottom) or a wide billboard; one texture per text and shape. */
function adTexture(i: number, vertical: boolean) {
  const ad = ADS[i % ADS.length]
  const key = `${ad.text}:${vertical}`
  const hit = adTextures.get(key)
  if (hit) return hit
  const [w, h] = vertical ? [256, 900] : [1024, 340]
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = ad.bg
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = ad.fg
  ctx.lineWidth = 10
  ctx.strokeRect(14, 14, w - 28, h - 28)
  ctx.fillStyle = ad.fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (vertical) {
    ctx.translate(w / 2, h / 2)
    ctx.rotate(Math.PI / 2)
    ctx.font = `900 ${Math.min(150, 1500 / ad.text.length)}px Inter, "Arial Black", Arial, sans-serif`
    ctx.fillText(ad.text, 0, 8)
  } else {
    ctx.font = `900 ${Math.min(190, 1600 / ad.text.length)}px Inter, "Arial Black", Arial, sans-serif`
    ctx.fillText(ad.text, w / 2, h / 2 + 8)
  }
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  adTextures.set(key, t)
  return t
}

interface Bld {
  x: number
  z: number
  w: number
  d: number
  floors: number
  color: string
  roof: string
  seed: number
  /** which side faces the usual view (+z or +x): its banner goes there */
  show?: 'z' | 'x'
  /** a black glass tower (one or two in the town, behind the office) */
  black?: boolean
}

/**
 * A city block (x0–x1 × z0–z1, its edge the kerb): a pavement round it and two rows of buildings, one along each
 * long side, their fronts on its road. `floors`: how tall they get.
 */
function fillBlock(x0: number, x1: number, z0: number, z1: number, floors: [number, number], seed: number, show: 'z' | 'x' = 'z'): Bld[] {
  const S = 1.6
  const r = rng(seed)
  const depth = Math.max(4, Math.min(10, (z1 - z0 - 2 * S) / 2 - 0.6))
  const out: Bld[] = []
  for (const row of [0, 1]) {
    const z = row ? z1 - S - depth / 2 : z0 + S + depth / 2
    for (let x = x0 + S; x < x1 - S - 4; ) {
      const w = Math.min(6 + Math.round(r() * 5), x1 - S - x)
      out.push({
        x: x + w / 2,
        z,
        w,
        d: depth - r() * 1.5,
        floors: floors[0] + Math.floor(r() * (floors[1] - floors[0] + 1)),
        color: FACADES[Math.floor(r() * FACADES.length)],
        roof: ROOFS[Math.floor(r() * ROOFS.length)],
        seed: Math.floor(r() * 1e6),
        show,
      })
      x += w + 1 + Math.round(r() * 2)
    }
  }
  return out
}

type Kind = 'block' | 'glass' | 'stepped' | 'garden'

/** A curtain-wall tower's glass, by tower (a black one stands out): black, steel blue, grey teal, slate. */
const GLASS_TINTS = ['#2f3d4f', '#3d4a4f', '#4a5566', '#34404f']
/** A glass pane with someone working late behind it: the tower's dark glass by day, lit at night. */
const nightPane = new MeshToonMaterial({ color: '#2b2f38', emissive: new Color('#ffc46b'), emissiveIntensity: 0, gradientMap: toonRamp })
nightPane.userData.live = true

/**
 * A glass tower: one sheer wall of glass (no bands), a thin frame of floor lines and mullions over it on the sides the
 * usual view sees, and here and there a lit pane at night.
 */
/** Lit panes on the glass towers at night: off (they look like a checkerboard on dark glass). */
const NIGHT_PANES = false

function CurtainWall({ w, d, floors, black, seed }: { w: number; d: number; floors: number; black: boolean; seed: number }) {
  const h = floors * FLOOR
  const r = rng(seed + 3)
  const glass = black ? '#15161a' : GLASS_TINTS[seed % GLASS_TINTS.length]
  const frame = black ? '#2c2f36' : '#b9bec6'
  const cols = (len: number) => Math.max(2, Math.round(len / 1.6))
  const parts: ReactNode[] = []
  // the two seen faces: +z (front) and +x (right)
  for (const [len, k] of [
    [w, 'f'],
    [d, 'r'],
  ] as const) {
    const at = (u: number, y: number): [number, number, number] => (k === 'f' ? [u, y, d / 2 + 0.03] : [w / 2 + 0.03, y, u])
    const rot = k === 'f' ? 0 : Math.PI / 2
    const n = cols(len)
    for (let c = 1; c < n; c++) parts.push(<Box key={`m${k}${c}`} size={[0.06, h, 0.04]} position={at(-len / 2 + (len / n) * c, h / 2)} rotation={[0, rot, 0]} color={frame} noShadow />)
    for (let f = 1; f < floors; f++) parts.push(<Box key={`l${k}${f}`} size={[len, 0.06, 0.04]} position={at(0, f * FLOOR)} rotation={[0, rot, 0]} color={frame} noShadow />)
    for (let f = 0; f < floors; f++)
      for (let c = 0; c < n; c++)
        // glass towers stay dark at night (they all read as black glass then): lit panes on them look like a checkerboard
        if (NIGHT_PANES && r() < 0.22)
          parts.push(
            <mesh key={`p${k}${f}-${c}`} position={at(-len / 2 + (len / n) * (c + 0.5), f * FLOOR + FLOOR / 2)} rotation={[0, rot, 0]} material={nightPane}>
              <boxGeometry args={[len / n - 0.12, FLOOR - 0.14, 0.02]} />
            </mesh>,
          )
  }
  return (
    <>
      <Box size={[w, h, d]} position={[0, h / 2, 0]} color={glass} roughness={0.3} />
      {parts}
    </>
  )
}

/**
 * A building of the town, one of four kinds: a plain block with windows; a glass tower (bands of glass, one per
 * floor); a stepped one (a narrower top); a block with a rooftop garden (grass, planters, little trees, a parasol).
 * Some carry a vertical banner on the side that faces the usual view, some tall ones a billboard on the roof.
 */
function Building({ b }: { b: Bld }) {
  const { x, z, w, d, floors, color, roof } = b
  const h = floors * FLOOR
  const r = rng(b.seed)
  const roll = r()
  const kind: Kind = b.black ? 'glass' : roll < 0.4 ? 'block' : roll < 0.6 ? 'glass' : roll < 0.8 && floors >= 5 ? 'stepped' : floors <= 7 ? 'garden' : 'block'
  // a stepped building's lower part; the rest is the narrower top
  const lowFloors = kind === 'stepped' ? Math.ceil(floors * 0.6) : floors
  const lowH = lowFloors * FLOOR
  const windows: ReactNode[] = []
  const face = (len: number, from: number, to: number, place: (u: number, y: number) => [number, number, number], rotY: number, key: string) => {
    const cols = Math.max(1, Math.floor((len - 0.8) / 1.5))
    const step = len / cols
    for (let f = from; f < to; f++)
      for (let c = 0; c < cols; c++) {
        const u = -len / 2 + step * (c + 0.5)
        const y = f * FLOOR + FLOOR * 0.55
        // about a quarter of the windows have someone working late
        windows.push(<mesh key={`${key}${f}-${c}`} geometry={WIN} material={r() < 0.28 ? litWindow : darkWindow} position={place(u, y)} rotation={[0, rotY, 0]} />)
      }
  }
  const sides = (bw: number, bd: number, from: number, to: number, key: string) => {
    // only on the two sides the usual view sees (+z, +x): a whole town of windows on every side is a lot to draw
    face(bw, from, to, (u, y) => [u, y, bd / 2 + 0.02], 0, `${key}f`)
    face(bd, from, to, (u, y) => [bw / 2 + 0.02, y, u], Math.PI / 2, `${key}r`)
  }
  const topW = w * 0.68
  const topD = d * 0.68
  if (kind === 'block' || kind === 'garden') sides(w, d, 0, floors, 'a')
  if (kind === 'stepped') {
    sides(w, d, 0, lowFloors, 'a')
    // the top's windows, counted from its own floor
    const r2 = rng(b.seed + 1)
    for (let f = lowFloors; f < floors; f++)
      [0, Math.PI / 2].forEach((rot, k) => {
        const len = k % 2 ? topD : topW
        const half = k % 2 ? topW / 2 : topD / 2
        const cols = Math.max(1, Math.floor((len - 0.8) / 1.5))
        for (let c = 0; c < cols; c++) {
          const u = -len / 2 + (len / cols) * (c + 0.5)
          const y = f * FLOOR + FLOOR * 0.55
          const pos: [number, number, number] = k === 0 ? [u, y, half + 0.02] : k === 1 ? [half + 0.02, y, u] : k === 2 ? [u, y, -half - 0.02] : [-half - 0.02, y, u]
          windows.push(<mesh key={`t${f}-${k}-${c}`} geometry={WIN} material={r2() < 0.35 ? litWindow : darkWindow} position={pos} rotation={[0, rot, 0]} />)
        }
      })
  }
  const show = b.show ?? 'z'
  // a banner on some (not glass towers), a billboard on some tall ones
  // signs everywhere, like a busy city street: vertical banners on both seen sides, a shop sign over the ground floor,
  // a billboard on many tall roofs
  // which signs this building shows: from its seed, each slot (banner, shop sign, billboard…) a different one
  const adIndex = b.seed % ADS.length
  // vertical banners hang from above the shop signs, and not past the wall they're on (a stepped one's lower part)
  const bannerFrom = FLOOR + 1.1
  const bannerH = Math.max(0, Math.min(lowH - bannerFrom - 0.5, kind === 'glass' ? 9 : 5.5))
  // a horizontal sign high on the wall, on a few of the taller ones (no vertical banners: they looked stuck on)
  const wallSign = bannerH >= 4 && r() < 0.25
  // (over the ground floor: a one-storey building has none, it would stand on its roof)
  const shopZ = floors >= 2 && r() < 0.5
  const shopX = floors >= 2 && !shopZ && r() < 0.35
  const billboard = floors >= 6 && kind !== 'garden' && !wallSign && r() < 0.35
  const turned = show === 'x' ? Math.PI / 2 : 0
  const front = show === 'x' ? w / 2 : d / 2
  const topH = kind === 'stepped' ? h : h
  return (
    <group position={[x, 0, z]}>
      {kind !== 'glass' && <Box size={[w, lowH, d]} position={[0, lowH / 2, 0]} color={color} />}
      <Box size={[w + 0.06, 0.6, d + 0.06]} position={[0, 0.3, 0]} color={roof} />
      {kind === 'glass' && <CurtainWall w={w} d={d} floors={floors} black={!!b.black} seed={b.seed} />}
      {kind === 'stepped' && (
        <>
          <Box size={[w + 0.2, 0.25, d + 0.2]} position={[0, lowH + 0.12, 0]} color={roof} />
          <Box size={[topW, h - lowH, topD]} position={[0, lowH + (h - lowH) / 2, 0]} color={color} />
        </>
      )}
      {windows}
      {/* the roof's edge */}
      <Box size={[(kind === 'stepped' ? topW : w) + 0.24, 0.3, (kind === 'stepped' ? topD : d) + 0.24]} position={[0, topH + 0.15, 0]} color={roof} />
      {kind === 'garden' ? (
        <RooftopGarden w={w} d={d} y={h + 0.3} seed={b.seed} />
      ) : billboard ? null : r() < 0.5 ? (
        // a water tank on legs
        <group position={[(kind === 'stepped' ? topW : w) * 0.2, topH + 0.3, -(kind === 'stepped' ? topD : d) * 0.15]}>
          <Cyl r={0.55} h={1.0} position={[0, 0.9, 0]} color="#c9ccd1" />
          {[-0.35, 0.35].map((dx) => (
            <Box key={dx} size={[0.08, 0.4, 0.08]} position={[dx, 0.2, 0]} color={N.charcoal} />
          ))}
        </group>
      ) : (
        // AC units
        [0, 1].map((i) => <Box key={i} size={[0.9, 0.6, 0.7]} position={[-w * 0.2 + i * 1.2, topH + 0.6, d * 0.1]} color={N.light} />)
      )}
      {/* a sign high on the front wall, in a frame */}
      {wallSign && (
        <>
          <Box size={[Math.min(w * 0.6, 5.4) + 0.2, 1.9, 0.12]} position={[0, bannerFrom + bannerH - 1.2, d / 2 + 0.06]} color={N.charcoal} noShadow />
          <AdSign texture={adTexture(adIndex + 4, false)} w={Math.min(w * 0.6, 5.4)} h={1.7} position={[0, bannerFrom + bannerH - 1.2, d / 2 + 0.13]} />
        </>
      )}
      {/* the shop signs over the ground floor */}
      {shopZ && (
        <>
          <Box size={[Math.min(w * 0.75, 6.2) + 0.15, 1.0, 0.12]} position={[0, FLOOR + 0.35, d / 2 + 0.06]} color={N.charcoal} noShadow />
          <AdSign texture={adTexture(adIndex + 7, false)} w={Math.min(w * 0.75, 6.2)} h={0.85} position={[0, FLOOR + 0.35, d / 2 + 0.13]} />
        </>
      )}
      {shopX && (
        <>
          <Box size={[0.12, 1.0, Math.min(d * 0.75, 6.2) + 0.15]} position={[w / 2 + 0.06, FLOOR + 0.35, 0]} color={N.charcoal} noShadow />
          <AdSign texture={adTexture(adIndex + 9, false)} w={Math.min(d * 0.75, 6.2)} h={0.85} position={[w / 2 + 0.13, FLOOR + 0.35, 0]} rotation={[0, Math.PI / 2, 0]} />
        </>
      )}
      {billboard && (
        <group rotation={[0, turned, 0]} position={[0, topH + 0.3, 0]}>
          {[-1.6, 1.6].map((px) => (
            <Box key={px} size={[0.12, 1.4, 0.12]} position={[px, 0.7, 0]} color={N.charcoal} />
          ))}
          <AdSign texture={adTexture(adIndex + 3, false)} w={5} h={1.66} position={[0, 2.2, 0.08]} />
          <Box size={[5.2, 1.86, 0.1]} position={[0, 2.2, 0]} color={N.charcoal} />
        </group>
      )}
    </group>
  )
}

/** A roof garden: a grass deck with a rail round it, planters, a few little trees, a parasol over a bench. */
function RooftopGarden({ w, d, y, seed }: { w: number; d: number; y: number; seed: number }) {
  const r = rng(seed + 7)
  const trees = Array.from({ length: 3 + Math.floor(r() * 3) }, () => [(r() - 0.5) * (w - 1.6), (r() - 0.5) * (d - 1.6), 0.5 + r() * 0.4] as const)
  return (
    <group position={[0, y, 0]}>
      <Box size={[w - 0.3, 0.08, d - 0.3]} position={[0, 0.04, 0]} color="#7fb069" noShadow />
      {/* the rail */}
      {[-1, 1].map((s) => (
        <Box key={`x${s}`} size={[w, 0.5, 0.06]} position={[0, 0.3, (s * d) / 2]} color={N.light} opacity={0.6} />
      ))}
      {[-1, 1].map((s) => (
        <Box key={`z${s}`} size={[0.06, 0.5, d]} position={[(s * w) / 2, 0.3, 0]} color={N.light} opacity={0.6} />
      ))}
      {/* planters along one side, with flowers */}
      {Array.from({ length: Math.max(2, Math.floor(w / 1.6)) }, (_, i) => -w / 2 + 0.8 + i * 1.6).map((px, i) => (
        <group key={px} position={[px, 0, -d / 2 + 0.6]}>
          <Box size={[1.1, 0.4, 0.5]} position={[0, 0.2, 0]} color={N.charcoal} />
          <Box size={[1.0, 0.18, 0.4]} position={[0, 0.48, 0]} color={i % 2 ? P.yellow : P.red} noShadow />
        </group>
      ))}
      {trees.map(([tx, tz, s], i) => (
        <group key={i} position={[tx, 0, tz]}>
          <Cyl r={0.06} h={0.6} position={[0, 0.3, 0]} color="#6b4a33" />
          <mesh position={[0, 0.6 + s, 0]}>
            <icosahedronGeometry args={[s, 0]} />
            <meshToonMaterial color={i % 2 ? '#4f9a5a' : '#6fb85f'} gradientMap={toonRamp} />
          </mesh>
        </group>
      ))}
      {/* a parasol over a bench */}
      <group position={[w * 0.25, 0, d * 0.2]}>
        <Box size={[1.2, 0.08, 0.4]} position={[0, 0.42, 0]} color="#efe6d6" />
        <Cyl r={0.03} h={1.8} position={[0, 0.9, 0]} color={N.light} />
        <Cyl r={0.05} rBottom={1.0} h={0.35} position={[0, 1.85, 0]} color={P.orange} seg={10} />
      </group>
    </group>
  )
}

// ── roads ──

/** A stretch of road (flat), with a dashed middle line along its length. */
function Road({ x0, x1, z0, z1, along }: { x0: number; x1: number; z0: number; z1: number; along: 'x' | 'z' }) {
  const len = along === 'x' ? x1 - x0 : z1 - z0
  const dashes = Math.floor(len / 3)
  return (
    <group>
      <Box size={[x1 - x0, 0.02, z1 - z0]} position={[(x0 + x1) / 2, 0.005, (z0 + z1) / 2]} color={ROAD} noShadow />
      {Array.from({ length: dashes }, (_, i) =>
        along === 'x' ? (
          <Box key={i} size={[1.4, 0.01, 0.1]} position={[x0 + 1.5 + i * 3, 0.02, (z0 + z1) / 2]} color={MARK} noShadow />
        ) : (
          <Box key={i} size={[0.1, 0.01, 1.4]} position={[(x0 + x1) / 2, 0.02, z0 + 1.5 + i * 3]} color={MARK} noShadow />
        ),
      )}
    </group>
  )
}

/** A big street tree: a tall trunk and a crown of three leafy clumps. */
function StreetTree({ x, z, seed = 0 }: { x: number; z: number; seed?: number }) {
  const r = rng(seed + 99)
  const s = 1.1 + r() * 0.5
  const greens = ['#4f8a4a', '#5fa055', '#6fb85f']
  return (
    <group position={[x, 0, z]} rotation={[0, r() * Math.PI, 0]}>
      <Cyl r={0.12} rBottom={0.18} h={2.0 * s} position={[0, s, 0]} color="#6b4a33" />
      {[
        [0, 2.6, 0, 1.3],
        [0.7, 2.2, 0.3, 0.95],
        [-0.6, 2.3, -0.2, 1.0],
      ].map(([cx, cy, cz, cr], i) => (
        <mesh key={i} position={[cx * s, cy * s, cz * s]} castShadow>
          <icosahedronGeometry args={[cr * s, 0]} />
          <meshToonMaterial color={greens[(i + Math.floor(r() * 3)) % 3]} gradientMap={toonRamp} />
        </mesh>
      ))}
    </group>
  )
}

/** The street lamps' bulbs: the office's lamp material, but their own (they fade with the town; the office's don't). */
const streetBulb = lampBulb.clone()
streetBulb.userData.live = true

function StreetLamp({ x, z, rotY = 0 }: { x: number; z: number; rotY?: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      <Cyl r={0.06} h={3} position={[0, 1.5, 0]} color="#2a2a2a" />
      <Box size={[0.08, 0.06, 0.7]} position={[0, 2.98, 0.3]} color="#2a2a2a" />
      <mesh position={[0, 2.87, 0.62]} material={streetBulb}>
        <boxGeometry args={[0.24, 0.03, 0.32]} />
      </mesh>
    </group>
  )
}

/** A traffic light on the corner: a pole, an arm over the road, the three lamps (one lit). */
function TrafficLight({ x, z, rotY = 0, lit = 2 }: { x: number; z: number; rotY?: number; lit?: 0 | 1 | 2 }) {
  const LAMPS = ['#f24f13', '#f2c230', '#3fdc7a']
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      <Cyl r={0.07} h={3.6} position={[0, 1.8, 0]} color="#3a3647" />
      <Box size={[0.08, 0.08, 2.2]} position={[0, 3.5, 1.1]} color="#3a3647" />
      <group position={[0, 3.25, 2.1]}>
        <Box size={[0.3, 0.85, 0.25]} color="#2a2733" />
        {LAMPS.map((c, i) => (
          <Box key={c} size={[0.16, 0.16, 0.04]} position={[0, 0.27 - i * 0.27, 0.14]} color={i === lit ? c : '#4a4655'} emissive={i === lit ? c : undefined} emissiveIntensity={i === lit ? 1.5 : 0} noShadow />
        ))}
      </group>
    </group>
  )
}

/** Zebra stripes across a road (`along`: the road's direction), centred at x, z. */
function Crossing({ x, z, width, along }: { x: number; z: number; width: number; along: 'x' | 'z' }) {
  const n = Math.floor(width / 0.9)
  return (
    <group position={[x, 0.02, z]}>
      {Array.from({ length: n }, (_, i) => {
        const o = -width / 2 + 0.45 + i * 0.9
        return along === 'x' ? (
          <Box key={i} size={[2.2, 0.01, 0.45]} position={[0, 0, o]} color="#f3f0ea" noShadow />
        ) : (
          <Box key={i} size={[0.45, 0.01, 2.2]} position={[o, 0, 0]} color="#f3f0ea" noShadow />
        )
      })}
    </group>
  )
}

// ── the video screens (a giant LED screen on a building, like Shinjuku's cat) ──

const SCREEN = { w: 512, h: 288 }
/** Frames per second the screens are redrawn at (each one is a texture upload). */
const SCREEN_FPS = 12

/** One frame of the screen's show: the giant cat looking out, then the town's name sliding by, then colour waves. */
function drawScreen(ctx: CanvasRenderingContext2D, t: number) {
  const { w, h } = SCREEN
  const scene = Math.floor(t / 7) % 3
  if (scene === 0) {
    // a white room, the calico cat leaning out of it: its head turns, its tail sways, it blinks
    ctx.fillStyle = '#f4f1ec'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#dcd6cc'
    ctx.fillRect(0, h * 0.78, w, h * 0.22)
    const sway = Math.sin(t * 2) * 0.35
    // tail
    ctx.strokeStyle = '#f2921d'
    ctx.lineWidth = 26
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(w * 0.62, h * 0.7)
    ctx.quadraticCurveTo(w * (0.78 + sway * 0.1), h * 0.55, w * (0.84 + sway * 0.08), h * (0.32 - sway * 0.1))
    ctx.stroke()
    // body
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.ellipse(w * 0.48, h * 0.66, w * 0.2, h * 0.2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f2921d'
    ctx.beginPath()
    ctx.ellipse(w * 0.55, h * 0.6, w * 0.08, h * 0.1, 0.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#2a2733'
    ctx.beginPath()
    ctx.ellipse(w * 0.42, h * 0.72, w * 0.06, h * 0.07, -0.3, 0, Math.PI * 2)
    ctx.fill()
    // head
    const hx = w * (0.36 + Math.sin(t * 0.8) * 0.02)
    const hy = h * 0.42
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(hx, hy, h * 0.19, 0, Math.PI * 2)
    ctx.fill()
    for (const s of [-1, 1]) {
      ctx.fillStyle = s < 0 ? '#f2921d' : '#2a2733'
      ctx.beginPath()
      ctx.moveTo(hx + s * h * 0.06, hy - h * 0.15)
      ctx.lineTo(hx + s * h * 0.18, hy - h * 0.3)
      ctx.lineTo(hx + s * h * 0.19, hy - h * 0.08)
      ctx.fill()
    }
    ctx.fillStyle = '#f2921d'
    ctx.beginPath()
    ctx.arc(hx - h * 0.08, hy - h * 0.05, h * 0.09, 0, Math.PI * 2)
    ctx.fill()
    const blink = (t % 3.5) < 0.15
    ctx.fillStyle = '#2a2733'
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(hx + s * h * 0.07, hy, h * 0.03, blink ? h * 0.005 : h * 0.045, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = '#f28fb0'
    ctx.beginPath()
    ctx.arc(hx, hy + h * 0.06, h * 0.018, 0, Math.PI * 2)
    ctx.fill()
    // a red collar
    ctx.strokeStyle = '#f24f13'
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.arc(hx, hy + h * 0.04, h * 0.16, Math.PI * 0.25, Math.PI * 0.75)
    ctx.stroke()
  } else if (scene === 1) {
    // the town's name sliding across a gradient
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#46334f')
    g.addColorStop(1, '#f24f13')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#f2c230'
    ctx.font = '900 96px Inter, "Arial Black", Arial, sans-serif'
    ctx.textBaseline = 'middle'
    const x = w - ((t * 160) % (w + 900))
    ctx.fillText('AFTER OFFICE  ★  AFTER HOURS', x, h / 2)
  } else {
    // bars of colour rising and falling
    ctx.fillStyle = '#1d1726'
    ctx.fillRect(0, 0, w, h)
    const colors = ['#f2c230', '#f2921d', '#f24f13', '#8082a6', '#b99bff']
    for (let i = 0; i < 16; i++) {
      const v = 0.25 + 0.7 * Math.abs(Math.sin(t * 2.2 + i * 0.6))
      ctx.fillStyle = colors[i % colors.length]
      ctx.fillRect(i * (w / 16) + 4, h - v * h, w / 16 - 8, v * h)
    }
  }
}

/** A giant screen on a building's face (a plane facing +z here): its frame, lights on top, the show playing. */
function VideoScreen({
  w,
  offset = 0,
  aspect = SCREEN.h / SCREEN.w,
  draw = drawScreen,
  lights = true,
  ...props
}: {
  w: number
  offset?: number
  /** height over width */
  aspect?: number
  /** what it plays: one frame at time t, on a canvas of the screen's shape */
  draw?: (ctx: CanvasRenderingContext2D, t: number) => void
  lights?: boolean
  position: [number, number, number]
  rotation?: [number, number, number]
}) {
  const h = w * aspect
  const { canvas, ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = aspect > 1 ? Math.round(512 / aspect) : SCREEN.w
    canvas.height = aspect > 1 ? 512 : Math.round(SCREEN.w * aspect)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    return { canvas, ctx: canvas.getContext('2d')!, texture }
  }, [])
  const last = useRef(-1)
  useFrame(() => {
    const t = performance.now() / 1000 + offset
    if (t - last.current < 1 / SCREEN_FPS) return
    last.current = t
    draw(ctx, t)
    texture.needsUpdate = true
  })
  void canvas
  return (
    <group {...props} userData={{ dynamic: true }}>
      <Box size={[w + 0.4, h + 0.4, 0.3]} position={[0, 0, -0.1]} color="#2a2733" />
      <mesh position={[0, 0, 0.06]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={texture} />
      </mesh>
      {lights &&
        Array.from({ length: 5 }, (_, i) => (
          <Box key={i} size={[0.25, 0.18, 0.25]} position={[-w / 2 + (i + 0.5) * (w / 5), h / 2 + 0.35, 0.1]} color={N.light} emissive="#fff4dc" emissiveIntensity={0.6} noShadow />
        ))}
    </group>
  )
}

// ── the mall: its brands on screens ──

/** A logo for a brand's screen, loaded once (drawn as soon as it's in: the screens redraw on their own). */
const logo = (src: string) => {
  const img = new Image()
  // an SVG without a size of its own reads 0 wide: loaded is what counts
  img.onload = () => void (img.dataset.ok = '1')
  img.src = src
  return img
}

/**
 * The brands the mall's screens advertise, in turn (the owner's tools and products; add or change them here): the
 * name, a line under it, their colours, and a logo beside the name for those that have one.
 */
export const MALL_BRANDS: { name: string; line: string; bg: string; fg: string; logo?: HTMLImageElement }[] = [
  { name: 'Poplink.id', line: 'One link for everything', bg: '#17604e', fg: '#ffffff', logo: logo(poplinkLogo) },
  { name: 'Node.js', line: 'JavaScript everywhere', bg: '#3c873a', fg: '#ffffff' },
  { name: 'PostgreSQL', line: 'The database you trust', bg: '#336791', fg: '#ffffff' },
  { name: 'Redis', line: 'Fast. Really fast.', bg: '#d82c20', fg: '#ffffff' },
  { name: 'Bun', line: 'Run it faster', bg: '#fbf0df', fg: '#14151a' },
  { name: 'React', line: 'Build the UI', bg: '#20232a', fg: '#61dafb' },
  { name: 'TypeScript', line: 'Types that help', bg: '#3178c6', fg: '#ffffff' },
  { name: 'Docker', line: 'Ship it in a box', bg: '#1d63ed', fg: '#ffffff' },
  { name: 'Orenjus', line: 'Fresh every day', bg: '#fff4e6', fg: '#c2410c', logo: logo(orenjusLogo) },
  { name: 'Claude', line: 'Your office, working', bg: '#d97757', fg: '#ffffff' },
  { name: 'Driftless', line: 'Go with the flow', bg: '#1d199b', fg: '#ffffff', logo: logo(driftlessLogo) },
]
const BRAND_SLIDE_S = 4

/** A screen's brand show: each brand for a few seconds, the next one sliding in from the right. `start`: which first. */
function brandShow(start: number) {
  return (ctx: CanvasRenderingContext2D, t: number) => {
    const { width: w, height: h } = ctx.canvas
    const n = MALL_BRANDS.length
    const k = Math.floor(t / BRAND_SLIDE_S)
    const p = (t % BRAND_SLIDE_S) / BRAND_SLIDE_S
    // the last 0.4 s: the next one slides in
    const slide = Math.max(0, (p * BRAND_SLIDE_S - (BRAND_SLIDE_S - 0.4)) / 0.4)
    const one = (b: (typeof MALL_BRANDS)[number], x: number) => {
      ctx.save()
      ctx.translate(x, 0)
      ctx.fillStyle = b.bg
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = b.fg
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const tall = h > w
      // with a logo: the logo on the left, the name and its line centred in the rest
      const icon = !tall && b.logo?.dataset.ok ? h * 0.56 : 0
      const room = w - (icon ? icon + h * 0.18 : 0)
      const cx = w - room / 2 - (icon ? h * 0.06 : 0)
      const size = Math.min(tall ? w * 0.34 : h * 0.42, (room * 0.9) / Math.max(4, b.name.length) * 1.7)
      ctx.font = `900 ${size}px Inter, "Arial Black", Arial, sans-serif`
      if (tall) {
        ctx.translate(w / 2, h / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(b.name, 0, 0)
      } else {
        if (icon) ctx.drawImage(b.logo!, h * 0.14, (h - icon) / 2, icon, icon)
        ctx.fillText(b.name, cx, h * 0.44)
        ctx.font = `700 ${size * 0.32}px Inter, Arial, sans-serif`
        ctx.globalAlpha = 0.85
        ctx.fillText(b.line, cx, h * 0.76)
      }
      ctx.restore()
    }
    one(MALL_BRANDS[(start + k) % n], -slide * w)
    if (slide > 0) one(MALL_BRANDS[(start + k + 1) % n], (1 - slide) * w)
  }
}

/**
 * The mall: a whole block, low and wide (not an office tower), with rounded corners; a shop-window ground floor all
 * round, white cladding above with an orange stripe, a tall glass drum with a dome at the front, a big canopy over the
 * entrance with its name, a car park on the roof. And screens, all landscape: a wide one on the front, one on the right
 * side, a billboard on the roof, all advertising MALL_BRANDS.
 */
/** The mall's glass: the office's (its colour follows day and night) but its own, so it fades with the town. */
const mallGlass = windowGlass.clone()
mallGlass.userData.live = true

/** Parking bays across a mall roof this wide (2.6 each, inside a 2-unit margin), and the cars' colours. */
const BAYS = (w: number) => Math.floor((w - 4) / 2.6)
const CARS = ['#f24f13', '#8082a6', '#f2c230', '#efefec', '#46334f']

function Mall({ w, d, name: title = 'AFTER MALL', H = 12.6, first = 0 }: { w: number; d: number; name?: string; H?: number; first?: number }) {
  const R = 3.5
  const name = useMemo(() => signTexture(1400, 260, '#ffffff', [{ text: title, size: Math.min(190, 2100 / title.length), color: P.red, y: 140 }]), [title])
  const CLAD = '#d9dce1'
  const front = d / 2
  const right = w / 2
  return (
    <group>
      {/* the body with rounded corners: two boxes and a column at each corner */}
      <Box size={[w, H, d - 2 * R]} position={[0, H / 2, 0]} color={CLAD} />
      <Box size={[w - 2 * R, H, d]} position={[0, H / 2, 0]} color={CLAD} />
      {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <Cyl key={`${sx}${sz}`} r={R} h={H} seg={24} position={[sx * (right - R), H / 2, sz * (front - R)]} color={CLAD} />))}
      {/* the shop-window ground floor, all round */}
      <mesh position={[0, 2.1, 0]} material={mallGlass}>
        <boxGeometry args={[w - 2 * R + 0.1, 3.6, d + 0.1]} />
      </mesh>
      <mesh position={[0, 2.1, 0]} material={mallGlass}>
        <boxGeometry args={[w + 0.1, 3.6, d - 2 * R + 0.1]} />
      </mesh>
      {/* an orange stripe round the top, a roof edge */}
      <Box size={[w - 2 * R + 0.12, 0.35, d + 0.12]} position={[0, H - 1.2, 0]} color={P.orange} noShadow />
      <Box size={[w + 0.12, 0.35, d - 2 * R + 0.12]} position={[0, H - 1.2, 0]} color={P.orange} noShadow />
      {/* the glass drum and its dome, at the front */}
      <group position={[-w * 0.18, 0, front - 2.5]}>
        <mesh position={[0, (H + 4) / 2, 0]} material={mallGlass}>
          <cylinderGeometry args={[3.2, 3.2, H + 4, 28]} />
        </mesh>
        {Array.from({ length: 6 }, (_, i) => (
          <Cyl key={i} r={3.28} h={0.18} seg={28} position={[0, 3.8 + i * 2.6, 0]} color={N.light} />
        ))}
        <mesh position={[0, H + 4, 0]}>
          <sphereGeometry args={[3.2, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshToonMaterial color="#9fb4c4" gradientMap={toonRamp} />
        </mesh>
      </group>
      {/* the entrance canopy and the mall's name on it */}
      <group position={[w * 0.18, 0, front]}>
        <Box size={[9, 0.5, 4]} position={[0, 4.4, 2]} color={N.light} />
        {[-4, 4].map((cx) => (
          <Cyl key={cx} r={0.18} h={4.2} position={[cx, 2.1, 3.7]} color={N.charcoal} />
        ))}
        <Sign texture={name} w={8.4} h={8.4 * (260 / 1400)} glow position={[0, 4.4, 4.03]} />
      </group>
      {/* the screens, all landscape: a wide one on the front, one on the right side, the roof's billboard */}
      <VideoScreen w={Math.min(14, w * 0.4)} aspect={0.42} draw={brandShow(first)} lights={false} position={[w * 0.18, 8.4, front + 0.2]} />
      <VideoScreen w={Math.min(10, (d - 2 * R) * 0.75)} aspect={0.42} draw={brandShow(first + 3)} lights={false} position={[right + 0.2, 8.4, 0]} rotation={[0, Math.PI / 2, 0]} />
      <group position={[w * 0.15, H, -d * 0.1]}>
        {[-3, 3].map((px) => (
          <Box key={px} size={[0.2, 2.4, 0.2]} position={[px, 1.2, 0]} color={N.charcoal} />
        ))}
        <VideoScreen w={9} aspect={0.36} draw={brandShow(first + 6)} offset={2} position={[0, 4, 0]} />
      </group>
      {/* the roof: a car park at the back half (clear of the glass drum and the billboard), a car in some bays */}
      <Box size={[w - 1.6, 0.06, d - 1.6]} position={[0, H + 0.03, 0]} color="#8f9096" noShadow />
      {Array.from({ length: BAYS(w) + 1 }, (_, i) => (
        <Box key={i} size={[0.08, 0.02, 4.2]} position={[-w / 2 + 2 + i * 2.6, H + 0.07, -d * 0.25]} color="#f3f0ea" noShadow />
      ))}
      {Array.from({ length: BAYS(w) }, (_, i) => i)
        .filter((i) => (i * 5 + first) % 3 !== 1)
        .map((i, k) => (
          <group key={i} position={[-w / 2 + 2 + 1.3 + i * 2.6, H + 0.06, -d * 0.25]}>
            <Box size={[1.6, 0.6, 3.4]} position={[0, 0.4, 0]} color={CARS[k % CARS.length]} />
            <Box size={[1.4, 0.45, 1.7]} position={[0, 0.9, -0.2]} color="#3a3e48" />
          </group>
        ))}
    </group>
  )
}

// ── the café behind the office ──

/** A round café table with four stools round it (seats for the agents who are off, later). */
function CafeTable({ position, umbrella }: { position: [number, number, number]; umbrella?: string }) {
  return (
    <group position={position}>
      <Cyl r={0.5} h={0.05} position={[0, 0.76, 0]} color="#e9dfcf" />
      <Cyl r={0.05} h={0.74} position={[0, 0.37, 0]} color="#2a2a2a" />
      <Cyl r={0.22} h={0.03} position={[0, 0.015, 0]} color="#2a2a2a" noShadow />
      {STOOLS.map(([sx, sz], k) => (
        <group key={k} position={[sx, 0, sz]}>
          <Cyl r={0.2} h={0.06} position={[0, 0.48, 0]} color="#6b4a33" />
          <Cyl r={0.03} h={0.46} position={[0, 0.23, 0]} color="#2a2a2a" />
        </group>
      ))}
      <Cyl r={0.05} h={0.08} position={[0.14, 0.83, 0.06]} color="#fbf7f0" />
      {umbrella && (
        <>
          <Cyl r={0.025} h={2.3} position={[0, 1.15, 0]} color="#d9d5cc" />
          <Cyl r={0.05} rBottom={1.25} h={0.4} position={[0, 2.35, 0]} color={umbrella} seg={10} />
          <Bulb position={[0, 2.08, 0]} />
        </>
      )}
    </group>
  )
}

/**
 * A real light for a place people sit at night (the café's terrace and roof, the coffee shop's tables): it lights the
 * tables and whoever sits there, not just a painted pool. Only on the tiers with real lamps (scene/quality.ts), so
 * the light count, and the shaders, stay fixed per tier; its strength follows the night.
 */
function NightLight({ position, power, distance }: { position: [number, number, number]; power: number; distance: number }) {
  const light = useRef<PointLight>(null)
  useFrame(() => void (light.current && (light.current.intensity = env.night * power)))
  return <pointLight ref={light} position={position} color="#ffc47a" intensity={0} distance={distance} decay={1.3} />
}

/** The café's terrace: its tables (relative to the block's middle) in rows from the café's front to the street. */
function cafeTables(w: number, d: number) {
  const t0 = -d / 2 + 0.8 + CAFE_DEPTH + 2.4
  const t1 = d / 2 - 1.4
  const cols = Math.max(2, Math.floor((w - 3) / 3.2))
  const rows = Math.max(1, Math.floor((t1 - t0) / 3) + 1)
  const step = (w - 3.2) / cols
  const list: { x: number; z: number; r: number; c: number }[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) list.push({ x: -w / 2 + 1.6 + (c + 0.5) * step, z: t0 + r * 3, r, c })
  return { t0, t1, cols, step, list }
}
const CAFE_DEPTH = 7
/** The middle of the café's terrace, front to back (relative to the block's middle). */
const cafeTerraceZ = (w: number, d: number) => {
  const { t0, t1 } = cafeTables(w, d)
  return (t0 + t1) / 2
}
/** The stools round a café table: their offsets from it. */
const STOOLS = [0, 1, 2, 3].map((k): Vec2 => {
  const a = (k * Math.PI) / 2 + Math.PI / 4
  return [Math.cos(a) * 0.82, Math.sin(a) * 0.82]
})

/**
 * The town's seats for the agents who are off (scene/outings.ts): every stool at the café's terrace and the coffee
 * shop's chairs, each with the walk to it from the office's door (along the pavements: out to the side road, then up
 * it to the café, or across it to the coffee shop).
 */
function townSeats(cafe: { x: number; z: number; w: number; d: number }, coffee: { x: number; zs: number[] }, sideX: number): Seat[] {
  const out: Vec2[] = [ENTRANCE, [ENTRANCE[0], OUTSIDE.sidewalkZ], [sideX, OUTSIDE.sidewalkZ]]
  const face = (sx: number, sz: number, tx: number, tz: number) => Math.atan2(tx - sx, tz - sz)
  const seats: Seat[] = []
  const { list, cols, step } = cafeTables(cafe.w, cafe.d)
  const pave = cafe.z + cafe.d / 2 + 0.35
  for (const t of list) {
    const tx = cafe.x + t.x
    const tz = cafe.z + t.z
    // in by the aisle beside its column, along the gap in front of its row
    const aisle = tx + (t.c < cols - 1 ? step / 2 : -step / 2)
    const lane = tz - 1.5
    for (const [ox, oz] of STOOLS) {
      const sx = tx + ox
      const sz = tz + oz
      seats.push({ x: sx, z: sz, rotY: face(sx, sz, tx, tz), walk: [...out, [sideX, pave], [aisle, pave], [aisle, lane], [sx, lane], [sx, sz]] })
    }
  }
  // the coffee shop's chairs, on the far side of the side road (its tables face the road)
  for (const tz of coffee.zs) {
    for (const oz of [-0.75, 0.75]) {
      const sx = coffee.x
      const sz = tz + oz
      seats.push({ x: sx, z: sz, rotY: face(sx, sz, coffee.x, tz), walk: [...out, [coffee.x + 0.9, OUTSIDE.sidewalkZ], [coffee.x + 0.9, sz], [sx, sz]] })
    }
  }
  return seats
}

/**
 * "After Cafe", the block behind the office: a low two-storey café at the back (dark green, a glass front lit warm at
 * night, a striped awning, its sign), a big terrace in front of it full of tables (strings of bulbs over it, light on
 * the paving at night) and more tables on its roof. Somewhere for the agents to hang out when they're off.
 */
function Cafe({ w, d }: { w: number; d: number }) {
  const sign = useMemo(() => signTexture(1024, 220, '#24302a', [{ text: 'AFTER CAFE', size: 124, color: P.yellow, y: 118 }], P.orange), [])
  const BW = Math.min(w - 2, 20)
  const BD = CAFE_DEPTH
  const H = 6.4
  const back = -d / 2 + 0.8
  const front = back + BD
  // the terrace: from the café's front to the street, tables in rows
  const { t0, t1, list: tables } = cafeTables(w, d)
  const umbrellas = ['#fff3dc', P.orange, '#2f6b4f', P.red]
  const roofTables = Math.max(2, Math.floor((BW - 2) / 3.4))
  return (
    <group>
      {/* the terrace's paving (warm wood decking) and planters at its street corners */}
      <Box size={[w, 0.06, d - BD - 1]} position={[0, 0.03, front + (d - BD - 1) / 2 - 0.2]} color="#b98a5e" noShadow />
      {[-1, 1].map((sx) => (
        <Box key={sx} size={[1.6, 0.5, 0.5]} position={[sx * (w / 2 - 1.1), 0.25, d / 2 - 0.5]} color="#3d4a42" />
      ))}
      {[-1, 1].map((sx) => (
        <mesh key={`p${sx}`} position={[sx * (w / 2 - 1.1), 0.75, d / 2 - 0.5]} scale={[0.8, 0.35, 0.3]}>
          <icosahedronGeometry args={[1, 0]} />
          <meshToonMaterial color="#4f9a5a" gradientMap={toonRamp} />
        </mesh>
      ))}
      {/* the café: two storeys, a glass front lit inside at night */}
      <group position={[0, 0, back + BD / 2]}>
        <Box size={[BW, H, BD]} position={[0, H / 2, 0]} color="#3d4a42" />
        <Box size={[BW + 0.3, 0.35, BD + 0.3]} position={[0, H + 0.17, 0]} color={N.charcoal} />
        <Box size={[BW + 0.1, 0.2, 0.3]} position={[0, H / 2, BD / 2 + 0.1]} color="#b98a5e" />
        {[0, 1].map((f) => (
          <group key={f} position={[0, f * (H / 2), 0]}>
            <mesh position={[0, 1.55, BD / 2 - 0.1]} material={shopGlow}>
              <boxGeometry args={[BW - 1.4, 2.3, 0.05]} />
            </mesh>
            <mesh position={[0, 1.55, BD / 2 + 0.02]} material={windowGlass}>
              <boxGeometry args={[BW - 1.2, 2.4, 0.05]} />
            </mesh>
            {Array.from({ length: Math.round(BW / 2.4) + 1 }, (_, k) => (
              <Box key={k} size={[0.12, 2.5, 0.1]} position={[-(BW - 1.2) / 2 + k * ((BW - 1.2) / Math.round(BW / 2.4)), 1.5, BD / 2 + 0.05]} color="#1f2622" noShadow />
            ))}
          </group>
        ))}
        {/* the striped awning over the ground floor, the sign above it */}
        <group position={[0, 3.0, BD / 2 + 0.75]} rotation={[0.32, 0, 0]}>
          {Array.from({ length: 12 }, (_, k) => (
            <Box key={k} size={[(BW - 1) / 12, 0.06, 1.6]} position={[-(BW - 1) / 2 + (k + 0.5) * ((BW - 1) / 12), 0, 0]} color={k % 2 ? '#fff3dc' : '#2f6b4f'} />
          ))}
        </group>
        <Sign texture={sign} w={7} h={7 * (220 / 1024)} glow position={[0, H - 0.6, BD / 2 + 0.08]} />
        {/* the roof terrace: a rail, tables, bulbs */}
        {[-1, 1].map((sz) => (
          <Box key={sz} size={[BW, 0.5, 0.06]} position={[0, H + 0.55, sz * (BD / 2 - 0.05)]} color={N.charcoal} noShadow />
        ))}
        {[-1, 1].map((sx) => (
          <Box key={`r${sx}`} size={[0.06, 0.5, BD]} position={[sx * (BW / 2 - 0.05), H + 0.55, 0]} color={N.charcoal} noShadow />
        ))}
        {Array.from({ length: roofTables }, (_, k) =>
          [-1.4, 1.4].map((dz) => <CafeTable key={`${k}${dz}`} position={[-(BW - 3) / 2 + (k * (BW - 3)) / (roofTables - 1), H + 0.3, dz]} />),
        )}
        {Array.from({ length: 12 }, (_, k) => (
          <Bulb key={`b${k}`} position={[-BW / 2 + 0.4 + k * ((BW - 0.8) / 11), H + 1.6, 0]} />
        ))}
      </group>
      {/* the terrace: rows of tables, some under umbrellas; strings of bulbs on posts over them */}
      {tables.map(({ x, z, r, c }) => (
        <CafeTable key={`${r}-${c}`} position={[x, 0, z]} umbrella={(r + c) % 3 === 0 ? umbrellas[(r * 3 + c) % umbrellas.length] : undefined} />
      ))}
      {[-1, 1].map((sx) => (
        <group key={`post${sx}`}>
          {[t0 - 1, t1].map((z) => (
            <Cyl key={z} r={0.06} h={3.2} position={[sx * (w / 2 - 0.6), 1.6, z]} color="#2a2a2a" />
          ))}
        </group>
      ))}
      {[t0 - 1, t1].map((z) => Array.from({ length: 14 }, (_, k) => <Bulb key={`s${z}${k}`} position={[-w / 2 + 0.6 + k * ((w - 1.2) / 13), 3.05 - Math.sin((k / 13) * Math.PI) * 0.35, z]} />))}
      <LightPool r={Math.min(w, d) * 0.32} position={[-w / 4, 0.07, (t0 + t1) / 2]} />
      <LightPool r={Math.min(w, d) * 0.32} position={[w / 4, 0.07, (t0 + t1) / 2]} />
    </group>
  )
}

// ── the minimarket across the front road ──

/**
 * "After Mart", a 24-hour minimarket (one storey): white, the red-yellow-blue stripes along the top every minimarket
 * here has, a glass shop front with its sign on the road side (−z) and on the side the usual view sees (+x), an ATM by
 * the door, motorbikes parked in front. Lit inside at night.
 */
function Minimart({ w, d }: { w: number; d: number }) {
  const H = 4.2
  const sign = useMemo(
    () =>
      signTexture(1024, 260, '#1f4fa8', [
        { text: 'AFTER MART', size: 130, color: P.yellow, y: 110 },
        { text: '24 HOURS', size: 56, color: '#ffffff', y: 210, weight: 800 },
      ]),
    [],
  )
  const front = -d / 2
  const right = w / 2
  const stripes = ['#d22b2b', P.yellow, '#1f4fa8']
  return (
    <group>
      <Box size={[w, H, d]} position={[0, H / 2, 0]} color="#f5f5f3" />
      <Box size={[w + 0.2, 0.25, d + 0.2]} position={[0, H + 0.12, 0]} color="#d8d8d6" />
      {/* the three stripes all round the top */}
      {stripes.map((c, i) => (
        <Box key={c} size={[w + 0.06, 0.22, d + 0.06]} position={[0, H - 0.3 - i * 0.22, 0]} color={c} noShadow />
      ))}
      {/* lit inside at night, seen through the glass; the glass fronts */}
      <mesh position={[0, 1.45, front + 0.12]} material={shopGlow}>
        <boxGeometry args={[w - 1, 2.5, 0.05]} />
      </mesh>
      <mesh position={[right - 0.12, 1.45, 0]} material={shopGlow}>
        <boxGeometry args={[0.05, 2.5, d - 1]} />
      </mesh>
      <mesh position={[0, 1.45, front - 0.02]} material={windowGlass}>
        <boxGeometry args={[w - 0.8, 2.6, 0.05]} />
      </mesh>
      <mesh position={[right + 0.02, 1.45, 0]} material={windowGlass}>
        <boxGeometry args={[0.05, 2.6, d - 0.8]} />
      </mesh>
      {[-w / 2 + 0.4, -1, 1, w / 2 - 0.4].map((x) => (
        <Box key={x} size={[0.1, 2.7, 0.1]} position={[x, 1.4, front - 0.05]} color="#9aa0a8" />
      ))}
      {/* the signs: on the road side and on the right */}
      <Sign texture={sign} w={Math.min(w - 1, 6)} h={Math.min(w - 1, 6) * (260 / 1024)} glow position={[0, 3.25, front - 0.06]} rotation={[0, Math.PI, 0]} />
      <Sign texture={sign} w={Math.min(d - 1, 6)} h={Math.min(d - 1, 6) * (260 / 1024)} glow position={[right + 0.06, 3.25, 0]} rotation={[0, Math.PI / 2, 0]} />
      {/* an ATM by the door, a freezer, motorbikes in front */}
      <group position={[w / 2 - 0.9, 0, front - 0.45]}>
        <Box size={[0.8, 1.8, 0.6]} position={[0, 0.9, 0]} color="#1f4fa8" />
        <Box size={[0.5, 0.35, 0.02]} position={[0, 1.3, -0.31]} color="#111" emissive="#7cc4ef" emissiveIntensity={0.5} noShadow />
      </group>
      <Box size={[1.2, 0.9, 0.6]} position={[-w / 2 + 1.2, 0.45, front - 0.45]} color="#e9eef2" />
      {[-1.5, -0.3, 0.9].map((x, i) => (
        <group key={x} position={[x, 0, front - 2.2]} rotation={[0, Math.PI / 2, 0]}>
          <Box size={[1.4, 0.45, 0.3]} position={[0, 0.45, 0]} color={['#d22b2b', '#2a2a2a', '#efefec'][i]} />
          <Cyl r={0.22} h={0.1} position={[-0.55, 0.22, 0]} rotation={[Math.PI / 2, 0, 0]} color="#1b1b1b" />
          <Cyl r={0.22} h={0.1} position={[0.55, 0.22, 0]} rotation={[Math.PI / 2, 0, 0]} color="#1b1b1b" />
          <Box size={[0.08, 0.4, 0.5]} position={[0.5, 0.85, 0]} color="#3a3a3a" />
        </group>
      ))}
      <LightPool r={4} position={[0, 0.035, front - 2]} />
    </group>
  )
}

// ── the shops across the front road ──

/** "After Coffee": a glass front under a striped awning, its sign, tables with umbrellas outside. */
function CoffeeShop({ x, z }: { x: number; z: number }) {
  const sign = useMemo(() => signTexture(1024, 220, P.purple, [{ text: 'AFTER COFFEE', size: 120, color: P.yellow, y: 118 }], P.orange), [])
  const W = 9
  const D = 6
  const H = 3.6
  // the front faces the road (−z)
  const front = -D / 2
  return (
    <group position={[x, 0, z]}>
      <Box size={[W, H, D]} position={[0, H / 2, 0]} color="#55534e" />
      <Box size={[W + 0.3, 0.35, D + 0.3]} position={[0, H + 0.17, 0]} color={N.charcoal} />
      {/* lit inside at night, seen through the glass */}
      <mesh position={[0, 1.4, front + 0.12]} material={shopGlow}>
        <boxGeometry args={[W - 1.3, 2.1, 0.05]} />
      </mesh>
      {/* the glass front with its door */}
      <mesh position={[0, 1.4, front - 0.02]} material={windowGlass}>
        <boxGeometry args={[W - 1.2, 2.2, 0.05]} />
      </mesh>
      {[-W / 2 + 0.6, -1, 1, W / 2 - 0.6].map((dx) => (
        <Box key={dx} size={[0.12, 2.4, 0.12]} position={[dx, 1.3, front - 0.04]} color="#2a1d14" />
      ))}
      {/* striped awning, tilted out over the pavement */}
      <group position={[0, 2.85, front - 0.75]} rotation={[0.35, 0, 0]}>
        {Array.from({ length: 9 }, (_, i) => (
          <Box key={i} size={[W / 9, 0.06, 1.6]} position={[-W / 2 + (i + 0.5) * (W / 9), 0, 0]} color={i % 2 ? '#fff3dc' : P.orange} />
        ))}
      </group>
      <Sign texture={sign} w={5.2} h={1.1} glow position={[0, H - 0.25, front - 0.05]} rotation={[0, Math.PI, 0]} />
      {/* a string of bulbs along the awning's edge, and the light they throw on the pavement */}
      {Array.from({ length: 10 }, (_, i) => (
        <Bulb key={i} position={[-W / 2 + 0.45 + i * ((W - 0.9) / 9), 2.42, front - 1.45]} />
      ))}
      <LightPool r={4.2} position={[0, 0.035, front - 2.4]} />
      {/* tables outside, each with two chairs and an umbrella */}
      {[-3, 0, 3].map((dx, i) => (
        <group key={dx} position={[dx, 0, front - 2.6]}>
          <Cyl r={0.45} h={0.05} position={[0, 0.75, 0]} color="#f3ead9" />
          <Cyl r={0.04} h={0.73} position={[0, 0.37, 0]} color="#2a2a2a" />
          {[-0.75, 0.75].map((cx) => (
            <group key={cx} position={[cx, 0, 0]}>
              <Box size={[0.42, 0.05, 0.42]} position={[0, 0.45, 0]} color="#3b2a1f" />
              <Box size={[0.42, 0.45, 0.05]} position={[cx > 0 ? 0.2 : -0.2, 0.68, 0]} rotation={[0, Math.PI / 2, 0]} color="#3b2a1f" />
              {[-0.17, 0.17].map((lx) => (
                <Box key={lx} size={[0.04, 0.45, 0.04]} position={[lx, 0.22, lx]} color="#2a2a2a" />
              ))}
            </group>
          ))}
          <Cyl r={0.025} h={2.2} position={[0, 1.1, 0]} color="#d9d5cc" />
          <Cyl r={0.05} rBottom={1.2} h={0.4} position={[0, 2.25, 0]} color={i % 2 ? P.orange : '#fff3dc'} seg={10} />
          <Bulb position={[0, 1.98, 0]} />
          {/* a cup on the table */}
          <Cyl r={0.05} h={0.08} position={[0.15, 0.82, 0.05]} color="#fbf7f0" />
        </group>
      ))}
      {/* plants by the door */}
      {[-W / 2 + 0.3, W / 2 - 0.3].map((dx) => (
        <group key={dx} position={[dx, 0, front - 0.4]}>
          <Box size={[0.5, 0.5, 0.5]} position={[0, 0.25, 0]} color="#3b2a1f" />
          <mesh position={[0, 0.85, 0]}>
            <icosahedronGeometry args={[0.45, 0]} />
            <meshToonMaterial color="#4f9a5a" gradientMap={toonRamp} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/**
 * A warung pecel lele: a tent of poles under a tarp, its front and sides the painted banner every one of them has (red
 * and blue letters, the fish and the chicken), the cart with its glass case, a long table with benches, plastic stools,
 * a green gas canister.
 */
function WarungPecelLele({ x, z }: { x: number; z: number }) {
  const banner = useMemo(
    () =>
      signTexture(
        1024,
        360,
        '#fbf6ea',
        [
          { text: 'PECEL LELE', size: 150, color: '#d22b2b', y: 120 },
          { text: 'FRIED CATFISH • CHICKEN • DUCK', size: 54, color: '#1f4fa8', y: 240, weight: 800 },
          { text: 'EAST JAVA STYLE', size: 44, color: '#1f8a3a', y: 312, weight: 800 },
        ],
        '#1f4fa8',
      ),
    [],
  )
  const W = 6
  const D = 4.2
  const H = 2.5
  const front = -D / 2
  return (
    <group position={[x, 0, z]}>
      {/* poles and the tarp roof */}
      {[-W / 2, W / 2].flatMap((px) =>
        [front, -front].map((pz) => <Box key={`${px}${pz}`} size={[0.08, H, 0.08]} position={[px, H / 2, pz]} color="#9aa0a8" />),
      )}
      <Box size={[W + 0.4, 0.06, D + 0.4]} position={[0, H + 0.03, 0]} color="#2f6fb3" />
      {/* the tarp's underside lit at night, three bulbs hanging from it, their light on the ground */}
      <mesh position={[0, H - 0.02, 0]} material={shopGlow}>
        <boxGeometry args={[W - 0.2, 0.02, D - 0.2]} />
      </mesh>
      {[-W / 3, 0, W / 3].map((bx) => (
        <group key={bx}>
          <Box size={[0.015, 0.4, 0.015]} position={[bx, H - 0.22, 0]} color="#2a2a2a" noShadow />
          <Bulb position={[bx, H - 0.45, 0]} />
        </group>
      ))}
      {/* spilling out in front of the tent (the tarp hides what's under it from above) */}
      <LightPool r={4.4} position={[0, 0.035, front - 0.8]} />
      <Box size={[W + 0.4, 0.5, 0.04]} position={[0, H - 0.2, -front + 0.2]} color="#2f6fb3" />
      {/* the banner across the front, and down its sides */}
      <Sign texture={banner} w={W} h={W * (360 / 1024)} glow position={[0, H - 0.95, front - 0.04]} rotation={[0, Math.PI, 0]} />
      <Box size={[0.04, 1.6, D]} position={[-W / 2 - 0.02, H - 0.9, 0]} color="#fbf6ea" />
      <Box size={[0.04, 1.6, D]} position={[W / 2 + 0.02, H - 0.9, 0]} color="#fbf6ea" />
      {/* the cart (gerobak): a cabinet on wheels, its glass case on top */}
      <group position={[-W / 2 + 1.2, 0, front + 0.9]}>
        <Box size={[1.6, 0.85, 0.75]} position={[0, 0.6, 0]} color="#c23a2b" />
        <Box size={[1.7, 0.06, 0.85]} position={[0, 1.05, 0]} color="#f3ead9" />
        <mesh position={[0, 1.35, 0]} material={windowGlass}>
          <boxGeometry args={[1.4, 0.55, 0.6]} />
        </mesh>
        {[-0.6, 0.6].map((wx) => (
          <Cyl key={wx} r={0.18} h={0.08} position={[wx, 0.18, 0.4]} rotation={[Math.PI / 2, 0, 0]} color="#2a2a2a" />
        ))}
        {/* a wok on the stove beside it, the green 3 kg gas canister under it */}
        <Cyl r={0.28} rBottom={0.15} h={0.12} position={[1.15, 1.0, 0]} color="#2a2a2a" />
        <Box size={[0.5, 0.85, 0.5]} position={[1.15, 0.45, 0]} color="#5a5f68" />
        <Cyl r={0.15} h={0.32} position={[1.15, 0.16, 0.45]} color="#3fae5a" />
      </group>
      {/* the long low table and its benches */}
      <group position={[0.9, 0, 0.4]}>
        <Box size={[3.2, 0.06, 0.8]} position={[0, 0.72, 0]} color="#c9a57a" />
        {[-1.5, 1.5].map((lx) => (
          <Box key={lx} size={[0.08, 0.7, 0.7]} position={[lx, 0.36, 0]} color="#8c6a4f" />
        ))}
        {[-0.75, 0.75].map((bz) => (
          <Box key={bz} size={[3.0, 0.06, 0.3]} position={[0, 0.42, bz]} color="#8c6a4f" />
        ))}
        {/* plates, glasses of es teh */}
        {[-1, 0, 1].map((px) => (
          <group key={px} position={[px, 0.76, 0]}>
            <Cyl r={0.15} h={0.02} position={[0, 0, -0.15]} color="#fbf7f0" />
            <Cyl r={0.05} h={0.14} position={[0.2, 0.06, 0.1]} color="#c9762b" opacity={0.85} />
          </group>
        ))}
      </group>
      {/* plastic stools by the road */}
      {[-1.6, -0.6, 0.4].map((sx, i) => (
        <Cyl key={sx} r={0.17} rBottom={0.2} h={0.42} position={[sx, 0.21, front - 0.6]} color={i % 2 ? '#d22b2b' : '#2f6fb3'} />
      ))}
    </group>
  )
}

/** A two-storey shophouse (ruko): a roller shutter or a shop window below, windows and a balcony above. */
function Ruko({ x, z, color, shutter }: { x: number; z: number; color: string; shutter?: boolean }) {
  const W = 4.5
  const D = 6
  const H = FLOOR * 2
  const front = -D / 2
  return (
    <group position={[x, 0, z]}>
      <Box size={[W, H, D]} position={[0, H / 2, 0]} color={color} />
      <Box size={[W + 0.2, 0.25, D + 0.2]} position={[0, H + 0.12, 0]} color="#55534e" />
      {shutter ? (
        Array.from({ length: 8 }, (_, i) => <Box key={i} size={[W - 0.6, 0.24, 0.05]} position={[0, 0.2 + i * 0.26, front - 0.03]} color={i % 2 ? '#a8adb5' : '#9aa0a8'} noShadow />)
      ) : (
        <mesh position={[0, 1.1, front - 0.02]} material={windowGlass}>
          <boxGeometry args={[W - 0.8, 1.8, 0.05]} />
        </mesh>
      )}
      {/* upstairs: two windows and a little balcony */}
      {[-1, 1].map((dx) => (
        <mesh key={dx} geometry={WIN} material={litWindow} position={[dx, FLOOR + 1.3, front - 0.03]} />
      ))}
      <Box size={[W - 0.4, 0.08, 0.6]} position={[0, FLOOR + 0.5, front - 0.3]} color="#55534e" />
      <Box size={[W - 0.4, 0.5, 0.04]} position={[0, FLOOR + 0.75, front - 0.58]} color={N.charcoal} />
    </group>
  )
}

// ── the cut-away sides ──

/** A side of the town that hides while the camera looks at the office from beyond it (like the office's walls). */
function Side({ inward, version, children }: { inward?: [number, number]; version: unknown; children: ReactNode }) {
  const group = useRef<Group>(null!)
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3 } | null
  useFrame(({ camera }) => {
    if (!inward) return
    const t = controls?.target
    const dx = camera.position.x - (t?.x ?? 0)
    const dz = camera.position.z - (t?.z ?? 0)
    const behind = dx * inward[0] + dz * inward[1] < -1
    if (group.current.visible === behind) group.current.visible = !behind
  })
  return (
    <group ref={group} userData={{ dynamic: true }}>
      <StaticBatch version={version}>{children}</StaticBatch>
    </group>
  )
}

// ── the buildings' shadows on the ground ──

/**
 * Where the sun's shadows fall (scene/DayNight.tsx: the sun stands at +x, high, a little to +z): a building's shadow is
 * its footprint swept this far (per metre of height) along this direction. Real shadow maps only cover the office;
 * these are painted on the ground, every one in a single mesh.
 */
const SHADOW_DIR: [number, number] = [-0.93, -0.37]
const SHADOW_PER_M = 0.6

/** The convex hull of points (monotone chain), anticlockwise. */
function hull(pts: [number, number][]) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function GroundShadows({ buildings }: { buildings: Bld[] }) {
  const geometry = useMemo(() => {
    const pos: number[] = []
    for (const b of buildings) {
      const len = b.floors * FLOOR * SHADOW_PER_M
      const [ox, oz] = [SHADOW_DIR[0] * len, SHADOW_DIR[1] * len]
      const corners: [number, number][] = [
        [b.x - b.w / 2, b.z - b.d / 2],
        [b.x + b.w / 2, b.z - b.d / 2],
        [b.x + b.w / 2, b.z + b.d / 2],
        [b.x - b.w / 2, b.z + b.d / 2],
      ]
      const h = hull([...corners, ...corners.map(([x, z]): [number, number] => [x + ox, z + oz])])
      // a fan from the first point (the hull is convex)
      for (let i = 1; i < h.length - 1; i++) for (const [x, z] of [h[0], h[i + 1], h[i]]) pos.push(x, 0.03, z)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    return g
  }, [buildings])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh geometry={geometry} renderOrder={1}>
      <meshBasicMaterial color="#2b2433" transparent opacity={0.32} depthWrite={false} side={DoubleSide} />
    </mesh>
  )
}

// ── fading the town while the view is on the office ──

/**
 * Close on the office (the start view and nearer: camera.zoom from FOCUS_ZOOM up) the town's buildings fade to
 * FADED, so they don't compete with it; zoomed out to the town (TOWN_ZOOM and below) they're solid again. Only what
 * stands in front of the office fades (with its trees and lamp posts); the rest of the town, the minimarket, the coffee
 * shop and the warung stay as they are. A faded building writes no depth: no outlines (scene/Outline.tsx),
 * and the office shows through it.
 */
const FOCUS_ZOOM = 24
const TOWN_ZOOM = 14
const FADED = 0.15
/** The town's opacity now, eased towards its target each frame (shared by every Fade). */
const fade = { now: 1 }

function Fade({ children }: { children: ReactNode }) {
  const group = useRef<Group>(null!)
  const applied = useRef(1)
  useFrame(() => {
    const o = fade.now
    if (Math.abs(o - applied.current) < 0.005) return
    applied.current = o
    const solid = o > 0.995
    const seen = new Set<Material>()
    group.current.traverse((obj) => {
      const mesh = obj as Mesh
      if (!mesh.isMesh || !mesh.visible) return
      // faded, it casts no shadow on the office (what it casted before fading is kept)
      mesh.userData.baseCast ??= mesh.castShadow
      mesh.castShadow = solid && mesh.userData.baseCast
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        // shared with the office (its window glass): never faded
        if (seen.has(m) || m === windowGlass || m === lampBulb) continue
        seen.add(m)
        // what it was before fading (a glass rail is see-through on its own)
        m.userData.baseOpacity ??= m.opacity
        m.userData.baseTransparent ??= m.transparent
        m.opacity = m.userData.baseOpacity * o
        const transparent = !solid || m.userData.baseTransparent
        if (m.transparent !== transparent) {
          m.transparent = transparent
          m.needsUpdate = true
        }
        m.depthWrite = solid && !m.userData.baseTransparent
      }
    })
  })
  return <group ref={group}>{children}</group>
}

/** The width of the town's roads, and of a block between them. */
const ROAD_W = 4.5
const BLOCK = 22

export function City({ layout }: { layout: Layout }) {
  const cfg = useRenderConfig()
  const { floor, lot } = layout
  // the office's own block: the building and its lot (the front road, along the lot, is the grid's)
  const L = Math.min(floor.minX, lot.minX)
  const R = lot.maxX
  const back = floor.minZ - 0.2
  // the grid's roads: along x (z ranges) and along z (x ranges), two each way beyond the office's block
  const zRoads = useMemo(() => {
    const b1: [number, number] = [back - 2 - ROAD_W, back - 2]
    const b2: [number, number] = [b1[0] - BLOCK - ROAD_W, b1[0] - BLOCK]
    const f1: [number, number] = [14.6, 19.2]
    const f2: [number, number] = [f1[1] + BLOCK, f1[1] + BLOCK + ROAD_W]
    return { b2, b1, f1, f2 }
  }, [back])
  const xRoads = useMemo(() => {
    const l1: [number, number] = [L - 2 - ROAD_W, L - 2]
    const l2: [number, number] = [l1[0] - BLOCK - ROAD_W, l1[0] - BLOCK]
    const r1: [number, number] = [R + 2, R + 2 + ROAD_W]
    const r2: [number, number] = [r1[1] + BLOCK, r1[1] + BLOCK + ROAD_W]
    return { l2, l1, r1, r2 }
  }, [L, R])
  const X0 = xRoads.l2[0] - BLOCK
  const X1 = xRoads.r2[1] + BLOCK
  const Z0 = zRoads.b2[0] - BLOCK
  const Z1 = zRoads.f2[1] + BLOCK

  const town = useMemo(() => {
    // columns and rows of blocks between the roads (the office's is the middle one)
    const cols = { ll: [X0, xRoads.l2[0]], l: [xRoads.l2[1], xRoads.l1[0]], r: [xRoads.r1[1], xRoads.r2[0]], rr: [xRoads.r2[1], X1] } as const
    const rows = { bb: [Z0, zRoads.b2[0]], b: [zRoads.b2[1], zRoads.b1[0]], o: [zRoads.b1[1], zRoads.f1[0]], f: [zRoads.f1[1], zRoads.f2[0]], ff: [zRoads.f2[1], Z1] } as const
    const mid: [number, number] = [xRoads.l1[1], xRoads.r1[0]]
    const block = (c: readonly [number, number], r: readonly [number, number], floors: [number, number], seed: number, show: 'z' | 'x' = 'z') => fillBlock(c[0], c[1], r[0], r[1], floors, seed, show)
    // behind and to the left (behind the office from the usual view): tall; to the right and in front: lower
    const behind = [
      ...block(cols.ll, rows.bb, [7, 12], 1),
      ...block(cols.l, rows.bb, [7, 12], 2),
      ...block(cols.r, rows.bb, [6, 10], 4),
      ...block(cols.ll, rows.b, [5, 10], 5),
      ...block(cols.r, rows.b, [4, 7], 8),
    ]
    const left = [
      ...block(cols.ll, rows.o, [4, 8], 9, 'x'),
      // the block next to the office: buildings at its far side only; the coffee shop and the warung on its road
      ...fillBlock(cols.l[0], cols.l[1] - 11, rows.o[0], rows.o[1], [3, 6], 10, 'x'),
      ...block(cols.ll, rows.f, [3, 6], 11, 'x'),
    ]
    const low = [
      ...block(cols.r, rows.o, [2, 4], 12),
      ...block(cols.rr, rows.b, [3, 6], 13),
      ...block(cols.rr, rows.o, [2, 4], 14),
      ...block(cols.l, rows.f, [1, 3], 15),
      ...block(mid, rows.f, [1, 3], 16),
      ...block(cols.r, rows.f, [1, 3], 17),
      ...block(cols.rr, rows.f, [1, 3], 18),
      ...block(cols.l, rows.ff, [2, 4], 19),
      ...block(mid, rows.ff, [2, 4], 20),
      ...block(cols.r, rows.ff, [2, 4], 21),
    ]
    // the landmark screens: the tallest building behind the office's middle, and one in the left block
    const centre = (L + R) / 2
    const near = behind.filter((b) => b.z > rows.b[0]).reduce((a, b) => (Math.abs(b.x - centre) + Math.abs(b.z - rows.b[1]) < Math.abs(a.x - centre) + Math.abs(a.z - rows.b[1]) ? b : a))
    near.floors = Math.max(near.floors, 10)
    near.w = Math.max(near.w, 10)
    // one or two black glass towers among the tall ones behind, far apart, taller than their neighbours
    const tall = behind.filter((b) => b !== near).sort((a, b) => b.floors - a.floors)
    const firstBlack = tall[0]
    const secondBlack = tall.find((b) => Math.abs(b.x - firstBlack.x) > 25)
    for (const b of [firstBlack, secondBlack]) {
      if (!b) continue
      b.black = true
      b.floors = Math.max(b.floors, 13)
    }
    const leftScreen = left.reduce((a, b) => (b.x > a.x ? b : a))
    leftScreen.floors = Math.max(leftScreen.floors, 7)
    // trees on the pavements of every block but the office's, a pace in from the kerb
    const trees: [number, number][] = []
    const lamps: [number, number, number][] = []
    for (const c of Object.values(cols).concat([mid])) {
      for (const r of Object.values(rows)) {
        if (c === mid && r === rows.o) continue
        const [x0, x1] = c
        const [z0, z1] = r
        for (let x = x0 + 3; x < x1 - 2; x += 6.5) {
          trees.push([x, z0 + 0.8], [x, z1 - 0.8])
        }
        lamps.push([x0 + 0.5, z1 - 0.5, -Math.PI / 4], [x1 - 0.5, z0 + 0.5, (Math.PI * 3) / 4])
      }
    }
    // the mall: the whole block behind-left of the office
    const S = 1.6
    const mall = { x: (cols.l[0] + cols.l[1]) / 2, z: (rows.b[0] + rows.b[1]) / 2, w: cols.l[1] - cols.l[0] - 2 * S, d: rows.b[1] - rows.b[0] - 2 * S }
    // the café: the block right behind the office (low: the plaza shows over it)
    const cafe = { x: (mid[0] + mid[1]) / 2, z: (rows.b[0] + rows.b[1]) / 2, w: mid[1] - mid[0] - 2 * S, d: rows.b[1] - rows.b[0] - 2 * S }
    // and a bigger one, the whole block behind the office's (as wide as the office's)
    const plaza = { x: (mid[0] + mid[1]) / 2, z: (rows.bb[0] + rows.bb[1]) / 2, w: mid[1] - mid[0] - 2 * S, d: rows.bb[1] - rows.bb[0] - 2 * S }
    // across the front road from the office: one storey only (nothing hides the office's car park), and the one
    // facing the middle of the lot is the minimarket
    const facing = low.filter((b) => b.x > mid[0] && b.x < mid[1] && b.z < (rows.f[0] + rows.f[1]) / 2)
    for (const b of facing) b.floors = 1
    const lotMid = (lot.minX + lot.maxX) / 2
    const martAt = facing.reduce<Bld | null>((a, b) => (!a || Math.abs(b.x - lotMid) < Math.abs(a.x - lotMid) ? b : a), null)
    const lowRest = martAt ? low.filter((b) => b !== martAt) : low
    // what stands between the usual view and the office: across the front road, and the blocks to its right; only
    // these fade while the view is on the office (what's behind it hides nothing)
    const inFront = (x: number, z: number) => z > rows.f[0] - 0.01 || (x > R && z > rows.o[0])
    const front = lowRest.filter((b) => inFront(b.x, b.z))
    const aside = lowRest.filter((b) => !inFront(b.x, b.z))
    const split = <T extends number[]>(list: T[]) => [list.filter(([x, z]) => inFront(x, z)), list.filter(([x, z]) => !inFront(x, z))] as const
    const [frontTrees, otherTrees] = split(trees)
    const [frontLamps, otherLamps] = split(lamps)
    return { cols, rows, mid, behind, left, front, aside, near, leftScreen, frontTrees, otherTrees, frontLamps, otherLamps, mall, plaza, cafe, mart: martAt }
  }, [X0, X1, Z0, Z1, xRoads, zRoads, L, R, lot.minX, lot.maxX])

  // lit windows, signs and shop lights at night; the town faded while the view is on the office
  useFrame(({ camera }, dt) => {
    const target = MathUtils.lerp(1, FADED, MathUtils.clamp((camera.zoom - TOWN_ZOOM) / (FOCUS_ZOOM - TOWN_ZOOM), 0, 1))
    fade.now += (target - fade.now) * (1 - Math.exp(-8 * Math.min(dt, 0.05)))
    if (Math.abs(target - fade.now) < 0.002) fade.now = target
    shopGlow.emissiveIntensity = env.night * 1.4
    streetBulb.emissiveIntensity = lampBulb.emissiveIntensity
    for (const m of pools) m.opacity = env.night * 0.5
    litWindow.emissiveIntensity = env.night * 1.3
    nightPane.emissiveIntensity = env.night * 1.3
    mallGlass.color.copy(windowGlass.color)
    mallGlass.emissive.copy(windowGlass.emissive)
    for (const m of glowing) m.emissiveIntensity = env.night * 0.9
  })

  // the streets the cars drive (the agents who are off too), and the seats in town they sit at
  const streets = useMemo<Streets>(
    () => ({
      xs: [xRoads.l2, xRoads.l1, xRoads.r1, xRoads.r2].map(([a, b]) => (a + b) / 2),
      zs: [zRoads.b2, zRoads.b1, zRoads.f1, zRoads.f2].map(([a, b]) => (a + b) / 2),
      // not along the office's car park (the agents' way in): it's where they leave the streets
      closed: [2, 1],
      home: [2, 2],
    }),
    [xRoads, zRoads],
  )
  setStreets(streets)
  const shopX = town.cols.l[1] - 3.2
  useMemo(
    () => setSeats(townSeats(town.cafe, { x: shopX + 2.6, zs: [-3, 0, 3].map((dx) => town.rows.o[1] - 6 + dx) }, xRoads.l1[1] + 1)),
    [town, shopX, xRoads],
  )

  const v = `${L}:${R}`
  const { cols, rows } = town
  // the roads along x run the town's width, but the front one only beyond the lot (the lot draws its own stretch)
  const roadsX = [zRoads.b2, zRoads.b1, zRoads.f2]
  const roadsZ = [xRoads.l2, xRoads.l1, xRoads.r1, xRoads.r2]
  return (
    <group>
      <StaticBatch version={v}>
        {/* the ground: paving everywhere, under the roads and blocks */}
        <Box size={[X1 - X0, 0.4, Z1 - Z0]} position={[(X0 + X1) / 2, -0.23, (Z0 + Z1) / 2]} color={PAVING} noShadow />
        {roadsX.map(([z0, z1]) => (
          <Road key={`x${z0}`} x0={X0} x1={X1} z0={z0} z1={z1} along="x" />
        ))}
        <Road x0={X0} x1={lot.minX} z0={zRoads.f1[0]} z1={zRoads.f1[1]} along="x" />
        <Road x0={lot.maxX} x1={X1} z0={zRoads.f1[0]} z1={zRoads.f1[1]} along="x" />
        {roadsZ.map(([x0, x1]) => (
          <Road key={`z${x0}`} x0={x0} x1={x1} z0={Z0} z1={Z1} along="z" />
        ))}
        {/* the office's crossroads: zebra stripes over every arm, a traffic light on the outer corners */}
        {[xRoads.l1, xRoads.r1].flatMap(([x0, x1], k) => [
          <Crossing key={`cb${k}`} x={(x0 + x1) / 2} z={zRoads.b1[0] - 1.4} width={x1 - x0} along="z" />,
          <Crossing key={`cf${k}`} x={(x0 + x1) / 2} z={zRoads.f1[1] + 1.4} width={x1 - x0} along="z" />,
          <Crossing key={`cs${k}`} x={k ? x1 + 1.4 : x0 - 1.4} z={(zRoads.f1[0] + zRoads.f1[1]) / 2} width={zRoads.f1[1] - zRoads.f1[0]} along="x" />,
          <Crossing key={`cz${k}`} x={k ? x1 + 1.4 : x0 - 1.4} z={(zRoads.b1[0] + zRoads.b1[1]) / 2} width={ROAD_W} along="x" />,
        ])}
        {town.mart && (
          <group position={[town.mart.x, 0, town.mart.z]}>
            <Minimart w={town.mart.w} d={town.mart.d} />
          </group>
        )}
        <group position={[town.cafe.x, 0, town.cafe.z]}>
          <Cafe w={town.cafe.w} d={town.cafe.d} />
        </group>
        {/* the coffee shop and the warung on the left road, facing it (+x: towards the usual view) */}
        <group position={[shopX, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <CoffeeShop x={rows.o[1] - 6} z={3} />
          <WarungPecelLele x={rows.o[0] + 6} z={2.1} />
        </group>
      </StaticBatch>
      {/* the café's terrace and roof, and the coffee shop's tables: lit for real at night */}
      {cfg.fixedLights !== 'none' && (
        <group>
          {[-1 / 3, 0, 1 / 3].map((k) => (
            <NightLight key={k} position={[town.cafe.x + k * town.cafe.w, 3.2, town.cafe.z + cafeTerraceZ(town.cafe.w, town.cafe.d)]} power={7} distance={10} />
          ))}
          <NightLight position={[town.cafe.x, 9, town.cafe.z - town.cafe.d / 2 + 0.8 + CAFE_DEPTH / 2]} power={5} distance={10} />
          <NightLight position={[shopX + 2.6, 3, town.rows.o[1] - 6]} power={6} distance={8} />
        </group>
      )}
      {/* a few cars and motorbikes about town (not on the office's own stretch of the front road: the agents' way in) */}
      <Traffic net={streets} cars={6} motos={5} />
      {/* the street furniture: trees and lamp posts in front of the office fade with the buildings there */}
      <Fade>
        {/* painted shadows only where the sun casts none (the low render tier): real ones fall on the buildings too */}
        {!cfg.shadowMap && <GroundShadows buildings={town.front} />}
        <StaticBatch version={v}>
          {town.frontTrees.map(([x, z], i) => (
            <StreetTree key={`t${i}`} x={x} z={z} seed={i} />
          ))}
          {town.frontLamps.map(([x, z, rot], i) => (
            <StreetLamp key={`l${i}`} x={x} z={z} rotY={rot} />
          ))}
          {town.front.map((b, i) => (
            <Building key={`w${i}`} b={b} />
          ))}
        </StaticBatch>
      </Fade>
      {!cfg.shadowMap && <GroundShadows buildings={[...town.behind, ...town.left, ...town.aside, { ...town.mall, floors: 5, color: '', roof: '', seed: 0 }, { ...town.plaza, floors: 6, color: '', roof: '', seed: 0 }]} />}
      <StaticBatch version={v}>
        {town.otherTrees.map(([x, z], i) => (
          <StreetTree key={`t${i}`} x={x} z={z} seed={i + 1000} />
        ))}
        {town.otherLamps.map(([x, z, rot], i) => (
          <StreetLamp key={`l${i}`} x={x} z={z} rotY={rot} />
        ))}
        <TrafficLight x={xRoads.l1[0] - 0.7} z={zRoads.b1[0] - 0.7} rotY={Math.PI / 2} lit={2} />
        <TrafficLight x={xRoads.r1[1] + 0.7} z={zRoads.b1[0] - 0.7} rotY={-Math.PI / 2} lit={0} />
        <TrafficLight x={xRoads.l1[0] - 0.7} z={zRoads.f1[1] + 0.7} rotY={Math.PI / 2} lit={0} />
        <TrafficLight x={xRoads.r1[1] + 0.7} z={zRoads.f1[1] + 0.7} rotY={-Math.PI / 2} lit={2} />
        {town.aside.map((b, i) => (
          <Building key={`w${i}`} b={b} />
        ))}
      </StaticBatch>
      {/* the tall sides: cut away while the view looks at the office through them (from behind); seen from the front
          they hide nothing and stay solid */}
      <Side inward={[0, 1]} version={v}>
        {town.behind.map((b, i) => (
          <Building key={`b${i}`} b={b} />
        ))}
        <group position={[town.mall.x, 0, town.mall.z]}>
          <Mall w={town.mall.w} d={town.mall.d} />
        </group>
        <group position={[town.plaza.x, 0, town.plaza.z]}>
          <Mall w={town.plaza.w} d={town.plaza.d} name="AFTER PLAZA" H={16} first={2} />
        </group>
        <VideoScreen w={Math.min(town.near.w - 1.2, 9.5)} position={[town.near.x, town.near.floors * FLOOR * 0.66, town.near.z + town.near.d / 2 + 0.2]} />
      </Side>
      <Side inward={[1, 0]} version={v}>
        {town.left.map((b, i) => (
          <Building key={`l${i}`} b={b} />
        ))}
        <VideoScreen
          w={Math.min(town.leftScreen.w - 1.2, 7)}
          offset={9}
          position={[town.leftScreen.x, town.leftScreen.floors * FLOOR * 0.62, town.leftScreen.z + town.leftScreen.d / 2 + 0.2]}
        />
      </Side>
    </group>
  )
}
