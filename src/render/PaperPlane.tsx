import { forwardRef, useMemo, useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, MeshLambertMaterial, Vector3 } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { cloudShadowSeed } from './atmosphere'

/**
 * A folded dart, procedural like everything else — the "ship no 3D model
 * files" rule applies to the plane too.
 *
 * It is the one object on screen every single frame, dead centre, so it gets
 * three touches nothing else does. Real fold structure: each panel is its own
 * facet with its own tint, so the creases catch the light the way folded
 * paper does, and the two sides are deliberately not quite symmetric —
 * somebody folded this. Sunlight transmits through it: when a wing comes
 * between the eye and a low sun, the panel glows warm, which is the single
 * most paper thing paper does. And it dims under the cloud shadows, in sync
 * with the ground below, via the same field the terrain and water share.
 */
export const PaperPlane = forwardRef<Group, { world: World }>(function PaperPlane({ world }, ref) {
  const camera = useThree((s) => s.camera)
  const geometry = useMemo(() => buildDart(), [])

  const material = useMemo(() => {
    const mat = new MeshLambertMaterial({
      color: 0xfffdf6,
      emissive: rgbToHex(world.palette.high),
      emissiveIntensity: 0.3,
      side: DoubleSide,
      flatShading: true,
      vertexColors: true,
    })
    const uSunView = { value: new Vector3() }
    const uSunCol = { value: new Color(rgbToHex(world.palette.sun)) }
    mat.userData.uSunView = uSunView
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunView = uSunView
      shader.uniforms.uSunCol = uSunCol
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 uSunView;\nuniform vec3 uSunCol;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            // Sun through the paper. Backlit when the sun is on the far side
            // of the sheet from the eye; focused when the eye is looking
            // roughly through the sheet toward the sun. Both in view space,
            // where the fragment's facing normal already lives.
            vec3 V = normalize(vViewPosition);
            float backlit = clamp(dot(normal, -uSunView), 0.0, 1.0);
            float focus = pow(clamp(dot(-V, uSunView), 0.0, 1.0), 3.0);
            totalEmissiveRadiance += uSunCol * backlit * (0.25 + 0.75 * focus) * 0.6;
          }`,
        )
    }
    return mat
  }, [world])

  // Cloud shade, sampled CPU-side from the same field the shaders use, so the
  // plane darkens exactly when the ground under it does.
  const shade = useRef({ t: 0, wind: [world.air.windX, world.air.windZ], seed: cloudShadowSeed(world.seed) })
  useMemo(() => {
    shade.current = { t: 0, wind: [world.air.windX, world.air.windZ], seed: cloudShadowSeed(world.seed) }
  }, [world])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const s = shade.current
    s.t += dt

    // Sun direction into view space for the transmission term.
    ;(material.userData.uSunView.value as Vector3)
      .copy(world.sunDir)
      .transformDirection(camera.matrixWorldInverse)

    const g = (ref as RefObject<Group | null>)?.current
    if (g) {
      const f = cloudShadowTS(g.position.x, g.position.z, s.wind[0], s.wind[1], s.t, s.seed)
      material.color.copy(PAPER).multiplyScalar(f)
    }
  })

  return (
    <group ref={ref}>
      <mesh geometry={geometry} material={material} />
    </group>
  )
})

const PAPER = new Color(0xfffdf6)

/** TypeScript twin of atmosphere.ts's cloudShadow — keep the constants matched. */
function cloudShadowTS(x: number, z: number, wx: number, wz: number, t: number, seed: number): number {
  const px = (x - wx * t * 1.6) / 950 + seed
  const pz = (z - wz * t * 1.6) / 950 + seed
  const n = csNoise(px, pz) * 0.65 + csNoise(px * 2.7 + 13.1, pz * 2.7 + 13.1) * 0.35
  const s = Math.min(Math.max((n - 0.52) / (0.8 - 0.52), 0), 1)
  return 1 - s * s * (3 - 2 * s) * 0.16
}

function csHash(x: number, z: number): number {
  let px = (x * 123.34) % 1
  let pz = (z * 456.21) % 1
  if (px < 0) px += 1
  if (pz < 0) pz += 1
  const d = px * (px + 45.32) + pz * (pz + 45.32)
  px += d
  pz += d
  return ((px * pz) % 1 + 1) % 1
}

function csNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  let fx = x - ix
  let fz = z - iz
  fx = fx * fx * (3 - 2 * fx)
  fz = fz * fz * (3 - 2 * fz)
  const a = csHash(ix, iz)
  const b = csHash(ix + 1, iz)
  const c = csHash(ix, iz + 1)
  const d = csHash(ix + 1, iz + 1)
  return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fz
}

/**
 * The dart. Each panel is a separate facet with its own vertex tint — flat
 * shading plus per-panel brightness is what makes the folds read as folds.
 * The left and right panels differ by a few percent on purpose: a perfectly
 * symmetric fold never came off anyone's desk.
 */
function buildDart(): BufferGeometry {
  // Nose at -Z, tail at +Z. Wingspan ~3.4 m.
  const nose = [0, 0, -2.4]
  const spine = [0, 0.26, 1.5]
  const tipL = [-1.7, 0.14, 1.85]
  const tipR = [1.7, 0.12, 1.85]
  const foldL = [-0.44, 0.18, 1.68]
  const foldR = [0.44, 0.18, 1.68]
  const keel = [0, -0.58, 1.55]
  const keelMid = [0, -0.3, -0.6]

  const panels: Array<{ tris: number[][][]; tint: number }> = [
    // Outer wing panels — the broad lit surfaces.
    { tris: [[nose, tipL, foldL]], tint: 1.0 },
    { tris: [[nose, foldR, tipR]], tint: 0.97 },
    // Inner panels rising to the spine — always a shade darker than the
    // outer, because the fold turns them away from the sky.
    { tris: [[nose, foldL, spine]], tint: 0.9 },
    { tris: [[nose, spine, foldR]], tint: 0.86 },
    // The keel, folded under: two facets, darkest of all.
    { tris: [[nose, keelMid, spine], [keelMid, keel, spine]], tint: 0.72 },
  ]

  const tris: number[][][] = []
  const tints: number[] = []
  for (const p of panels) {
    for (const t of p.tris) {
      tris.push(t)
      tints.push(p.tint)
    }
  }

  const positions = new Float32Array(tris.length * 9)
  const colors = new Float32Array(tris.length * 9)
  for (let i = 0; i < tris.length; i++) {
    for (let v = 0; v < 3; v++) {
      positions[i * 9 + v * 3] = tris[i][v][0]
      positions[i * 9 + v * 3 + 1] = tris[i][v][1]
      positions[i * 9 + v * 3 + 2] = tris[i][v][2]
      colors[i * 9 + v * 3] = tints[i]
      colors[i * 9 + v * 3 + 1] = tints[i]
      colors[i * 9 + v * 3 + 2] = tints[i]
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setAttribute('color', new BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  return geo
}
