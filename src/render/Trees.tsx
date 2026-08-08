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
import { DETAIL, FLORA, createForestMask, forestAmount, type DetailKind } from '../sim/flora'
import type { Noise2D } from '../sim/noise'
import { mulberry32 } from '../sim/rng'
import { sampleGradient, sampleHeight, smoothstep, clamp01 } from '../sim/terrain'
import type { Palette, Rgb } from '../sim/palette'

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
/** The understory is sparser than the forest and cheaper to lose. */
const MAX_DETAIL = 1400

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
 * Three species share one scatter pass and render as one instanced draw call each:
 * two trees plus the biome's understory, which is placed by its own rules — see
 * DETAIL in `flora.ts` — so it lands on the bare ground the forest mask excludes.
 */
export function Trees({ world }: { world: World }) {
  const camera = useThree((s) => s.camera)

  const built = useMemo(() => {
    const pal = world.palette
    const trunkTint = 0.42

    const conifer = coniferGeometry(trunkTint)
    const broadleaf = broadleafGeometry(trunkTint)
    const detailKind = DETAIL[world.biome].kind

    // Canopy colours come off the day's own palette so the forest belongs to the
    // landscape instead of sitting on top of it as generic green.
    const canopy: Rgb[] = [
      scale(pal.low, 0.72),
      scale(pal.low, 0.9),
      scale(pal.mid, 0.8),
      mix(pal.low, pal.mid, 0.5),
    ]
    const accent = mix(pal.sun, pal.low, 0.55)

    const make = (geo: BufferGeometry, cap: number) => {
      const mat = new MeshLambertMaterial({ vertexColors: true })
      const mesh = new InstancedMesh(geo, mat, cap)
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3)
      mesh.frustumCulled = false
      mesh.count = 0
      return mesh
    }

    return {
      coniferMesh: make(conifer, MAX_PER_SPECIES),
      broadleafMesh: make(broadleaf, MAX_PER_SPECIES),
      detailMesh: make(detailGeometry(detailKind, trunkTint), MAX_DETAIL),
      detailPalette: detailColours(detailKind, pal),
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
      <primitive object={built.detailMesh} />
    </>
  )
}

interface Built {
  coniferMesh: InstancedMesh
  broadleafMesh: InstancedMesh
  detailMesh: InstancedMesh
  detailPalette: Rgb[]
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
  const detail = DETAIL[world.biome]
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
  let nDetail = 0

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

      // The understory runs off the same cell stream, after the trees, so the
      // whole cell is still one deterministic sequence.
      for (let k = 0; k < detail.density; k++) {
        const x = (cix + rng()) * CELL
        const z = (ciz + rng()) * CELL
        const rot = rng() * Math.PI * 2
        const sizeRoll = rng()
        const tintRoll = rng()
        const forestRoll = rng()

        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > r2 || nDetail >= MAX_DETAIL) continue

        const h = sampleHeight(hf, x, z)
        if (h < waterY) continue
        const band = (h - hf.min) / range
        if (band < detail.band[0] || band > detail.band[1]) continue
        if (detail.shore > 0 && (!hf.hasWater || h > hf.waterLevel + detail.shore)) continue

        sampleGradient(hf, x, z, GRAD)
        const slope = Math.hypot(GRAD.x, GRAD.z)
        if (slope < detail.slope[0] || slope > detail.slope[1]) continue

        // Thinned rather than excluded under canopy: a boulder in a wood is fine,
        // a boulder field in a wood is not.
        if (detail.inForest < 1) {
          const cover = forestAmount(built.mask, spec, hf, h, slope, x, z)
          if (cover > 0 && forestRoll > detail.inForest) continue
        }

        const edge = 1 - smoothstep(RADIUS * 0.8, RADIUS, Math.sqrt(d2))
        if (edge <= 0.02) continue

        const height = (detail.height[0] + sizeRoll * (detail.height[1] - detail.height[0])) * edge
        // Boulders sit in the ground rather than on it, and they are not upright.
        const rock = detail.kind === 'boulder'
        const width = height * (rock ? 1.1 + tintRoll * 0.5 : 0.7 + tintRoll * 0.3)

        POS.set(x, rock ? h - height * 0.28 : h, z)
        QUAT.setFromAxisAngle(UP, rot)
        SCALE.set(width, height, width * (rock ? 0.85 + sizeRoll * 0.4 : 1))
        MATRIX.compose(POS, QUAT, SCALE)
        built.detailMesh.setMatrixAt(nDetail, MATRIX)

        const base = built.detailPalette[Math.floor(tintRoll * built.detailPalette.length) % built.detailPalette.length]
        const v = 0.84 + sizeRoll * 0.3
        COLOR.setRGB(clamp01(base[0] * v), clamp01(base[1] * v), clamp01(base[2] * v))
        built.detailMesh.setColorAt(nDetail, COLOR)
        nDetail++
      }
    }
  }

  built.coniferMesh.count = nConifer
  built.broadleafMesh.count = nBroadleaf
  built.detailMesh.count = nDetail
  built.coniferMesh.instanceMatrix.needsUpdate = true
  built.broadleafMesh.instanceMatrix.needsUpdate = true
  built.detailMesh.instanceMatrix.needsUpdate = true
  if (built.coniferMesh.instanceColor) built.coniferMesh.instanceColor.needsUpdate = true
  if (built.broadleafMesh.instanceColor) built.broadleafMesh.instanceColor.needsUpdate = true
  if (built.detailMesh.instanceColor) built.detailMesh.instanceColor.needsUpdate = true
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

