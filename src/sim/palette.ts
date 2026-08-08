import { mulberry32 } from './rng'

export type BiomeId = 'alpine' | 'mesa' | 'coastal' | 'valley' | 'volcanic' | 'field' | 'archipelago'

export const BIOME_ORDER: readonly BiomeId[] = [
  'alpine',
  'mesa',
  'coastal',
  'valley',
  'volcanic',
  // Between the darkest biome and the wettest, because the rotation's job is to
  // make consecutive days feel like different games: ash to hay, then hay to sea.
  'field',
  'archipelago',
]

export type Rgb = [number, number, number]

export interface Palette {
  skyTop: Rgb
  skyHorizon: Rgb
  fog: Rgb
  sun: Rgb
  sunLight: Rgb
  ambient: Rgb
  /** Terrain ramp, low altitude to high. */
  low: Rgb
  mid: Rgb
  high: Rgb
  /** Steep faces, blended in by slope. */
  rock: Rgb
  water: Rgb
  /**
   * The band of light opposite the sun — earth's own shadow seen from inside it.
   * Real, and the single cheapest thing that makes a sky look like somewhere
   * rather than like a gradient.
   */
  glow: Rgb
  /** High cirrus, lit from underneath by a low sun. */
  cirrus: Rgb
  /** Meadow and flowering patches painted into gentle ground. */
  bloom: Rgb
  /** A second mineral band, so rock faces are strata rather than one colour. */
  mineral: Rgb
  /**
   * The shore band just above the waterline. Not always sand-coloured: grey
   * shingle on alpine lakes, alkali crust on a playa, black sand under a volcano.
   */
  sand: Rgb
  /** Name of the day's grade. Shown on the start screen; see GRADES. */
  mood: string
}

type Hsl = [number, number, number]

type PaletteSpec = Record<Exclude<keyof Palette, 'mood'>, Hsl>

/**
 * Base palettes, one per biome, in HSL so the day's seed can shift hue coherently
 * across the whole scene instead of tinting each colour independently.
 */
