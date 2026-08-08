import { Noise2D, fbm } from './noise'
import { mulberry32 } from './rng'
import { smoothstep, type Heightfield } from './terrain'
import type { BiomeId, Palette, Rgb } from './palette'

/**
 * Where things grow. Kept in `sim` rather than `render` because it is a property
 * of the day's world, not of how it is drawn — and because the numbers want to be
 * readable next to the terrain shapes they refer to.
 *
 * Heights are fractions of the day's terrain range, not metres, so a biome reads
 * the same whether the seed produced 400 m or 800 m of relief.
 */
export interface FloraSpec {
  /** Scatter attempts per 384 m cell. Roughly a third survive the filters. */
  density: number
  /** Above this fraction of the height range, nothing grows. */
  treeline: number
  /** Below this fraction, nothing grows — arid basins, salt flats, bare shore. */
  floor: number
  /** 0 = all conifer, 1 = all broadleaf. */
  broadleaf: number
  /** Terrain gradient above which the slope is bare rock. */
  maxSlope: number
  /** Metres of trunk-to-tip height, before per-tree variation. */
  height: [number, number]
  /** Fraction of trees that take the day's accent colour instead of the canopy greens. */
  accent: number
}

export const FLORA: Record<BiomeId, FloraSpec> = {
  // Dense spruce below the treeline, bare rock and snow above it.
  alpine: { density: 14, treeline: 0.6, floor: 0.02, broadleaf: 0.12, maxSlope: 0.95, height: [16, 30], accent: 0.05 },
  // Sparse scrub in the washes between the terraces.
  mesa: { density: 3, treeline: 0.52, floor: 0.06, broadleaf: 0.75, maxSlope: 0.5, height: [10, 18], accent: 0.18 },
  // Wind-bent pines on the headlands, thinning toward the cliffs.
  coastal: { density: 11, treeline: 0.72, floor: 0.015, broadleaf: 0.45, maxSlope: 0.8, height: [14, 26], accent: 0.1 },
  // The lushest of the six. Broadleaf woodland with clearings.
  valley: { density: 17, treeline: 0.82, floor: 0.0, broadleaf: 0.6, maxSlope: 1.0, height: [18, 34], accent: 0.22 },
  // Almost nothing survives; a few charred stands low on the flanks.
  volcanic: { density: 2, treeline: 0.32, floor: 0.02, broadleaf: 0.2, maxSlope: 0.6, height: [12, 22], accent: 0.04 },
  // Palms and tropical canopy right down to the beaches.
  archipelago: { density: 12, treeline: 0.7, floor: 0.005, broadleaf: 0.88, maxSlope: 0.75, height: [14, 24], accent: 0.14 },
}

/* --------------------------------------------------------- the forest mask ---- */

/**
 * Where forest grows, as a 0..1 field.
 *
 * This exists because instanced trees alone cannot make a landscape look forested.
 * Real woodland is a tree every few metres; the instance budget affords one every
 * ~150 m. Scattered individually they read as a handful of shrubs on bare ground,
 * which is exactly how it looked at first.
 *
 * So the forest lives in two places at once. The terrain mesh tints itself toward
 * canopy colour wherever this field is high, which is what makes the hills read as
 * wooded from a kilometre up; the instanced trees then add real silhouettes in the
 * near field. Both read the same field, so the trees always stand on ground that
 * already looks like forest, and the join is invisible.
 */
export const createForestMask = (seed: number) => new Noise2D(mulberry32(seed ^ 0xf10a))

const MASK_OPTS = { octaves: 3, frequency: 1 / 950, lacunarity: 2, gain: 0.5 }

export function forestAmount(
  mask: Noise2D,
  spec: FloraSpec,
  hf: Heightfield,
  h: number,
  slope: number,
  x: number,
  z: number,
): number {
  const range = Math.max(hf.max - hf.min, 1)
  const treelineY = hf.min + range * spec.treeline
  if (h > treelineY) return 0
  if (h < hf.min + range * spec.floor) return 0
  if (slope > spec.maxSlope) return 0

  let a = smoothstep(-0.34, 0.3, fbm(mask, x, z, MASK_OPTS))
  // Hold the forest back from the shoreline so the sandy low band shows as beach
  // rather than being tinted green right down to the waterline.
  if (hf.hasWater) a *= smoothstep(hf.waterLevel + 8, hf.waterLevel + 55, h)
  if (a <= 0) return 0
  // Fade out over the last stretch below the treeline, so the upper edge of the
  // forest is a gradient rather than a contour line.
  return a * (1 - smoothstep(treelineY - range * 0.13, treelineY, h))
}

/**
 * Representative canopy colour for the day, used to tint forested terrain.
 *
 * Picks whichever of the low and mid terrain bands is actually the green one and
 * darkens it. The bands do not mean the same thing in every palette — on alpine days
 * `low` is forest floor, on tropical days it is beach sand — so deriving canopy from
 * a fixed band gave the archipelago sand-coloured woodland.
 */
export const forestColour = (pal: Palette): Rgb => {
  const greenness = (c: Rgb) => c[1] - (c[0] + c[2]) * 0.5
  const base = greenness(pal.mid) >= greenness(pal.low) ? pal.mid : pal.low
  return [base[0] * 0.55, base[1] * 0.68, base[2] * 0.48]
}
