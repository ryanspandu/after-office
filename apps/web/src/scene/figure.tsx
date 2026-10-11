import type { Look } from '../state/store'
import { Box } from './prims'

// The people of the office, in blocks (voxel style) with a person's build: long legs, a neck, slim shoulders, elbows
// and knees. scene/Agent.tsx rigs them (the joints and poses); the parts below make each one look like themselves
// (ui/FigurePicker.tsx).
//
// Head space: the head box spans x ±0.23, y 0 → 0.44, z ±0.22, the face at +z (drawn at HEAD_SCALE). Torso space: from
// the hips up; what's worn on the body was made for a 0.5 × 0.56 × 0.3 box and is fitted to this one with TORSO_FIT.

/** The head is drawn at this scale: about a sixth of the body's height. */
export const HEAD_SCALE = 0.8

// Rig sizes (scene/Agent.tsx)
/** where the arms hang, and the base of the head, in torso space (from the hips) */
export const SHOULDER = 0.55
export const NECK = 0.63
/** hip to knee, shoulder to elbow */
export const KNEE = 0.42
export const ELBOW = 0.29
/** how far out the arms hang (just outside the body) */
export const SHOULDER_X = 0.285

// the body box
const BODY = { w: 0.44, h: 0.6, d: 0.26 }
/** What's worn on the body (made for the 0.5 × 0.56 × 0.3 box) fitted to this body. */
export const TORSO_FIT = { x: BODY.w / 0.5, y: 0, scale: BODY.h / 0.56, z: BODY.d / 0.3 }

