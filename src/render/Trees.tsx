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
import {
  DETAIL,
  DETAIL2,
  FLORA,
  createForestMask,
  createGroveMask,
  createRockMask,
  forestAmount,
  forestDay,
  groveAmount,
  rockAmount,
  type DetailKind,
  type ForestDay,
} from '../sim/flora'
import type { Noise2D } from '../sim/noise'
import { mulberry32 } from '../sim/rng'
import { sampleGradient, sampleHeight, sampleWet, smoothstep, clamp01 } from '../sim/terrain'
import type { Palette, Rgb } from '../sim/palette'
import { patchAirFog } from './atmosphere'

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
/** The water-edge species live on narrow ribbons; they never need many. */
const MAX_DETAIL2 = 900
/** Drainage above which the ground is the watercourse rather than its bank. */
const BANK_MAX = 0.82

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
    const details = DETAIL[world.biome]
    const spec2 = DETAIL2[world.biome]
    const day = forestDay(world.seed)

    // Canopy colours come off the day's own palette so the forest belongs to the
    // landscape instead of sitting on top of it as generic green.
    let canopy: Rgb[] = [
      scale(pal.low, 0.72),
      scale(pal.low, 0.9),
      scale(pal.mid, 0.8),
      mix(pal.low, pal.mid, 0.5),
    ]
    // On a season day the whole canopy turns — the same shift forestColour
    // applies to the terrain's forest tint, so the trees never disagree with
    // the wooded ground under them.
    if (day.season) {
      const to = day.season === 'blossom' ? pal.bloom : pal.sun
      canopy = canopy.map((c) => mix(c, to, 0.45))
    }
    const accent = mix(pal.sun, pal.low, 0.55)

    const make = (geo: BufferGeometry, cap: number) => {
      const mat = new MeshLambertMaterial({ vertexColors: true })
      // Trees carry to the fog limit, where a flat-fogged silhouette against
      // directionally-hazed terrain would show as the wrong colour of tree.
      patchAirFog(mat)
      const mesh = new InstancedMesh(geo, mat, cap)
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3)
      mesh.frustumCulled = false
      mesh.count = 0
      return mesh
    }

    return {
      coniferMesh: make(conifer, MAX_PER_SPECIES),
      broadleafMesh: make(broadleaf, MAX_PER_SPECIES),
      // One mesh and one palette per understory species, in DETAIL's order —
      // the scatter walks the same list, so the indices always agree.
      detailMeshes: details.map((d) => make(detailGeometry(d.kind, trunkTint), MAX_DETAIL)),
      detailPalettes: details.map((d) => detailColours(d.kind, pal)),
      detail2Mesh: spec2 ? make(detailGeometry(spec2.kind, trunkTint), MAX_DETAIL2) : null,
      detail2Palette: spec2 ? detailColours(spec2.kind, pal) : [],
      canopy,
      accent,
      day,
      // Shared with the terrain's own forest tint, so trees only ever stand on
      // ground that already looks wooded.
      mask: createForestMask(world.seed),
      // The finer field inside that one: thickets and glades. Deliberately not
      // shared with the terrain — the ground tint wants to stay smooth under a
      // wood, and painting glades into it would show the seams where the
      // instanced trees stop.
      grove: createGroveMask(world.seed),
      // Shared with the terrain again, like the forest mask and for the same
      // reason: boulders have to land on ground that is already stone-coloured.
      rock: createRockMask(world.seed),
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
      {built.detailMeshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      {built.detail2Mesh && <primitive object={built.detail2Mesh} />}
    </>
  )
}

interface Built {
  coniferMesh: InstancedMesh
  broadleafMesh: InstancedMesh
  detailMeshes: InstancedMesh[]
  detailPalettes: Rgb[][]
  detail2Mesh: InstancedMesh | null
  detail2Palette: Rgb[]
  canopy: Rgb[]
  accent: Rgb
  day: ForestDay
  mask: Noise2D
  grove: Noise2D
  rock: Noise2D
}