/**
 * The understory, one shape per biome. Same contract as the trees: unit height,
 * base at y = 0, vertex colour as a brightness mask that the instance colour
 * multiplies through.
 */
function detailGeometry(kind: DetailKind, trunkTint: number): BufferGeometry {
  switch (kind) {
    case 'boulder': {
      // Two lumps at low subdivision. Flat-shaded facets are the point — a smooth
      // boulder reads as a beach ball, a faceted one reads as broken rock.
      const a = new IcosahedronGeometry(0.5, 0)
      const b = new IcosahedronGeometry(0.3, 0)
      return merge([
        { geo: translated(scaled(a, 1.05, 0.78, 0.92), 0, 0.42, 0), tint: 1.0 },
        { geo: translated(scaled(b, 0.9, 0.7, 1.1), 0.3, 0.24, 0.16), tint: 0.82 },
      ])
    }
    case 'cactus': {
      const arm = (x: number, y: number, tilt: number) =>
        translated(rotatedZ(new CylinderGeometry(0.09, 0.1, 0.42, 6), tilt), x, y, 0)
      return merge([
        { geo: translated(new CylinderGeometry(0.13, 0.16, 1.0, 7), 0, 0.5, 0), tint: 1.0 },
        { geo: arm(-0.17, 0.52, 0.9), tint: 0.9 },
        { geo: translated(new CylinderGeometry(0.08, 0.09, 0.3, 6), -0.3, 0.72, 0), tint: 0.9 },
        { geo: arm(0.16, 0.36, -0.9), tint: 0.86 },
        { geo: translated(new CylinderGeometry(0.07, 0.08, 0.26, 6), 0.29, 0.55, 0), tint: 0.86 },
      ])
    }
    case 'palm': {
      // Fronds are flattened cones splayed off the crown. Six is enough to read as
      // a palm in silhouette, which is all it ever is from the air.
      const parts: Array<{ geo: BufferGeometry; tint: number }> = [
        { geo: translated(new CylinderGeometry(0.035, 0.06, 0.86, 5), 0, 0.43, 0), tint: trunkTint },
      ]
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const frond = scaled(new ConeGeometry(0.11, 0.62, 4), 1, 1, 0.28)
        parts.push({
          geo: translated(
            rotatedY(rotatedZ(frond, Math.PI * 0.42), a),
            Math.cos(a) * 0.26,
            0.84,
            Math.sin(a) * 0.26,
          ),
          tint: i % 2 === 0 ? 1.0 : 0.86,
        })
      }
      return merge(parts)
    }
    case 'shrub': {
      const a = new IcosahedronGeometry(0.42, 0)
      const b = new IcosahedronGeometry(0.3, 0)
      return merge([
        { geo: translated(scaled(a, 1.1, 0.8, 1.1), 0, 0.36, 0), tint: 0.9 },
        { geo: translated(scaled(b, 1, 0.85, 1), 0.22, 0.6, -0.12), tint: 1.0 },
      ])
    }
    case 'spire': {
      // Six sides, because cooling basalt cracks into hexagons, and a slight lean
      // so a stand of them is not a bar chart.
      return merge([
        { geo: translated(rotatedZ(new CylinderGeometry(0.17, 0.26, 1.0, 6), 0.06), 0, 0.5, 0), tint: 1.0 },
        { geo: translated(rotatedZ(new CylinderGeometry(0.12, 0.2, 0.62, 6), -0.1), 0.26, 0.31, 0.1), tint: 0.78 },
      ])
    }
    case 'bale': {
      // A drum on its side. The darker end caps are what read as "bale" rather
      // than "log" — that is where the spiral of the wrap shows on a real one.
      const drum = rotatedX(new CylinderGeometry(0.5, 0.5, 0.88, 10), Math.PI / 2)
      const cap = (z: number) => translated(rotatedX(new CylinderGeometry(0.44, 0.44, 0.05, 10), Math.PI / 2), 0, 0.5, z)
      return merge([
        { geo: translated(drum, 0, 0.5, 0), tint: 1.0 },
        { geo: cap(0.45), tint: 0.68 },
        { geo: cap(-0.45), tint: 0.68 },
      ])
    }
  }
}