/** A colour pale enough to pass for skin (silver hair, a white beanie) a little darker, so a head never looks bald. */
export function notSkin(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (light < 0.58) return hex
  const k = 0.58 / light
  const ch = (v: number) => Math.round(v * k).toString(16).padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

/** The body and the neck. Shared by every look (their colours come from it). */
export function TorsoShape({ color, skin, woman }: { color: string; skin: string; woman?: boolean }) {
  return (
    <>
      {/* chest and shoulders, a narrower waist under them (a woman's waist a little narrower still) */}
      <Box size={[BODY.w, BODY.h * 0.55, BODY.d]} position={[0, BODY.h * 0.725, 0]} color={color} />
      <Box size={[BODY.w - (woman ? 0.1 : 0.06), BODY.h * 0.46, BODY.d - 0.02]} position={[0, BODY.h * 0.23, 0]} color={color} />
      <Box size={[0.14, 0.1, 0.14]} position={[0, NECK - 0.03, 0]} color={skin} />
    </>
  )
}
/** The hips: the trousers' top, joining the legs to the body. */
export function HipsShape({ color }: { color: string }) {
  return <Box size={[0.4, 0.14, 0.24]} position={[0, -0.01, 0]} color={color} />
}
export function UpperArmShape({ sleeve }: { sleeve: string }) {
  return <Box size={[0.13, ELBOW + 0.02, 0.14]} position={[0, -ELBOW / 2 + 0.01, 0]} color={sleeve} />
}
/** Elbow to fingertips: the forearm in its sleeve and the hand. */
export function ForearmShape({ sleeve, skin }: { sleeve: string; skin: string }) {
  return (
    <>
      <Box size={[0.12, 0.25, 0.13]} position={[0, -0.12, 0]} color={sleeve} />
      <Box size={[0.11, 0.11, 0.12]} position={[0, -0.29, 0]} color={skin} />
    </>
  )
}
export function ThighShape({ color }: { color: string }) {
  return <Box size={[0.17, KNEE + 0.02, 0.19]} position={[0, -KNEE / 2, 0]} color={color} />
}
export function ShinShape({ color, shoes }: { color: string; shoes: string }) {
  return (
    <>
      <Box size={[0.15, 0.34, 0.17]} position={[0, -0.17, 0]} color={color} />
      <Box size={[0.17, 0.08, 0.27]} position={[0, -0.39, 0.04]} color={shoes} />
      {/* a chunky sole */}
      <Box size={[0.18, 0.02, 0.28]} position={[0, -0.425, 0.04]} color="#e9e6df" noShadow />
    </>
  )
}
export function Skirt({ color }: { color: string }) {
  return <Box size={[0.46, 0.34, 0.3]} position={[0, -0.1, 0]} color={color} />
}

/** The head itself, its eyes and cheeks. */
export function Face({ skin }: { skin: string }) {
  return (
    <>
      <Box size={[0.46, 0.44, 0.44]} position={[0, 0.22, 0]} color={skin} />
      {[-0.1, 0.1].map((x) => (
        <Box key={x} size={[0.06, 0.08, 0.02]} position={[x, 0.24, 0.225]} color="#1b1b22" noShadow />
      ))}
      {[-0.16, 0.16].map((x) => (
        <Box key={x} size={[0.07, 0.04, 0.01]} position={[x, 0.15, 0.225]} color="#f19a8a" opacity={0.7} noShadow />
      ))}
    </>
  )
}

// Head parts, in head space: the head box spans x ±0.23, y 0 → 0.44, z ±0.22 (the face is at +z). Hair stays within
// the head's height: a long slab down the back used to poke out of the shoulders when the agent leaned over (petting
// the cat, playing pool).

export function Hair({ look }: { look: Look }) {
  const c = notSkin(look.hair)
  const top = <Box size={[0.5, 0.12, 0.48]} position={[0, 0.47, -0.01]} color={c} />
  const fringe = <Box size={[0.5, 0.08, 0.06]} position={[0, 0.39, 0.21]} color={c} />
  const locks = (h: number, y: number) =>
    [-0.255, 0.255].map((x) => <Box key={x} size={[0.06, h, 0.36]} position={[x, y, -0.03]} color={c} />)
  switch (look.hairStyle) {
    case 'buzz':
      return (
        <>
          <Box size={[0.48, 0.05, 0.46]} position={[0, 0.455, 0]} color={c} />
          <Box size={[0.48, 0.22, 0.03]} position={[0, 0.32, -0.225]} color={c} />
        </>
      )
    case 'curly':
      return (
        <>
          {top}
          {[-0.16, 0, 0.16].flatMap((x) =>
            [-0.14, 0.02, 0.16].map((z) => <Box key={`${x}${z}`} size={[0.15, 0.1, 0.15]} position={[x, 0.55 + ((x + z) * 10) % 2 * 0.015, z]} color={c} />),
          )}
          <Box size={[0.5, 0.3, 0.1]} position={[0, 0.3, -0.2]} color={c} />
        </>
      )
    case 'mullet':
      return (
        <>
          {top}
          <Box size={[0.48, 0.44, 0.1]} position={[0, 0.24, -0.2]} color={c} />
          {locks(0.16, 0.34)}
        </>
      )
    case 'bun':
      return (
        <>
          {top}
          <Box size={[0.5, 0.3, 0.1]} position={[0, 0.3, -0.2]} color={c} />
          <Box size={[0.17, 0.14, 0.17]} position={[0, 0.6, -0.1]} color={c} />
        </>
      )
    case 'long':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.52, 0.5, 0.1]} position={[0, 0.2, -0.22]} color={c} />
          {locks(0.44, 0.2)}
        </>
      )
    case 'bob':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.52, 0.34, 0.1]} position={[0, 0.3, -0.21]} color={c} />
          {locks(0.3, 0.27)}
        </>
      )
    case 'ponytail':
      return (
        <>
          {top}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          <Box size={[0.08, 0.06, 0.08]} position={[0, 0.36, -0.28]} color={look.hatColor} />
          <Box size={[0.13, 0.3, 0.12]} position={[0, 0.2, -0.3]} color={c} />
        </>
      )
    case 'buns':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          {[-0.17, 0.17].map((x) => (
            <Box key={x} size={[0.16, 0.15, 0.16]} position={[x, 0.59, -0.04]} color={c} />
          ))}
        </>
      )
    case 'pigtails':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          {[-0.29, 0.29].map((x) => (
            <Box key={x} size={[0.1, 0.3, 0.1]} position={[x, 0.2, -0.1]} color={c} />
          ))}
        </>
      )
    case 'fluffy':
      // a soft, full fringe over the forehead
      return (
        <>
          <Box size={[0.52, 0.16, 0.5]} position={[0, 0.49, -0.01]} color={c} />
          <Box size={[0.5, 0.12, 0.07]} position={[0, 0.37, 0.21]} color={c} />
          <Box size={[0.5, 0.3, 0.12]} position={[0, 0.3, -0.19]} color={c} />
          {locks(0.14, 0.35)}
        </>
      )
    case 'wolf':
      // shaggy layers: a fringe, choppy sides and a longer nape
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.38, 0.1]} position={[0, 0.25, -0.2]} color={c} />
          {locks(0.26, 0.29)}
          {[-0.12, 0.12].map((x) => (
            <Box key={x} size={[0.14, 0.1, 0.08]} position={[x, 0.08, -0.22]} color={c} />
          ))}
        </>
      )
    case 'spiky':
      return (
        <>
          {top}
          <Box size={[0.5, 0.3, 0.12]} position={[0, 0.3, -0.19]} color={c} />
          {[-0.15, 0, 0.15].flatMap((x) =>
            [-0.08, 0.12].map((z) => <Box key={`${x}${z}`} size={[0.08, 0.1, 0.08]} position={[x, 0.57, z]} rotation={[0, 0, x * 2]} color={c} />),
          )}
        </>
      )
    case 'curtain':
      // bangs parted in the middle, long at the back
      return (
        <>
          {top}
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.22, 0.13, 0.06]} position={[sd * 0.13, 0.37, 0.21]} rotation={[0, 0, sd * -0.3]} color={c} />
          ))}
          <Box size={[0.52, 0.5, 0.1]} position={[0, 0.2, -0.22]} color={c} />
          {locks(0.42, 0.21)}
        </>
      )
    case 'high-pony':
      return (
        <>
          {top}
          {fringe}
          <Box size={[0.5, 0.26, 0.08]} position={[0, 0.33, -0.2]} color={c} />
          <Box size={[0.1, 0.07, 0.1]} position={[0, 0.54, -0.22]} color={look.hatColor} />
          <Box size={[0.14, 0.34, 0.12]} position={[0, 0.36, -0.3]} color={c} />
        </>
      )
    case 'short':
    default:
      return (
        <>
          {top}
          <Box size={[0.5, 0.3, 0.12]} position={[0, 0.3, -0.19]} color={c} />
        </>
      )
  }
}