const SPECS: Record<BiomeId, PaletteSpec> = {
  alpine: {
    skyTop: [0.6, 0.55, 0.34],
    skyHorizon: [0.55, 0.42, 0.72],
    fog: [0.55, 0.38, 0.74],
    sun: [0.11, 0.75, 0.86],
    sunLight: [0.09, 0.35, 0.95],
    ambient: [0.6, 0.3, 0.5],
    low: [0.32, 0.28, 0.26],
    mid: [0.28, 0.14, 0.42],
    high: [0.58, 0.16, 0.93],
    rock: [0.62, 0.08, 0.4],
    water: [0.54, 0.5, 0.34],
    glow: [0.93, 0.55, 0.7],
    cirrus: [0.6, 0.3, 0.9],
    bloom: [0.84, 0.35, 0.6],
    mineral: [0.08, 0.14, 0.46],
    // Shingle and glacial flour, not sand. An alpine lake has a grey shore.
    sand: [0.58, 0.06, 0.6],
  },
  mesa: {
    skyTop: [0.58, 0.5, 0.42],
    skyHorizon: [0.07, 0.62, 0.7],
    fog: [0.06, 0.5, 0.68],
    sun: [0.09, 0.85, 0.8],
    sunLight: [0.07, 0.5, 0.95],
    ambient: [0.6, 0.25, 0.45],
    low: [0.09, 0.4, 0.5],
    mid: [0.05, 0.52, 0.42],
    high: [0.04, 0.45, 0.55],
    rock: [0.03, 0.38, 0.32],
    water: [0.5, 0.35, 0.3],
    glow: [0.95, 0.6, 0.66],
    cirrus: [0.08, 0.42, 0.86],
    bloom: [0.13, 0.5, 0.6],
    mineral: [0.56, 0.12, 0.44],
    // Alkali crust around the playa — the pale ring a dry lake actually has.
    sand: [0.12, 0.2, 0.72],
  },
  coastal: {
    skyTop: [0.6, 0.48, 0.4],
    skyHorizon: [0.95, 0.45, 0.76],
    fog: [0.94, 0.3, 0.76],
    sun: [0.05, 0.8, 0.84],
    sunLight: [0.03, 0.35, 0.93],
    ambient: [0.58, 0.3, 0.5],
    low: [0.14, 0.32, 0.6],
    mid: [0.28, 0.3, 0.36],
    high: [0.26, 0.25, 0.5],
    rock: [0.1, 0.14, 0.44],
    water: [0.51, 0.55, 0.3],
    glow: [0.97, 0.55, 0.75],
    cirrus: [0.95, 0.28, 0.88],
    bloom: [0.11, 0.45, 0.62],
    mineral: [0.6, 0.1, 0.42],
    sand: [0.11, 0.42, 0.7],
  },
  valley: {
    skyTop: [0.66, 0.42, 0.36],
    skyHorizon: [0.78, 0.32, 0.72],
    fog: [0.74, 0.24, 0.72],
    sun: [0.12, 0.7, 0.88],
    sunLight: [0.1, 0.28, 0.92],
    ambient: [0.66, 0.28, 0.48],
    low: [0.3, 0.34, 0.2],
    mid: [0.27, 0.3, 0.3],
    high: [0.22, 0.2, 0.5],
    rock: [0.1, 0.1, 0.38],
    water: [0.48, 0.4, 0.3],
    glow: [0.9, 0.45, 0.74],
    cirrus: [0.72, 0.24, 0.9],
    bloom: [0.94, 0.42, 0.64],
    mineral: [0.1, 0.16, 0.4],
    // River silt. A lake in wooded country has a mud margin, not a beach.
    sand: [0.09, 0.26, 0.5],
  },
  volcanic: {
    skyTop: [0.72, 0.4, 0.16],
    skyHorizon: [0.03, 0.7, 0.42],
    fog: [0.02, 0.45, 0.34],
    sun: [0.04, 0.9, 0.6],
    sunLight: [0.03, 0.6, 0.8],
    ambient: [0.72, 0.35, 0.28],
    low: [0.02, 0.4, 0.2],
    mid: [0.03, 0.12, 0.16],
    high: [0.0, 0.02, 0.3],
    rock: [0.66, 0.04, 0.12],
    water: [0.05, 0.6, 0.3],
    glow: [0.02, 0.75, 0.46],
    cirrus: [0.04, 0.45, 0.5],
    // Ember, not flowers. Nothing blooms here; the patches are cooling lava.
    bloom: [0.05, 0.75, 0.3],
    mineral: [0.6, 0.05, 0.26],
    // Black sand. The one shore in the game that is darker than the water.
    sand: [0.65, 0.08, 0.14],
  },
  field: {
    // Hay country under a soft summer sky: green pasture low, gold standing grass
    // above it, chalk showing through wherever the ground breaks. The brightest
    // ground palette of the seven, because the land here is the whole frame —
    // there are no peaks to carry the composition.
    skyTop: [0.57, 0.52, 0.4],
    skyHorizon: [0.12, 0.48, 0.78],
    fog: [0.11, 0.36, 0.76],
    sun: [0.1, 0.8, 0.85],
    sunLight: [0.08, 0.42, 0.94],
    ambient: [0.6, 0.26, 0.5],
    low: [0.24, 0.42, 0.38],
    mid: [0.15, 0.48, 0.5],
    high: [0.13, 0.35, 0.62],
    rock: [0.1, 0.12, 0.5],
    water: [0.5, 0.42, 0.34],
    glow: [0.93, 0.5, 0.72],
    cirrus: [0.11, 0.3, 0.88],
    // Poppies in the fallow strips.
    bloom: [0.97, 0.55, 0.62],
    mineral: [0.08, 0.18, 0.55],
    sand: [0.1, 0.24, 0.58],
  },
  archipelago: {
    skyTop: [0.56, 0.6, 0.42],
    // Cyan haze, not cream. A warm pale fog turns every distant surface — including
    // the whole ocean, which is most of the frame on this biome — the colour of
    // sand, and the tropics came out looking like a desert.
    skyHorizon: [0.52, 0.42, 0.8],
    fog: [0.5, 0.3, 0.79],
    sun: [0.13, 0.8, 0.88],
    sunLight: [0.11, 0.3, 0.96],
    ambient: [0.55, 0.35, 0.55],
    low: [0.13, 0.45, 0.66],
    mid: [0.3, 0.42, 0.34],
    high: [0.26, 0.3, 0.5],
    rock: [0.09, 0.16, 0.42],
    water: [0.48, 0.65, 0.42],
    glow: [0.9, 0.6, 0.76],
    cirrus: [0.52, 0.28, 0.9],
    bloom: [0.96, 0.5, 0.68],
    mineral: [0.55, 0.14, 0.46],
    // Coral sand, nearly white. The beach is the biome's signature band.
    sand: [0.12, 0.52, 0.82],
  },
}

