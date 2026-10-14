import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DepthTexture, HalfFloatType, MathUtils, Mesh, type Vector3, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, UnsignedIntType, Vector2, WebGLRenderTarget, type OrthographicCamera as OrthoCam } from 'three'

// Dark outlines around everything, like a hand-drawn isometric game (with toon shading, scene/toon.ts), and a warm,
// colour grade after the owner's palette. The office is drawn into a texture first; a full-screen pass then shows it, graded, and
// darkens the pixels where the depth jumps: an edge
// between an object and what's behind it. Depth's second difference is used, not its slope, so a floor seen at an angle
// (whose depth changes evenly) gets no lines, only real edges do. Transparent things (glass, light pools) don't write
// depth: no lines around them. Labels are HTML above the canvas: not outlined.

/**
 * The colour grade, after the owner's palette (sunny yellow, orange, red-orange; lavender and deep purple): a slight warm
 * tint (rgb multipliers), a gentle S-curve of contrast (0–1), a little more colour (1 = as is), the dark parts pulled
 * towards purple (how much, 0–1) and the light ones towards orange-yellow, and slightly darker corners (0 = none).
 */
const GRADE = { warmth: [1.02, 1.0, 0.98] as const, contrast: 0.14, saturation: 1.1, shadowWarmth: 0.55, highlight: 0.45, vignette: 0.35 }

/** The town behind the office darkens with distance: from this far (world units) beyond what the camera looks at, to
 *  full at this far, by this much (0–1). */
const RECEDE = { from: 6, to: 40, amount: 0.8 }

/** Line colour, and how dark it is drawn (0–1). */
const INK = [0.13, 0.1, 0.08] as const
const STRENGTH = 0.85
/** A depth jump (in world units) from which a pixel is an edge. */
const THRESHOLD = 0.06
/**
 * Seen from afar the lines stay a pixel wide while everything else shrinks: chair legs and plants would be all line.
 * Between these zooms (camera.zoom) only bigger and bigger edges get one. A line is always drawn at full strength:
 * faint ones read as a grey halo, i.e. as blur.
 */
const FAR_ZOOM = 14
const NEAR_ZOOM = 42
const FAR_THRESHOLD = 3

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`
const fragment = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 texel;
  uniform float near;
  uniform float far;
  uniform float threshold;
  uniform vec3 ink;
  uniform float strength;
  uniform float focus;
  uniform float recede;
  uniform float recedeFrom;
  uniform float recedeTo;
  uniform vec3 warmth;
  uniform float contrast;
  uniform float saturation;
  uniform float shadowWarmth;
  uniform float highlight;
  uniform float vignette;
  varying vec2 vUv;
  // orthographic: depth is linear between near and far
  float z(vec2 at) { return near + texture2D(tDepth, at).x * (far - near); }
  float jump(vec2 at) {
    float c = z(at);
    float dx = abs(z(at + vec2(texel.x, 0.0)) + z(at - vec2(texel.x, 0.0)) - 2.0 * c);
    float dy = abs(z(at + vec2(0.0, texel.y)) + z(at - vec2(0.0, texel.y)) - 2.0 * c);
    return max(dx, dy);
  }
  void main() {
    vec4 col = texture2D(tColor, vUv);
    // depth: what lies further back than the office (the town behind it) is darker, towards a purple shade, so the
    // nearer buildings stand out
    float zc = z(vUv);
    if (texture2D(tDepth, vUv).x < 1.0) {
      float back = smoothstep(focus + recedeFrom, focus + recedeTo, zc) * recede;
      // lights (a lit window, a screen, a sign at night) stay bright however far back they are
      back *= 1.0 - smoothstep(0.55, 1.1, max(col.r, max(col.g, col.b)));
      col.rgb = mix(col.rgb, col.rgb * vec3(0.5, 0.47, 0.6), back);
    }
    // a hard step: an edge or not (a soft ramp leaves faint lines around everything, which looks blurred)
    float e = step(threshold, jump(vUv));
    // nothing drawn there (the background): no line
    if (texture2D(tDepth, vUv).x >= 1.0) e = 0.0;
    gl_FragColor = vec4(mix(col.rgb, ink, e * strength), col.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // the grade (on screen colours): warm, a little contrast and colour, shadows brown not grey, a soft vignette
    vec3 c = gl_FragColor.rgb * warmth;
    c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, saturation);
    // split toning after the palette: the dark end towards its deep purple and lavender (#46334F, #8082A6), the light
    // end towards its orange and yellow (#F2921D, #F2C230); the middle stays as it is
    float sh = 1.0 - smoothstep(0.0, 0.55, l);
    float hi = smoothstep(0.45, 1.0, l);
    c = mix(c, c * vec3(0.86, 0.8, 1.08) + vec3(0.035, 0.012, 0.06), sh * shadowWarmth);
    c = mix(c, c * vec3(1.1, 0.98, 0.78) + vec3(0.02, 0.008, 0.0), hi * highlight);
    vec2 d = vUv - 0.5;
    c *= 1.0 - dot(d, d) * vignette;
    gl_FragColor.rgb = clamp(c, 0.0, 1.0);
  }
`

