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
  // Hedgerow country: broadleaf copses between open pasture, grass nearly to the top.
  field: { density: 9, treeline: 0.94, floor: 0.01, broadleaf: 0.85, maxSlope: 0.6, height: [12, 24], accent: 0.2 },
  // Palms and tropical canopy right down to the beaches.
  archipelago: { density: 12, treeline: 0.7, floor: 0.005, broadleaf: 0.88, maxSlope: 0.75, height: [14, 24], accent: 0.14 },
}

/* -------------------------------------------------------------- understory ---- */

export type DetailKind = 'boulder' | 'cactus' | 'palm' | 'shrub' | 'spire' | 'bale' | 'reed' | 'tuft'

/**
 * The second thing that grows — or in half the biomes, does not grow at all.
 *
 * Trees only ever stand where the forest mask is high, which by design leaves every
 * bare slope, scree field, playa and beach in the game completely empty. Those are
 * most of the ground on four of the six biomes. The understory fills them with one
 * more instanced species per biome, placed by the rules trees are placed *against*:
 * boulders want the steep ground trees are excluded from, palms want the shoreline
 * the forest is deliberately held back from.
 */
export interface DetailSpec {
  kind: DetailKind
  /** Scatter attempts per 384 m cell, same cells as the trees. */
  density: number
  /** Terrain gradient window. Boulders want slope; cacti and palms want none. */
  slope: [number, number]
  /** Height window, as a fraction of the day's range. */
  band: [number, number]
  /** Metres, before per-instance variation. */
  height: [number, number]
  /** Chance of surviving inside forest. 1 = grows among the trees quite happily. */
  inForest: number
  /** If > 0, only within this many metres above the waterline. */
  shore: number
}

export const DETAIL: Record<BiomeId, DetailSpec> = {
  // Talus and glacial erratics, on exactly the slopes the spruce cannot hold.
  alpine: { kind: 'boulder', density: 8, slope: [0.35, 1.7], band: [0.05, 0.95], height: [4, 11], inForest: 0.35, shore: 0 },
  // Saguaro in the washes. The only vertical thing on a mesa day.
  mesa: { kind: 'cactus', density: 6, slope: [0, 0.34], band: [0.08, 0.62], height: [4, 9], inForest: 1, shore: 0 },
  // Broken rock along the cliff tops and headlands.
  coastal: { kind: 'boulder', density: 6, slope: [0.3, 1.5], band: [0, 0.9], height: [3, 8], inForest: 0.3, shore: 0 },
  // Bramble and scrub filling the clearings between the broadleaf stands.
  valley: { kind: 'shrub', density: 11, slope: [0, 0.7], band: [0, 0.78], height: [2, 4.5], inForest: 1, shore: 0 },
  // Basalt columns. Cooling lava cracks into hexagons, so these are hexagonal.
  volcanic: { kind: 'spire', density: 5, slope: [0.1, 1.2], band: [0.05, 0.88], height: [8, 22], inForest: 1, shore: 0 },
  // Hay bales on the open flats, never under the trees. Twice life size, because
  // a true 1.5 m drum vanishes from 300 m up — the same slightly-wrong-on-purpose
  // licence as the flattened sun, spent on the ground.
  field: { kind: 'bale', density: 6, slope: [0, 0.22], band: [0.03, 0.85], height: [2.4, 3.4], inForest: 0, shore: 0 },
  // Palms right down the beach, in the band the forest mask is told to avoid.
  archipelago: { kind: 'palm', density: 9, slope: [0, 0.36], band: [0, 0.4], height: [10, 18], inForest: 1, shore: 95 },
}

/**
 * The second understory, where a biome has one. Water-edge species mostly:
 * reeds ringing the lakes and ponds, dry grass tufts on the beaches the wide
 * sand aprons opened up. One more instanced draw call on the biomes that use
 * it, nothing anywhere else. Oversized like the hay bales, for the same
 * reason: true-scale reeds vanish from a glider.
 */
export const DETAIL2: Record<BiomeId, DetailSpec | null> = {
  alpine: null,
  mesa: null,
  coastal: { kind: 'tuft', density: 8, slope: [0, 0.45], band: [0, 1], height: [0.9, 1.6], inForest: 0.4, shore: 55 },
  valley: { kind: 'reed', density: 7, slope: [0, 0.3], band: [0, 1], height: [1.6, 2.8], inForest: 1, shore: 14 },
  volcanic: null,
  field: { kind: 'reed', density: 7, slope: [0, 0.3], band: [0, 1], height: [1.6, 2.8], inForest: 1, shore: 14 },
  archipelago: { kind: 'tuft', density: 8, slope: [0, 0.45], band: [0, 1], height: [0.9, 1.6], inForest: 0.4, shore: 55 },
}

/**
 * The day's forest character. Every wood used to be the same wood resampled:
 * FLORA's numbers are constants, so two valley days differed only in where the
 * mask fell. Now each day draws its own tree height and girth, leans the
 * species ratio one way or the other, and — rarely — has a season: a blossom
 * day turns the broadleaf canopy toward the bloom colour, an autumn day toward
 * the sun's gold. Terrain paints its forest tint through the same helper, so
 * the woods and the ground they stand on turn together.
 */
export interface ForestDay {
  height: number
  width: number
  broadleafShift: number
  season: 'blossom' | 'autumn' | null
}

export function forestDay(seed: number): ForestDay {
  const r = mulberry32(seed ^ 0x0f0e57)
  const height = 0.85 + r() * 0.35
  const width = 0.9 + r() * 0.25
  const broadleafShift = (r() - 0.5) * 0.36
  const roll = r()
  const season = roll < 0.08 ? 'blossom' : roll < 0.17 ? 'autumn' : null
  return { height, width, broadleafShift, season }
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
export const forestColour = (pal: Palette, seed: number): Rgb => {
  const greenness = (c: Rgb) => c[1] - (c[0] + c[2]) * 0.5
  let base = greenness(pal.mid) >= greenness(pal.low) ? pal.mid : pal.low
  const season = forestDay(seed).season
  if (season) {
    const to = season === 'blossom' ? pal.bloom : pal.sun
    base = [base[0] + (to[0] - base[0]) * 0.45, base[1] + (to[1] - base[1]) * 0.45, base[2] + (to[2] - base[2]) * 0.45]
  }
  return [base[0] * 0.55, base[1] * 0.68, base[2] * 0.48]
}