export function Hat({ kind, color: raw }: { kind: Look['hat']; color: string }) {
  const color = notSkin(raw)
  switch (kind) {
    case 'beanie':
      return (
        <>
          <Box size={[0.52, 0.2, 0.5]} position={[0, 0.52, 0]} color={color} />
          <Box size={[0.54, 0.07, 0.52]} position={[0, 0.42, 0]} color={color} roughness={1} />
          <Box size={[0.1, 0.08, 0.1]} position={[0, 0.66, 0]} color="#f5f5f3" />
        </>
      )
    case 'cap':
    case 'cap-back':
      return (
        <>
          <Box size={[0.52, 0.14, 0.5]} position={[0, 0.5, 0]} color={color} />
          <Box size={[0.4, 0.04, 0.2]} position={[0, 0.45, kind === 'cap' ? 0.32 : -0.32]} color={color} />
        </>
      )
    case 'bucket':
      return (
        <>
          <Box size={[0.48, 0.16, 0.46]} position={[0, 0.56, 0]} color={color} />
          <Box size={[0.66, 0.03, 0.64]} position={[0, 0.47, 0]} color={color} />
        </>
      )
    case 'headphones':
      return (
        <>
          <Box size={[0.56, 0.05, 0.08]} position={[0, 0.57, 0]} color="#2a2d36" />
          {[-1, 1].map((s) => (
            <Box key={s} size={[0.04, 0.3, 0.06]} position={[s * 0.285, 0.42, 0]} color="#2a2d36" />
          ))}
          {[-1, 1].map((s) => (
            <Box key={s} size={[0.08, 0.17, 0.17]} position={[s * 0.29, 0.25, 0]} color={color} />
          ))}
        </>
      )
    case 'beret':
      return (
        <>
          <Box size={[0.52, 0.08, 0.5]} position={[0.03, 0.5, -0.01]} rotation={[0, 0, -0.14]} color={color} />
          <Box size={[0.04, 0.05, 0.04]} position={[0.04, 0.56, 0]} color={color} />
        </>
      )
    case 'visor':
      return (
        <>
          <Box size={[0.5, 0.06, 0.03]} position={[0, 0.42, 0.225]} color={color} />
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.03, 0.06, 0.44]} position={[sd * 0.245, 0.42, 0]} color={color} />
          ))}
          <Box size={[0.42, 0.03, 0.18]} position={[0, 0.41, 0.33]} color={color} />
        </>
      )
    case 'bandana':
      return (
        <>
          <Box size={[0.52, 0.1, 0.5]} position={[0, 0.44, 0]} color={color} />
          <Box size={[0.1, 0.08, 0.06]} position={[0, 0.42, -0.28]} color={color} />
          <Box size={[0.05, 0.12, 0.03]} position={[0.05, 0.34, -0.3]} rotation={[0, 0, 0.3]} color={color} />
        </>
      )
    case 'cat-ears':
      return (
        <>
          <Box size={[0.5, 0.04, 0.05]} position={[0, 0.5, 0.05]} color="#2a2d36" />
          {[-1, 1].map((sd) => (
            <group key={sd} position={[sd * 0.16, 0.56, 0.05]} rotation={[0, 0, Math.PI / 4]}>
              <Box size={[0.11, 0.11, 0.05]} color={color} />
              <Box size={[0.06, 0.06, 0.01]} position={[0, 0, 0.03]} color="#ffb3c7" noShadow />
            </group>
          ))}
        </>
      )
    case 'clips':
      // Y2K hair clips over the fringe
      return (
        <>
          {[[-0.16, 0.42, color], [-0.07, 0.44, '#ffd6a5'], [0.15, 0.43, '#a0c4ff']].map(([x, y, c]) => (
            <Box key={x as number} size={[0.08, 0.025, 0.02]} position={[x as number, y as number, 0.25]} rotation={[0, 0, 0.3]} color={c as string} noShadow />
          ))}
        </>
      )
    default:
      return null
  }
}