export function Outline() {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)

  // smoothing (multisampling) only where pixels are big enough to need it: on a sharp (2×) screen it costs a lot for
  // nothing, and a slow frame makes the office drop its resolution (scene/quality.ts), which blurs everything
  const smooth = dpr < 1.75
  const target = useMemo(() => {
    const t = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: smooth ? 4 : 0 })
    t.depthTexture = new DepthTexture(1, 1, UnsignedIntType)
    return t
  }, [smooth])
  const pass = useMemo(() => {
    const material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        tColor: { value: target.texture },
        tDepth: { value: target.depthTexture },
        texel: { value: new Vector2() },
        near: { value: 0 },
        far: { value: 1 },
        threshold: { value: THRESHOLD },
        ink: { value: INK },
        strength: { value: STRENGTH },
        focus: { value: 0 },
        recede: { value: RECEDE.amount },
        recedeFrom: { value: RECEDE.from },
        recedeTo: { value: RECEDE.to },
        warmth: { value: GRADE.warmth },
        contrast: { value: GRADE.contrast },
        saturation: { value: GRADE.saturation },
        shadowWarmth: { value: GRADE.shadowWarmth },
        highlight: { value: GRADE.highlight },
        vignette: { value: GRADE.vignette },
      },
      depthTest: false,
      depthWrite: false,
    })
    const scene = new Scene()
    scene.add(new Mesh(new PlaneGeometry(2, 2), material))
    return { scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), material }
  }, [target])

  useEffect(() => {
    // a new target (smoothing switched) starts at 1×1: sized here too
    const w = Math.max(1, Math.round(size.width * dpr))
    const h = Math.max(1, Math.round(size.height * dpr))
    target.setSize(w, h)
    pass.material.uniforms.texel.value.set(1 / w, 1 / h)
  }, [size.width, size.height, dpr, target, pass])

  useEffect(
    () => () => {
      target.dispose()
      pass.material.dispose()
    },
    [target, pass],
  )

  // priority 1: this draws the frame (R3F stops drawing on its own)
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3 } | null
  useFrame(({ scene, camera }) => {
    const cam = camera as OrthoCam
    const u = pass.material.uniforms
    // how far along the view what the camera looks at is (the office): the darkening starts beyond it
    u.focus.value = controls ? camera.position.distanceTo(controls.target) : 30
    u.near.value = cam.near
    u.far.value = cam.far
    // 0 far away → 1 close up
    const k = MathUtils.smoothstep(cam.zoom, FAR_ZOOM, NEAR_ZOOM)
    u.threshold.value = THRESHOLD * MathUtils.lerp(FAR_THRESHOLD, 1, k)
    gl.setRenderTarget(target)
    gl.render(scene, camera)
    gl.setRenderTarget(null)
    gl.render(pass.scene, pass.camera)
  }, 1)

  return null
}