/**
 * Understory colour, off the day's palette like everything else. Rock takes the
 * terrain's own rock and mineral bands so a boulder belongs to the slope it is
 * lying on; the living species take a drier, paler green than the canopy, because
 * scrub in strong light is never the colour of a tree crown.
 */
function detailColours(kind: DetailKind, pal: Palette): Rgb[] {
  switch (kind) {
    case 'boulder':
    case 'spire':
      return [scale(pal.rock, 0.92), scale(pal.rock, 1.12), mix(pal.rock, pal.mineral, 0.55), scale(pal.mineral, 0.9)]
    case 'cactus':
      return [mix(pal.mid, pal.low, 0.3), scale(pal.mid, 0.86), mix(pal.mid, pal.bloom, 0.16)]
    case 'palm':
      return [scale(pal.mid, 0.8), mix(pal.mid, pal.low, 0.35), scale(pal.mid, 0.62)]
    case 'shrub':
      return [scale(pal.low, 0.8), mix(pal.low, pal.mid, 0.5), mix(pal.mid, pal.bloom, 0.22)]
    case 'bale':
      // Cut hay is the sun's colour, not the grass's — a bale is dried light.
      return [mix(pal.sun, pal.mid, 0.4), mix(pal.sun, pal.mid, 0.58), scale(mix(pal.sun, pal.mid, 0.45), 0.86)]
  }
}

export const translated = (g: BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z)
export const rotatedX = (g: BufferGeometry, a: number) => g.rotateX(a)
export const rotatedZ = (g: BufferGeometry, a: number) => g.rotateZ(a)
export const rotatedY = (g: BufferGeometry, a: number) => g.rotateY(a)
export const scaled = (g: BufferGeometry, x: number, y: number, z: number) => g.scale(x, y, z)

/**
 * Minimal geometry merge. Written here rather than pulled from
 * three/examples/jsm/utils/BufferGeometryUtils so the bundle stays one import
 * lighter — all it has to handle is a handful of primitives with a flat tint.
 * Exported for the herds, which build their animals on the same contract.
 */
export function merge(parts: Array<{ geo: BufferGeometry; tint: number }>): BufferGeometry {
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

export const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
