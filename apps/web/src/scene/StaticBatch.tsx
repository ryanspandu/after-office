import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, type Material, type Object3D } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Draw-call reducer for the static parts of the office. The scene is built from hundreds of small boxes (a desk is
// ~10 meshes), and every mesh is its own draw call, twice with shadows. After the children render, StaticBatch bakes
// the static meshes into a handful of merged meshes and hides the originals; the React tree stays as it is. When
// `version` changes (e.g. an agent sat down and a chair or LED changed colour) it rebuilds.
//
// Plain coloured materials (no texture, no glow) are merged regardless of colour: the colour moves into a per-vertex
// attribute, so a whole room of differently coloured boxes becomes one mesh per roughness/shadow combination.
// Other materials (glowing, textured, animated) are merged per identical material.
//
// Not merged: anything under an object with `userData.dynamic` (animated parts, materials changed per frame),
// transparent materials (they need per-object sorting), and meshes without a plain single material.

interface Bucket {
  material: Material
  /** we created the material (vertex-colour buckets) and must dispose it */
  owned: boolean
  cast: boolean
  receive: boolean
  parts: BufferGeometry[]
  sources: Mesh[]
}

function plainColour(m: Material): m is MeshStandardMaterial {
  const s = m as MeshStandardMaterial
  return (
    s.isMeshStandardMaterial &&
    !m.userData.live &&
    !s.map &&
    !s.vertexColors &&
    (s.emissiveIntensity === 0 || s.emissive.getHex() === 0)
  )
}

function keyFor(m: Material, cast: boolean, receive: boolean) {
  const flags = `${cast}|${receive}|${m.side}|${m.toneMapped}`
  if (plainColour(m)) return `vc|${m.roughness}|${m.metalness}|${flags}`
  // materials animated globally (lamp bulbs, window glass) are shared instances: keep them by identity
  if (m.userData.live) return `live:${m.uuid}|${flags}`
  const s = m as MeshStandardMaterial
  return [m.type, s.color?.getHexString(), s.emissive?.getHexString(), s.emissiveIntensity, s.roughness, s.metalness, s.map?.uuid ?? '', flags].join('|')
}

function collect(obj: Object3D, out: Mesh[]) {
  if (obj.userData.dynamic) return
  const mesh = obj as Mesh
  if (mesh.isMesh && !(mesh as { isInstancedMesh?: boolean }).isInstancedMesh && !Array.isArray(mesh.material)) {
    const m = mesh.material as Material
    if (!m.transparent && mesh.visible) out.push(mesh)
  }
  for (const c of obj.children) collect(c, out)
}

/** World-baked, non-indexed copy with position + normal (+ uv for textured, + colour for vertex-colour buckets). */
function prepare(mesh: Mesh, toLocal: Matrix4, colour: MeshStandardMaterial | null) {
  const src = mesh.geometry
  if (!src.attributes.position || !src.attributes.normal) return null
  const keepUv = !!(mesh.material as MeshStandardMaterial).map && !!src.attributes.uv
  const g = src.index ? src.toNonIndexed() : src.clone()
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && !(keepUv && name === 'uv')) g.deleteAttribute(name)
  g.applyMatrix4(new Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld))
  if (colour) {
    const n = g.attributes.position.count
    const c = new Float32Array(n * 3)
    const { r, g: gg, b } = colour.color
    for (let i = 0; i < n; i++) {
      c[i * 3] = r
      c[i * 3 + 1] = gg
      c[i * 3 + 2] = b
    }
    g.setAttribute('color', new BufferAttribute(c, 3))
  }
  return g
}

export function StaticBatch({ children, version }: { children: ReactNode; version?: unknown }) {
  const root = useRef<Group>(null)

  useLayoutEffect(() => {
    const group = root.current
    if (!group) return
    group.updateMatrixWorld(true)
    const toLocal = new Matrix4().copy(group.matrixWorld).invert()

    const meshes: Mesh[] = []
    for (const c of group.children) collect(c, meshes)

    const buckets = new Map<string, Bucket>()
    for (const mesh of meshes) {
      const material = mesh.material as Material
      const plain = plainColour(material)
      const key = keyFor(material, mesh.castShadow, mesh.receiveShadow)
      const g = prepare(mesh, toLocal, plain ? material : null)
      if (!g) continue
      let b = buckets.get(key)
      if (!b) {
        const shared = plain
          ? new MeshStandardMaterial({ vertexColors: true, roughness: material.roughness, metalness: material.metalness, side: material.side })
          : material
        if (plain) shared.toneMapped = material.toneMapped
        buckets.set(key, (b = { material: shared, owned: plain, cast: mesh.castShadow, receive: mesh.receiveShadow, parts: [], sources: [] }))
      }
      b.parts.push(g)
      b.sources.push(mesh)
    }

    const merged: Mesh[] = []
    const hidden: Mesh[] = []
    const owned: Material[] = []
    for (const b of buckets.values()) {
      if (b.parts.length < 2) {
        b.parts.forEach((g) => g.dispose())
        if (b.owned) b.material.dispose()
        continue // nothing to gain
      }
      const geometry = mergeGeometries(b.parts, false)
      b.parts.forEach((g) => g.dispose())
      if (!geometry) {
        if (b.owned) b.material.dispose()
        continue
      }
      const mesh = new Mesh(geometry, b.material)
      mesh.castShadow = b.cast
      mesh.receiveShadow = b.receive
      mesh.userData.batched = true
      mesh.raycast = () => {} // the batch is never a click target
      group.add(mesh)
      merged.push(mesh)
      if (b.owned) owned.push(b.material)
      for (const s of b.sources) {
        s.visible = false
        hidden.push(s)
      }
    }

    return () => {
      for (const m of merged) {
        group.remove(m)
        m.geometry.dispose()
      }
      owned.forEach((m) => m.dispose())
      for (const s of hidden) s.visible = true
    }
  }, [version])

  return <group ref={root}>{children}</group>
}
