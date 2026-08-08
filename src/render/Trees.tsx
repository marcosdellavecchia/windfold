import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import { FLORA, createForestMask, forestAmount } from '../sim/flora'
import type { Noise2D } from '../sim/noise'
import { mulberry32 } from '../sim/rng'
import { sampleGradient, sampleHeight, smoothstep, clamp01 } from '../sim/terrain'
import type { Rgb } from '../sim/palette'

/** Scatter cell size, metres. */
const CELL = 384
/**
 * How far from the camera trees are placed. Sized against FOG_LIMIT so the boundary
 * sits where the haze is already almost total — and trees shrink to nothing over the
 * last fifth of it, so the ones being recycled are never seen appearing.
 */
const RADIUS = 3400
/** Rescatter once the camera has moved this far from the last scatter centre. */
const REDRAW_AT = CELL * 0.6
/**
 * Per-species instance ceiling. The densest biome can propose more trees than this;
 * the surplus is dropped, which shows up as slightly thinner forest on valley days
 * rather than as anything visible at the edge of view.
 */
const MAX_PER_SPECIES = 3000

/**
 * Trees, streamed around the camera.
 *
 * A 12 km map cannot be populated up front — that would be hundreds of thousands of
 * instances. Instead placement is a pure function of the scatter cell a tree falls
 * in, so the same coordinates always grow the same tree, and the visible set can be
 * rebuilt from scratch whenever the camera moves a couple of hundred metres. Trees
 * that stay in range keep their exact transform across a rebuild; only ones out at
 * the fog limit get recycled, so there is nothing to see.
 *
 * Two species share one scatter pass and render as one instanced draw call each.
 */
export function Trees({ world }: { world: World }) {
  const camera = useThree((s) => s.camera)

  const built = useMemo(() => {
    const pal = world.palette
    const trunkTint = 0.42

    const conifer = coniferGeometry(trunkTint)
    const broadleaf = broadleafGeometry(trunkTint)

    // Canopy colours come off the day's own palette so the forest belongs to the
    // landscape instead of sitting on top of it as generic green.
    const canopy: Rgb[] = [
      scale(pal.low, 0.72),
      scale(pal.low, 0.9),
      scale(pal.mid, 0.8),
      mix(pal.low, pal.mid, 0.5),
    ]
    const accent = mix(pal.sun, pal.low, 0.55)

    const make = (geo: BufferGeometry) => {
      const mat = new MeshLambertMaterial({ vertexColors: true })
      const mesh = new InstancedMesh(geo, mat, MAX_PER_SPECIES)
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_PER_SPECIES * 3), 3)
      mesh.frustumCulled = false
      mesh.count = 0
      return mesh
    }

    return {
      coniferMesh: make(conifer),
      broadleafMesh: make(broadleaf),
      canopy,
      accent,
      // Shared with the terrain's own forest tint, so trees only ever stand on
      // ground that already looks wooded.
      mask: createForestMask(world.seed),
    }
  }, [world])

  const last = useRef(new Vector3(1e9, 0, 1e9))

  useFrame(() => {
    const p = camera.position
    if (last.current.distanceTo(p) < REDRAW_AT) return
    last.current.copy(p)
    scatter(world, built, p.x, p.z)
  })

  return (
    <>
      <primitive object={built.coniferMesh} />
      <primitive object={built.broadleafMesh} />
    </>
  )
}

interface Built {
  coniferMesh: InstancedMesh
  broadleafMesh: InstancedMesh
  canopy: Rgb[]
  accent: Rgb
  mask: Noise2D
}

const MATRIX = new Matrix4()
const POS = new Vector3()
const QUAT = new Quaternion()
const SCALE = new Vector3()
const UP = new Vector3(0, 1, 0)
const COLOR = new Color()
const GRAD = { x: 0, z: 0 }