/** Earrings and earbuds, at the sides of the head (long hair may cover them). */
export function Ear({ kind }: { kind: Look['ear'] }) {
  if (kind === 'none') return null
  return (
    <>
      {[-1, 1].map((sd) =>
        kind === 'stud' ? (
          <Box key={sd} size={[0.03, 0.03, 0.03]} position={[sd * 0.24, 0.17, 0.03]} color="#e3c15a" roughness={0.3} noShadow />
        ) : kind === 'hoops' ? (
          <mesh key={sd} position={[sd * 0.245, 0.12, 0.03]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.035, 0.008, 6, 14]} />
            <meshStandardMaterial color="#e3c15a" roughness={0.3} metalness={0.4} />
          </mesh>
        ) : (
          <group key={sd}>
            <Box size={[0.05, 0.05, 0.05]} position={[sd * 0.245, 0.2, 0.03]} color="#f5f5f3" roughness={0.2} noShadow />
            <Box size={[0.02, 0.07, 0.02]} position={[sd * 0.25, 0.15, 0.05]} color="#f5f5f3" roughness={0.2} noShadow />
          </group>
        ),
      )}
    </>
  )
}

/** What's over the shirt, in torso space (the chest faces +z at 0.15). */
export function Top({ look }: { look: Look }) {
  const a = look.accent
  switch (look.top) {
    case 'graphic':
      return <Box size={[0.2, 0.16, 0.012]} position={[0, 0.3, 0.157]} color={a} noShadow />
    case 'hoodie':
      return (
        <>
          {/* the hood lying on the back, the strings and the front pocket */}
          <Box size={[0.44, 0.16, 0.12]} position={[0, 0.52, -0.19]} color={look.shirt} />
          {[-0.06, 0.06].map((x) => (
            <Box key={x} size={[0.02, 0.14, 0.012]} position={[x, 0.42, 0.157]} color={a} noShadow />
          ))}
          <Box size={[0.3, 0.12, 0.014]} position={[0, 0.12, 0.157]} color="#000000" opacity={0.14} noShadow />
        </>
      )
    case 'jacket':
      // open at the front: two panels over the shirt (its sleeves are the jacket's colour too)
      return (
        <>
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.17, 0.56, 0.02]} position={[sd * 0.165, 0.28, 0.157]} color={a} />
          ))}
          {[-1, 1].map((sd) => (
            <Box key={sd} size={[0.12, 0.08, 0.03]} position={[sd * 0.12, 0.53, 0.16]} rotation={[0, 0, sd * 0.4]} color={a} />
          ))}
          <Box size={[0.52, 0.56, 0.02]} position={[0, 0.28, -0.157]} color={a} />
        </>
      )
    case 'vest':
      return <Box size={[0.44, 0.36, 0.02]} position={[0, 0.22, 0.157]} color={a} />
    default:
      return null
  }
}