/**
 * The day's grade, on top of the biome.
 *
 * Six biomes on a strict rotation means the same biome comes back every six days,
 * and a hue wobble alone was not enough to make those two days feel like different
 * places. A grade splits the sky and the ground in *opposite* hue directions, which
 * is the difference between a scene that is tinted and a scene that has a light in
 * it — complementary sky and ground is most of why dawn photographs look the way
 * they do. The names are the point too: the day gets called something.
 */
interface Grade {
  name: string
  /** Hue rotation for everything airborne — sky, fog, sun, haze. */
  sky: number
  /** Hue rotation for everything solid. Deliberately the other way. */
  ground: number
  sat: number
  light: number
}

const GRADES: readonly Grade[] = [
  { name: 'clear', sky: 0, ground: 0, sat: 1.0, light: 0 },
  { name: 'daybreak', sky: 0.035, ground: -0.025, sat: 1.12, light: 0.03 },
  { name: 'gloaming', sky: -0.04, ground: 0.03, sat: 1.06, light: -0.045 },
  { name: 'hazy', sky: 0.014, ground: 0.014, sat: 0.74, light: 0.07 },
  { name: 'reverie', sky: 0.07, ground: -0.055, sat: 1.22, light: 0.015 },
  { name: 'deep', sky: -0.02, ground: -0.02, sat: 1.3, light: -0.06 },
]

/** Which half of the palette the grade's sky rotation applies to. */
const AIRBORNE = new Set(['skyTop', 'skyHorizon', 'fog', 'sun', 'sunLight', 'ambient', 'glow', 'cirrus'])

/**
 * Takes the seed rather than the world's shared Rng on purpose. Drawing from the
 * shared stream meant that adding one colour to a palette re-rolled every terrain
 * on every day, so no colour could be touched without changing the game. Its own
 * stream makes the palette free to edit.
 */
export function buildPalette(biome: BiomeId, seed: number): Palette {
  const rng = mulberry32(seed ^ 0xa1e77e)
  const spec = SPECS[biome]
  const grade = GRADES[Math.floor(rng() * GRADES.length)]
  // One shared hue rotation for the day, plus a small per-channel wobble, so two
  // days of the same biome read as different places rather than the same render.
  const hueShift = (rng() - 0.5) * 0.06
  const satScale = 0.88 + rng() * 0.3
  const out = { mood: grade.name } as Palette
  for (const key of Object.keys(spec) as (keyof PaletteSpec)[]) {
    const [h, s, l] = spec[key]
    const airborne = AIRBORNE.has(key)
    const hue = h + hueShift + (airborne ? grade.sky : grade.ground)
    // Ground takes half the lightness shift: a grade that lifts the sky into haze
    // should not also wash out the terrain the player is trying to read.
    const lift = grade.light * (airborne ? 1 : 0.5)
    out[key] = hslToRgb(
      wrap01(hue),
      clamp01(s * satScale * grade.sat),
      clamp01(l + lift + (rng() - 0.5) * 0.04),
    )
  }
  return out
}

export const rgbToHex = (c: Rgb): number =>
  (Math.round(clamp01(c[0]) * 255) << 16) | (Math.round(clamp01(c[1]) * 255) << 8) | Math.round(clamp01(c[2]) * 255)

export const rgbToCss = (c: Rgb): string =>
  `rgb(${Math.round(clamp01(c[0]) * 255)}, ${Math.round(clamp01(c[1]) * 255)}, ${Math.round(clamp01(c[2]) * 255)})`

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const wrap01 = (v: number) => v - Math.floor(v)

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}