function scatter(world: World, built: Built, cx: number, cz: number) {
  const hf = world.heightfield
  const spec = FLORA[world.biome]
  const range = Math.max(hf.max - hf.min, 1)
  const treelineY = hf.min + range * spec.treeline
  const floorY = hf.min + range * spec.floor // cheap pre-filter before forestAmount
  const waterY = hf.hasWater ? hf.waterLevel + 6 : -Infinity

  const cell0x = Math.floor((cx - RADIUS) / CELL)
  const cell1x = Math.floor((cx + RADIUS) / CELL)
  const cell0z = Math.floor((cz - RADIUS) / CELL)
  const cell1z = Math.floor((cz + RADIUS) / CELL)
  const r2 = RADIUS * RADIUS

  let nConifer = 0
  let nBroadleaf = 0

  for (let ciz = cell0z; ciz <= cell1z; ciz++) {
    for (let cix = cell0x; cix <= cell1x; cix++) {
      // Position is a pure function of the cell, so rebuilding is stable.
      const rng = mulberry32(cellSeed(cix, ciz, world.seed))

      for (let k = 0; k < spec.density; k++) {
        const x = (cix + rng()) * CELL
        const z = (ciz + rng()) * CELL
        const rot = rng() * Math.PI * 2
        const sizeRoll = rng()
        const speciesRoll = rng()
        const colourRoll = rng()
        const accentRoll = rng()
        const maskRoll = rng()

        // Filters are ordered cheapest-first: this runs a few thousand times per
        // rescatter, and the gradient alone costs four height samples.
        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue

        const h = sampleHeight(hf, x, z)
        if (h > treelineY || h < floorY || h < waterY) continue

        sampleGradient(hf, x, z, GRAD)
        const slope = Math.hypot(GRAD.x, GRAD.z)
        if (slope > spec.maxSlope) continue

        if (maskRoll > forestAmount(built.mask, spec, hf, h, slope, x, z)) continue

        const broad = speciesRoll < spec.broadleaf
        const mesh = broad ? built.broadleafMesh : built.coniferMesh
        const index = broad ? nBroadleaf : nConifer
        if (index >= MAX_PER_SPECIES) continue

        // Shrink to nothing at the scatter boundary, so recycling is invisible.
        const edge = 1 - smoothstep(RADIUS * 0.8, RADIUS, Math.sqrt(d2))
        if (edge <= 0.02) continue

        const height = (spec.height[0] + sizeRoll * (spec.height[1] - spec.height[0])) * edge
        const width = height * (broad ? 0.62 : 0.44) * (0.85 + colourRoll * 0.3)

        POS.set(x, h, z)
        QUAT.setFromAxisAngle(UP, rot)
        SCALE.set(width, height, width)
        MATRIX.compose(POS, QUAT, SCALE)
        mesh.setMatrixAt(index, MATRIX)

        const base =
          accentRoll < spec.accent
            ? built.accent
            : built.canopy[Math.floor(colourRoll * built.canopy.length) % built.canopy.length]
        const v = 0.82 + sizeRoll * 0.34
        COLOR.setRGB(clamp01(base[0] * v), clamp01(base[1] * v), clamp01(base[2] * v))
        mesh.setColorAt(index, COLOR)

        if (broad) nBroadleaf++
        else nConifer++
      }
    }
  }

  built.coniferMesh.count = nConifer
  built.broadleafMesh.count = nBroadleaf
  built.coniferMesh.instanceMatrix.needsUpdate = true
  built.broadleafMesh.instanceMatrix.needsUpdate = true
  if (built.coniferMesh.instanceColor) built.coniferMesh.instanceColor.needsUpdate = true
  if (built.broadleafMesh.instanceColor) built.broadleafMesh.instanceColor.needsUpdate = true
}

/** Cheap 2D integer hash. Distinct cells must not share a stream. */
function cellSeed(x: number, z: number, seed: number): number {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + seed
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/* -------------------------------------------------------------- geometry ---- */

/**
 * Both species are built to unit height with their base at y = 0, so the instance
 * matrix can set real dimensions. Vertex colour is a brightness mask, not a hue:
 * 1.0 on the canopy, dark at the trunk. The per-instance colour then multiplies
 * through, which gives every tree a trunk in its own shade for free.
 */
function coniferGeometry(trunkTint: number): BufferGeometry {
  const parts: Array<{ geo: BufferGeometry; tint: number }> = [
    { geo: translated(new CylinderGeometry(0.07, 0.1, 0.3, 5), 0, 0.15, 0), tint: trunkTint },
    { geo: translated(new ConeGeometry(0.5, 0.46, 7), 0, 0.4, 0), tint: 0.78 },
    { geo: translated(new ConeGeometry(0.38, 0.42, 7), 0, 0.63, 0), tint: 0.92 },
    { geo: translated(new ConeGeometry(0.24, 0.36, 7), 0, 0.84, 0), tint: 1.0 },
  ]
  return merge(parts)
}

function broadleafGeometry(trunkTint: number): BufferGeometry {
  const canopy = new IcosahedronGeometry(0.5, 0)
  const canopy2 = new IcosahedronGeometry(0.34, 0)
  const parts: Array<{ geo: BufferGeometry; tint: number }> = [
    { geo: translated(new CylinderGeometry(0.06, 0.09, 0.44, 5), 0, 0.22, 0), tint: trunkTint },
    { geo: translated(scaled(canopy, 1, 0.82, 1), 0, 0.66, 0), tint: 0.95 },
    { geo: translated(scaled(canopy2, 1, 0.8, 1), 0.14, 0.9, -0.1), tint: 1.0 },
  ]
  return merge(parts)
}

const translated = (g: BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z)
const scaled = (g: BufferGeometry, x: number, y: number, z: number) => g.scale(x, y, z)

/**
 * Minimal geometry merge. Written here rather than pulled from
 * three/examples/jsm/utils/BufferGeometryUtils so the bundle stays one import
 * lighter — all it has to handle is a handful of primitives with a flat tint.
 */
function merge(parts: Array<{ geo: BufferGeometry; tint: number }>): BufferGeometry {
  const flat = parts.map((p) => ({ geo: p.geo.toNonIndexed(), tint: p.tint }))
  let total = 0
  for (const p of flat) total += p.geo.attributes.position.count

  const position = new Float32Array(total * 3)
  const normal = new Float32Array(total * 3)
  const color = new Float32Array(total * 3)

  let at = 0
  for (const p of flat) {
    const pos = p.geo.attributes.position.array as Float32Array
    const nrm = p.geo.attributes.normal.array as Float32Array
    const n = p.geo.attributes.position.count
    position.set(pos, at * 3)
    normal.set(nrm, at * 3)
    for (let i = 0; i < n; i++) {
      color[(at + i) * 3] = p.tint
      color[(at + i) * 3 + 1] = p.tint
      color[(at + i) * 3 + 2] = p.tint
    }
    at += n
    p.geo.dispose()
  }

  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(position, 3))
  out.setAttribute('normal', new BufferAttribute(normal, 3))
  out.setAttribute('color', new BufferAttribute(color, 3))
  return out
}

const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