/** A backpack (straps over the shoulders) or a crossbody bag, in torso space. */
export function Bag({ look }: { look: Look }) {
  const c = look.bagColor
  if (look.bag === 'backpack')
    return (
      <>
        <Box size={[0.36, 0.38, 0.14]} position={[0, 0.28, -0.23]} color={c} />
        <Box size={[0.26, 0.12, 0.04]} position={[0, 0.18, -0.31]} color={c} opacity={0.9} />
        {[-0.13, 0.13].map((x) => (
          <Box key={x} size={[0.05, 0.3, 0.02]} position={[x, 0.38, 0.175]} color={c} noShadow />
        ))}
      </>
    )
  if (look.bag === 'crossbody')
    return (
      <>
        <Box size={[0.05, 0.62, 0.02]} position={[0, 0.3, 0.175]} rotation={[0, 0, 0.72]} color="#2a2d36" noShadow />
        <Box size={[0.18, 0.13, 0.08]} position={[0.2, 0.06, 0.17]} color={c} />
      </>
    )
  return null
}

export function Eyewear({ kind }: { kind: Look['eyewear'] }) {
  if (kind === 'round')
    return (
      <group position={[0, 0.24, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <mesh key={x} position={[x, 0, 0]}>
            <torusGeometry args={[0.065, 0.012, 6, 16]} />
            <meshStandardMaterial color="#1b1b22" />
          </mesh>
        ))}
        <Box size={[0.07, 0.015, 0.01]} color="#1b1b22" noShadow />
      </group>
    )
  if (kind === 'square')
    return (
      <group position={[0, 0.24, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <Box size={[0.14, 0.02, 0.012]} position={[0, 0.05, 0]} color="#1b1b22" noShadow />
            <Box size={[0.14, 0.02, 0.012]} position={[0, -0.05, 0]} color="#1b1b22" noShadow />
            <Box size={[0.02, 0.1, 0.012]} position={[-0.06, 0, 0]} color="#1b1b22" noShadow />
            <Box size={[0.02, 0.1, 0.012]} position={[0.06, 0, 0]} color="#1b1b22" noShadow />
          </group>
        ))}
        <Box size={[0.06, 0.015, 0.012]} color="#1b1b22" noShadow />
      </group>
    )
  if (kind === 'y2k')
    // small tinted ovals
    return (
      <group position={[0, 0.245, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <Box key={x} size={[0.13, 0.065, 0.015]} position={[x, 0, 0]} color="#ff7eb6" opacity={0.75} roughness={0.2} noShadow />
        ))}
        <Box size={[0.07, 0.012, 0.012]} color="#c9c9d9" noShadow />
      </group>
    )
  if (kind === 'sport')
    // one wraparound shield
    return (
      <group position={[0, 0.25, 0.235]}>
        <Box size={[0.46, 0.09, 0.02]} color="#6ee7f9" roughness={0.1} opacity={0.85} noShadow />
        <Box size={[0.46, 0.015, 0.022]} position={[0, 0.05, 0]} color="#1b1b22" noShadow />
      </group>
    )
  if (kind === 'heart')
    return (
      <group position={[0, 0.24, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <Box size={[0.08, 0.08, 0.015]} position={[0, -0.01, 0]} rotation={[0, 0, Math.PI / 4]} color="#ff4d6d" roughness={0.3} noShadow />
            {[-0.025, 0.025].map((dx) => (
              <Box key={dx} size={[0.055, 0.055, 0.015]} position={[dx, 0.025, 0]} color="#ff4d6d" roughness={0.3} noShadow />
            ))}
          </group>
        ))}
        <Box size={[0.05, 0.012, 0.012]} position={[0, 0.02, 0]} color="#ff4d6d" noShadow />
      </group>
    )
  if (kind === 'shades')
    return (
      <group position={[0, 0.25, 0.235]}>
        {[-0.1, 0.1].map((x) => (
          <Box key={x} size={[0.15, 0.09, 0.015]} position={[x, 0, 0]} color="#101014" roughness={0.3} noShadow />
        ))}
        <Box size={[0.46, 0.02, 0.012]} position={[0, 0.035, 0]} color="#101014" noShadow />
      </group>
    )
  return null
}

