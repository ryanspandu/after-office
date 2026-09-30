import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { AdditiveBlending, CanvasTexture, Color, SRGBColorSpace, type MeshBasicMaterial, type MeshStandardMaterial } from 'three'
import { env } from './DayNight'

// "AFTER OFFICE" in heavy lettering on the back wall.
// Day: amber letters with a dark outline and a soft drop shadow, so they read against the light wall, softly lit.
// Night: brightly lit letters with an additive halo (the halo would only wash the letters out on a light wall).

const W = 2048
const H = 400
const FONT = '900 250px Inter, "Arial Black", "Helvetica Neue", sans-serif'
const SPACING = 18

type Layer = 'letters' | 'glow' | 'shadow'

function draw(text: string, layer: Layer) {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = FONT
  ctx.lineJoin = 'round'
  // hand-spaced letters (canvas letterSpacing isn't available everywhere)
  const chars = [...text]
  const widths = chars.map((ch) => ctx.measureText(ch).width)
  const total = widths.reduce((a, b) => a + b, 0) + SPACING * (chars.length - 1)
  const each = (fn: (ch: string, x: number, y: number) => void, dy = 0) => {
    let x = (W - total) / 2
    chars.forEach((ch, i) => {
      fn(ch, x + widths[i] / 2, H / 2 + 10 + dy)
      x += widths[i] + SPACING
    })
  }
  if (layer === 'glow') {
    ctx.fillStyle = '#ffcf4a'
    ctx.shadowColor = '#ffbf1a'
    ctx.shadowBlur = 36
    each((ch, x, y) => ctx.fillText(ch, x, y))
  } else if (layer === 'shadow') {
    // soft dark shadow a little below the letters (day only)
    ctx.fillStyle = '#2b1a04'
    ctx.shadowColor = '#2b1a04'
    ctx.shadowBlur = 22
    each((ch, x, y) => ctx.fillText(ch, x, y), 10)
  } else {
    // white fill (tinted by the material colour) with a dark brown outline for contrast
    ctx.strokeStyle = '#3a2508'
    ctx.lineWidth = 14
    each((ch, x, y) => ctx.strokeText(ch, x, y))
    ctx.fillStyle = '#fff'
    each((ch, x, y) => ctx.fillText(ch, x, y))
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Build textures once the script font has loaded (falls back to a system script font). */
function useSignTextures(text: string) {
  const [tex, setTex] = useState<{ letters: CanvasTexture; glow: CanvasTexture; shadow: CanvasTexture } | null>(null)
  useEffect(() => {
    let alive = true
    const build = () => alive && setTex({ letters: draw(text, 'letters'), glow: draw(text, 'glow'), shadow: draw(text, 'shadow') })
    document.fonts.load(FONT, text).then(build, build)
    return () => {
      alive = false
    }
  }, [text])
  return tex
}

const DAY = new Color('#e9a41f')
const NIGHT = new Color('#ffd76a')

export function WallSign({ position, width }: { position: [number, number, number]; width: number }) {
  const tex = useSignTextures('AFTER OFFICE')
  const letters = useRef<MeshStandardMaterial>(null)
  const halo = useRef<MeshBasicMaterial>(null)
  const shadow = useRef<MeshBasicMaterial>(null)
  const height = (width * H) / W

  useFrame(() => {
    const n = env.night
    if (letters.current) {
      letters.current.color.lerpColors(DAY, NIGHT, n)
      // softly lit by day, bright at night
      letters.current.emissiveIntensity = 0.35 + n * 0.85
    }
    // additive halo only after dark; a dark drop shadow gives contrast by day
    if (halo.current) halo.current.opacity = n * 0.45
    if (shadow.current) shadow.current.opacity = (1 - n) * 0.4
  })

  if (!tex) return null
  return (
    <group position={position}>
      <mesh position={[0, 0, 0.02]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial ref={shadow} map={tex.shadow} transparent opacity={0.4} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.025]} scale={1.04}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial ref={halo} map={tex.glow} transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.04]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          ref={letters}
          map={tex.letters}
          emissiveMap={tex.letters}
          emissive="#ffc93c"
          transparent
          alphaTest={0.3}
          roughness={0.4}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}
