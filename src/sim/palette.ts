import type { Rng } from './rng'

export type BiomeId = 'alpine' | 'mesa' | 'coastal' | 'valley' | 'volcanic' | 'archipelago'

export const BIOME_ORDER: readonly BiomeId[] = [
  'alpine',
  'mesa',
  'coastal',
  'valley',
  'volcanic',
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
}

type Hsl = [number, number, number]

interface PaletteSpec {
  skyTop: Hsl
  skyHorizon: Hsl
  fog: Hsl
  sun: Hsl
  sunLight: Hsl
  ambient: Hsl
  low: Hsl
  mid: Hsl
  high: Hsl
  rock: Hsl
  water: Hsl
}

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
  },
}

export function buildPalette(biome: BiomeId, rng: Rng): Palette {
  const spec = SPECS[biome]
  // One shared hue rotation for the day, plus a small per-channel wobble, so two
  // days of the same biome read as different places rather than the same render.
  const hueShift = (rng() - 0.5) * 0.06
  const satScale = 0.88 + rng() * 0.3
  const out = {} as Palette
  for (const key of Object.keys(spec) as (keyof PaletteSpec)[]) {
    const [h, s, l] = spec[key]
    out[key] = hslToRgb(wrap01(h + hueShift), clamp01(s * satScale), clamp01(l + (rng() - 0.5) * 0.04))
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