/** Around the neck, in torso space (the chest is at z 0.15): a chain, a pendant, a scarf, a choker or a lanyard. */
export function Neckwear({ kind, color }: { kind: Look['neckwear']; color: string }) {
  if (kind === 'none') return null
  const gold = '#e3c15a'
  if (kind === 'scarf')
    return (
      <group position={[0, 0.54, 0]}>
        <Box size={[0.52, 0.1, 0.34]} color={color} />
        <Box size={[0.1, 0.24, 0.03]} position={[0.1, -0.14, 0.17]} color={color} />
      </group>
    )
  if (kind === 'choker')
    return (
      <group position={[0, 0.555, 0.172]}>
        <Box size={[0.26, 0.03, 0.012]} color="#1b1b22" noShadow />
        <Box size={[0.03, 0.03, 0.014]} position={[0, -0.03, 0]} color={gold} roughness={0.3} noShadow />
      </group>
    )
  if (kind === 'lanyard')
    return (
      <group position={[0, 0.5, 0.174]}>
        {[-1, 1].map((s) => (
          <Box key={s} size={[0.02, 0.26, 0.01]} position={[s * 0.07, -0.1, 0]} rotation={[0, 0, s * 0.3]} color={color} noShadow />
        ))}
        <Box size={[0.1, 0.13, 0.012]} position={[0, -0.28, 0]} color="#f5f5f3" noShadow />
        <Box size={[0.06, 0.03, 0.014]} position={[0, -0.25, 0]} color={color} noShadow />
      </group>
    )
  return (
    <group position={[0, 0.5, 0.174]}>
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.022, 0.16, 0.012]} position={[s * 0.055, -0.05, 0]} rotation={[0, 0, s * 0.55]} color={gold} roughness={0.35} noShadow />
      ))}
      {kind === 'pendant' && <Box size={[0.06, 0.07, 0.015]} position={[0, -0.15, 0]} color="#7aa7e8" roughness={0.3} noShadow />}
      {kind === 'chain' && <Box size={[0.04, 0.03, 0.012]} position={[0, -0.12, 0]} color={gold} roughness={0.35} noShadow />}
    </group>
  )
}