/**
 * The understory species that belong on stone. Everything else — cactus, palm,
 * shrub, reed, tuft — wants soil, and the rock field is none of its business.
 */
const STONY = new Set<DetailKind>(['boulder', 'spire'])

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
  const details = DETAIL[world.biome]
  const detail2 = DETAIL2[world.biome]
  const day = built.day
  // The day leans the species ratio: some valley days are nearly all
  // broadleaf, some are conifer country.
  const dayBroadleaf = Math.min(0.95, Math.max(0.05, spec.broadleaf + day.broadleafShift))
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
  const nDetails = new Array<number>(details.length).fill(0)
  let nDetail2 = 0

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
        const clumpRoll = rng()

        // Filters are ordered cheapest-first: this runs a few thousand times per
        // rescatter, and the gradient alone costs four height samples.
        const dx = x - cx
        const dz = z - cz
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue

        const h = sampleHeight(hf, x, z)
        if (h > treelineY || h < floorY || h < waterY) continue

        // Thickets and glades, and the reason `density` is several times what it
        // used to be. It sits above the gradient rather than below it because it
        // is one noise sample against the gradient's four height samples: the
        // expensive filters below then run in proportion to the trees this
        // actually produces (measured at 1.6-1.9x the old count) rather than to
        // the attempts made to produce them (2.1-3.0x). The worst biome's
        // rescatter went from 0.8 ms to 2.0 ms — still a fraction of a frame,
        // and it only happens every 230 m of travel.
        if (clumpRoll > groveAmount(built.grove, spec, x, z)) continue

        sampleGradient(hf, x, z, GRAD)
        const slope = Math.hypot(GRAD.x, GRAD.z)
        if (slope > spec.maxSlope) continue

        if (maskRoll > forestAmount(built.mask, built.rock, spec, hf, h, slope, x, z)) continue

        const broad = speciesRoll < dayBroadleaf
        const mesh = broad ? built.broadleafMesh : built.coniferMesh
        const index = broad ? nBroadleaf : nConifer
        if (index >= MAX_PER_SPECIES) continue

        // Shrink to nothing at the scatter boundary, so recycling is invisible.
        const edge = 1 - smoothstep(RADIUS * 0.8, RADIUS, Math.sqrt(d2))
        if (edge <= 0.02) continue

        const height = (spec.height[0] + sizeRoll * (spec.height[1] - spec.height[0])) * edge * day.height
        const width = height * (broad ? 0.62 : 0.44) * (0.85 + colourRoll * 0.3) * day.width

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
      // whole cell is still one deterministic sequence. Species in DETAIL's
      // order, one after another — every species draws the same rolls whether
      // or not its predecessors placed anything, so adding one to a biome's
      // list never reshuffles the ones before it.
      for (let di = 0; di < details.length; di++) {
        const detail = details[di]
        const mesh = built.detailMeshes[di]
        const detailPalette = built.detailPalettes[di]
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
          if (d2 > r2 || nDetails[di] >= MAX_DETAIL) continue

          const h = sampleHeight(hf, x, z)
          if (h < waterY) continue
          const band = (h - hf.min) / range
          if (band < detail.band[0] || band > detail.band[1]) continue
          if (detail.shore > 0 && (!hf.hasWater || h > hf.waterLevel + detail.shore)) continue

          sampleGradient(hf, x, z, GRAD)
          const slope = Math.hypot(GRAD.x, GRAD.z)
          // Boulders and basalt want steep ground, because talus is what a slope
          // sheds. But a scree sector is flat ground buried in the stuff, and the
          // lower bound is what used to make that impossible — so where the rock
          // field is high it goes away, and the stone itself becomes the reason
          // they are standing there. The upper bound stays: nothing perches on a
          // cliff face, however stony the cliff is.
          const stony = STONY.has(detail.kind) ? rockAmount(built.rock, spec, hf, h, x, z) : 0
          if (slope < detail.slope[0] * (1 - stony) || slope > detail.slope[1]) continue

          // Thinned rather than excluded under canopy: a boulder in a wood is fine,
          // a boulder field in a wood is not.
          if (detail.inForest < 1) {
            const cover = forestAmount(built.mask, built.rock, spec, hf, h, slope, x, z)
            if (cover > 0 && forestRoll > detail.inForest) continue
          }

          const edge = 1 - smoothstep(RADIUS * 0.8, RADIUS, Math.sqrt(d2))
          if (edge <= 0.02) continue

          const height = (detail.height[0] + sizeRoll * (detail.height[1] - detail.height[0])) * edge
          // Boulders sit in the ground rather than on it, and they are not
          // upright. Hoodoos are far slimmer than their height; everything else
          // splays about as wide as it stands.
          const rock = detail.kind === 'boulder'
          const width =
            height *
            (rock
              ? 1.1 + tintRoll * 0.5
              : detail.kind === 'hoodoo'
                ? 0.42 + tintRoll * 0.14
                : 0.7 + tintRoll * 0.3)

          POS.set(x, rock ? h - height * 0.28 : h, z)
          QUAT.setFromAxisAngle(UP, rot)
          SCALE.set(width, height, width * (rock ? 0.85 + sizeRoll * 0.4 : 1))
          MATRIX.compose(POS, QUAT, SCALE)
          mesh.setMatrixAt(nDetails[di], MATRIX)

          const base = detailPalette[Math.floor(tintRoll * detailPalette.length) % detailPalette.length]
          const v = 0.84 + sizeRoll * 0.3
          COLOR.setRGB(clamp01(base[0] * v), clamp01(base[1] * v), clamp01(base[2] * v))
          mesh.setColorAt(nDetails[di], COLOR)
          nDetails[di]++
        }
      }

      // The water-edge species, off the same cell stream again, so the whole
      // cell stays one deterministic sequence.
      if (detail2 && built.detail2Mesh) {
        for (let k = 0; k < detail2.density; k++) {
          const x = (cix + rng()) * CELL
          const z = (ciz + rng()) * CELL
          const rot = rng() * Math.PI * 2
          const sizeRoll = rng()
          const tintRoll = rng()
          const forestRoll = rng()

          const dx = x - cx
          const dz = z - cz
          const d2 = dx * dx + dz * dz
          if (d2 > r2 || nDetail2 >= MAX_DETAIL2) continue

          const h = sampleHeight(hf, x, z)
          if (h < waterY) continue
          // Near the lake, or along a watercourse — either will do, and a species
          // may want only one of them. The alpine and mesa understories are the
          // river case on its own: their `shore` is zero, so the drainage is the
          // only thing that admits them at all.
          if (detail2.shore > 0 || detail2.riverbank > 0) {
            const onShore =
              detail2.shore > 0 && hf.hasWater && h <= hf.waterLevel + detail2.shore
            let onBank = false
            if (!onShore && detail2.riverbank > 0) {
              const wet = sampleWet(hf, x, z)
              // A band, not a floor. Past BANK_MAX is the channel itself, where
              // the stream mesh is drawing water — reeds standing mid-river would
              // be growing out of it.
              onBank = wet > detail2.riverbank && wet < BANK_MAX
            }
            if (!onShore && !onBank) continue
          }

          sampleGradient(hf, x, z, GRAD)
          const slope = Math.hypot(GRAD.x, GRAD.z)
          if (slope < detail2.slope[0] || slope > detail2.slope[1]) continue

          if (detail2.inForest < 1) {
            const cover = forestAmount(built.mask, built.rock, spec, hf, h, slope, x, z)
            if (cover > 0 && forestRoll > detail2.inForest) continue
          }

          const edge = 1 - smoothstep(RADIUS * 0.8, RADIUS, Math.sqrt(d2))
          if (edge <= 0.02) continue

          const height = (detail2.height[0] + sizeRoll * (detail2.height[1] - detail2.height[0])) * edge
          const width = height * (0.7 + tintRoll * 0.3)

          POS.set(x, h, z)
          QUAT.setFromAxisAngle(UP, rot)
          SCALE.set(width, height, width)
          MATRIX.compose(POS, QUAT, SCALE)
          built.detail2Mesh.setMatrixAt(nDetail2, MATRIX)

          const base = built.detail2Palette[Math.floor(tintRoll * built.detail2Palette.length) % built.detail2Palette.length]
          const v = 0.84 + sizeRoll * 0.3
          COLOR.setRGB(clamp01(base[0] * v), clamp01(base[1] * v), clamp01(base[2] * v))
          built.detail2Mesh.setColorAt(nDetail2, COLOR)
          nDetail2++
        }
      }

      // The banks, on their own budget. Same mesh, same species, same cell
      // stream — only the reason for being there differs, and it is the one the
      // ordinary scatter is too thinly spread to find.
      if (detail2 && built.detail2Mesh && detail2.bankDensity > 0) {
        for (let k = 0; k < detail2.bankDensity; k++) {
          const x = (cix + rng()) * CELL
          const z = (ciz + rng()) * CELL
          const rot = rng() * Math.PI * 2
          const sizeRoll = rng()
          const tintRoll = rng()
          const forestRoll = rng()

          const dx = x - cx
          const dz = z - cz
          const d2 = dx * dx + dz * dz
          if (d2 > r2 || nDetail2 >= MAX_DETAIL2) continue

          const h = sampleHeight(hf, x, z)
          if (h < waterY) continue
          const wet = sampleWet(hf, x, z)
          if (wet <= detail2.riverbank || wet >= BANK_MAX) continue

          sampleGradient(hf, x, z, GRAD)
          const slope = Math.hypot(GRAD.x, GRAD.z)
          if (slope < detail2.slope[0] || slope > detail2.slope[1]) continue

          if (detail2.inForest < 1) {
            const cover = forestAmount(built.mask, built.rock, spec, hf, h, slope, x, z)
            if (cover > 0 && forestRoll > detail2.inForest) continue
          }

          const edge = 1 - smoothstep(RADIUS * 0.8, RADIUS, Math.sqrt(d2))
          if (edge <= 0.02) continue

          const height = (detail2.height[0] + sizeRoll * (detail2.height[1] - detail2.height[0])) * edge
          const width = height * (0.7 + tintRoll * 0.3)

          POS.set(x, h, z)
          QUAT.setFromAxisAngle(UP, rot)
          SCALE.set(width, height, width)
          MATRIX.compose(POS, QUAT, SCALE)
          built.detail2Mesh.setMatrixAt(nDetail2, MATRIX)

          const base = built.detail2Palette[Math.floor(tintRoll * built.detail2Palette.length) % built.detail2Palette.length]
          const v = 0.84 + sizeRoll * 0.3
          COLOR.setRGB(clamp01(base[0] * v), clamp01(base[1] * v), clamp01(base[2] * v))
          built.detail2Mesh.setColorAt(nDetail2, COLOR)
          nDetail2++
        }
      }
    }
  }

  built.coniferMesh.count = nConifer
  built.broadleafMesh.count = nBroadleaf
  built.coniferMesh.instanceMatrix.needsUpdate = true
  built.broadleafMesh.instanceMatrix.needsUpdate = true
  if (built.coniferMesh.instanceColor) built.coniferMesh.instanceColor.needsUpdate = true
  if (built.broadleafMesh.instanceColor) built.broadleafMesh.instanceColor.needsUpdate = true
  for (let di = 0; di < built.detailMeshes.length; di++) {
    const mesh = built.detailMeshes[di]
    mesh.count = nDetails[di]
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }
  if (built.detail2Mesh) {
    built.detail2Mesh.count = nDetail2
    built.detail2Mesh.instanceMatrix.needsUpdate = true
    if (built.detail2Mesh.instanceColor) built.detail2Mesh.instanceColor.needsUpdate = true
  }
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
    case 'reed': {
      // A clump of leaning stalks with dark seed heads — cattails. The heads
      // are what read as reeds instead of thin grass at any distance.
      const stalk = (x: number, z: number, lean: number, h: number, tint: number) => [
        { geo: translated(rotatedZ(new CylinderGeometry(0.035, 0.05, h, 4), lean), x, h * 0.5, z), tint },
        { geo: translated(rotatedZ(new CylinderGeometry(0.06, 0.06, 0.16, 4), lean), x - lean * h * 0.55, h, z), tint: 0.42 },
      ]
      return merge([
        ...stalk(-0.14, 0.06, 0.1, 0.86, 1.0),
        ...stalk(0.1, -0.08, -0.12, 1.0, 0.9),
        ...stalk(0.03, 0.12, 0.05, 0.72, 0.82),
      ])
    }
    case 'tuft': {
      // Beach grass: a splay of flattened blades from one root, no trunk.
      const parts: Array<{ geo: BufferGeometry; tint: number }> = []
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.4
        const blade = scaled(new ConeGeometry(0.07, 0.9, 4), 1, 1, 0.3)
        parts.push({
          geo: translated(rotatedY(rotatedZ(blade, 0.55), a), Math.cos(a) * 0.16, 0.38, Math.sin(a) * 0.16),
          tint: i % 2 === 0 ? 1.0 : 0.8,
        })
      }
      return merge(parts)
    }
    case 'hoodoo': {
      // A totem of soft rock under a harder caprock. The radii pinch and swell
      // up the column and each layer sits a little off the axis — a straight
      // stack reads as a machined part. The dark overhanging cap is the one
      // legible feature: the caprock is why a hoodoo exists, so it is the thing
      // the silhouette has to say.
      return merge([
        { geo: translated(new CylinderGeometry(0.24, 0.34, 0.3, 7), 0, 0.15, 0), tint: 0.92 },
        { geo: translated(new CylinderGeometry(0.19, 0.25, 0.28, 7), 0.03, 0.43, -0.02), tint: 1.0 },
        { geo: translated(new CylinderGeometry(0.22, 0.18, 0.26, 7), -0.02, 0.69, 0.03), tint: 0.85 },
        { geo: translated(new CylinderGeometry(0.2, 0.28, 0.18, 7), 0.02, 0.91, 0), tint: 0.62 },
      ])
    }
    case 'ocotillo': {
      // A fan of bare canes leaning out of one root. Nothing else in the game
      // is thin lines against the sky, which is exactly what an ocotillo is —
      // the shape earns its place by being unlike every other silhouette here.
      const parts: Array<{ geo: BufferGeometry; tint: number }> = []
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.9
        const lean = 0.28 + (i % 3) * 0.11
        const cane = translated(new CylinderGeometry(0.012, 0.03, 1.0, 4), 0, 0.5, 0)
        parts.push({
          geo: rotatedY(rotatedZ(cane, lean), a),
          tint: i % 2 === 0 ? 1.0 : 0.82,
        })
      }
      return merge(parts)
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
    case 'reed':
      return [mix(pal.low, pal.mid, 0.5), scale(pal.mid, 0.78), mix(pal.mid, pal.rock, 0.25)]
    case 'tuft':
      // Dry standing grass on sand: pale, closer to the beach than the field.
      return [mix(pal.sand, pal.mid, 0.45), mix(pal.sand, pal.high, 0.4), scale(pal.sand, 0.88)]
    case 'hoodoo':
      // Mostly the rock band, with mineral as the seasoning. The first cut
      // leaned mineral-first and on a hazy day the columns came out near-white —
      // scattered bones on the ground instead of stone standing out of it.
      return [scale(pal.rock, 1.1), mix(pal.rock, pal.mineral, 0.35), scale(pal.rock, 0.9), mix(pal.rock, pal.mineral, 0.55)]
    case 'ocotillo':
      // Dry canes: more stick than leaf, with the odd one flushed toward bloom.
      return [mix(pal.mid, pal.rock, 0.4), scale(pal.mid, 0.72), mix(pal.mid, pal.bloom, 0.2)]
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
