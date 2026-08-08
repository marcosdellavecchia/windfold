import { Noise2D, fbm, ridged, billow, type FbmOptions } from './noise'
import type { Rng } from './rng'
import type { BiomeId } from './palette'

/**
 * 12 km across at 32 m cells — the same 385^2 vertex count and draw cost as the
 * original 6 km / 16 m map, for four times the area.
 *
 * The map size is a scoring constraint, not just a scenery one: distance is
 * straight-line displacement from the launch, so the map radius is a hard ceiling
 * on the score. At 6 km a hands-off glide already covered a third of the available
 * range, which left almost no room for skill to show up in the number.
 *
 * Coarser cells mean the finest noise octave has to go — see SHAPES below.
 */
export const WORLD_SIZE = 12288 // metres across
export const TERRAIN_SEG = 384 // 32 m cells
export const HALF_WORLD = WORLD_SIZE / 2

export interface Heightfield {
  size: number
  seg: number
  cell: number
  /** (seg + 1)^2 heights in metres, row-major by z then x. */
  data: Float32Array
  min: number
  max: number
  /** Absolute altitude of the water plane. Below `hasWater` this is unused. */
  waterLevel: number
  hasWater: boolean
}

/**
 * Octave counts are bounded by the 32 m cell size: the finest octave has to stay
 * above the ~64 m Nyquist wavelength or it turns into single-vertex spikes rather
 * than terrain. At lacunarity ~2 that caps every biome at five octaves.
 */
interface BiomeShape {
  kind: 'ridged' | 'fbm' | 'billow'
  amplitude: number
  /** Cycles per metre for the first octave. */
  baseFreq: number
  octaves: number
  lacunarity: number
  gain: number
  /** Domain warp strength in metres — breaks up the grid-aligned look of raw fbm. */
  warp: number
  /** Fraction of the height range that is water. 0 = dry biome. */
  waterFrac: number
  /** Number of terrace steps, 0 = smooth. */
  terrace: number
  /** Pull the map into islands with a radial falloff. */
  islands: boolean
  /** Exponent applied to the normalised field. >1 flattens lowlands, sharpens peaks. */
  curve: number
}

const SHAPES: Record<BiomeId, BiomeShape> = {
  alpine: {
    kind: 'ridged',
    amplitude: 820,
    baseFreq: 1 / 2600,
    octaves: 5,
    lacunarity: 2.05,
    gain: 0.5,
    warp: 240,
    waterFrac: 0.04,
    terrace: 0,
    islands: false,
    curve: 1.5,
  },
  mesa: {
    kind: 'fbm',
    amplitude: 520,
    baseFreq: 1 / 2200,
    octaves: 5,
    lacunarity: 2.1,
    gain: 0.48,
    warp: 180,
    // A trace of water, so the deepest basins hold a playa. Even a desert reads
    // better with something reflective in it.
    waterFrac: 0.03,
    terrace: 7,
    islands: false,
    curve: 1.35,
  },
  coastal: {
    kind: 'fbm',
    amplitude: 640,
    baseFreq: 1 / 2400,
    octaves: 5,
    lacunarity: 2.0,
    gain: 0.52,
    warp: 300,
    waterFrac: 0.3,
    terrace: 0,
    islands: false,
    curve: 1.8,
  },
  valley: {
    kind: 'billow',
    amplitude: 560,
    baseFreq: 1 / 2100,
    octaves: 5,
    lacunarity: 2.0,
    gain: 0.5,
    warp: 260,
    waterFrac: 0.08,
    terrace: 0,
    islands: false,
    curve: 1.1,
  },
  volcanic: {
    kind: 'ridged',
    amplitude: 700,
    baseFreq: 1 / 1900,
    octaves: 5,
    lacunarity: 2.2,
    gain: 0.46,
    warp: 200,
    waterFrac: 0.05,
    terrace: 0,
    islands: false,
    curve: 1.9,
  },
  archipelago: {
    kind: 'fbm',
    amplitude: 480,
    baseFreq: 1 / 1500,
    octaves: 5,
    lacunarity: 2.1,
    gain: 0.5,
    warp: 220,
    waterFrac: 0.42,
    terrace: 0,
    islands: true,
    curve: 1.6,
  },
}

export function generateHeightfield(biome: BiomeId, rng: Rng): Heightfield {
  const shape = SHAPES[biome]
  const base = new Noise2D(rng)
  const warpA = new Noise2D(rng)
  const warpB = new Noise2D(rng)

  const opts: FbmOptions = {
    octaves: shape.octaves,
    frequency: shape.baseFreq,
    lacunarity: shape.lacunarity,
    gain: shape.gain,
  }
  const warpOpts: FbmOptions = { octaves: 3, frequency: shape.baseFreq * 0.7, lacunarity: 2, gain: 0.5 }

  const seg = TERRAIN_SEG
  const n = seg + 1
  const cell = WORLD_SIZE / seg
  const data = new Float32Array(n * n)

  // Seeded offset so the same biome on two different days is a different place.
  const ox = rng() * 20000 - 10000
  const oz = rng() * 20000 - 10000

  let min = Infinity
  let max = -Infinity

  for (let iz = 0; iz < n; iz++) {
    const z = -HALF_WORLD + iz * cell
    for (let ix = 0; ix < n; ix++) {
      const x = -HALF_WORLD + ix * cell

      const wx = x + ox
      const wz = z + oz
      const dx = fbm(warpA, wx, wz, warpOpts) * shape.warp
      const dz = fbm(warpB, wx, wz, warpOpts) * shape.warp
      const px = wx + dx
      const pz = wz + dz

      let h: number
      switch (shape.kind) {
        case 'ridged':
          h = ridged(base, px, pz, opts)
          break
        case 'billow':
          h = billow(base, px, pz, opts)
          break
        default:
          h = fbm(base, px, pz, opts)
      }

      // to 0..1
      let t = clamp01(h * 0.5 + 0.5)
      t = Math.pow(t, shape.curve)

      if (shape.islands) {
        // A gentle radial bias, not a hard cone: at this map size a strong falloff
        // makes a single continent instead of an archipelago. The island shapes
        // come from the noise and the water level.
        const r = Math.sqrt(x * x + z * z) / HALF_WORLD
        t *= clamp01(1.35 - r * 0.8)
        t = clamp01(t * 1.65 - 0.14)
      }

      if (shape.terrace > 0) {
        const s = t * shape.terrace
        const fl = Math.floor(s)
        const fr = s - fl
        t = (fl + smoothstep(0.32, 0.68, fr)) / shape.terrace
      }

      // Soften the outer border so the map does not end in a cliff wall.
      const edge = borderMask(x, z)
      t *= edge

      const y = t * shape.amplitude
      data[iz * n + ix] = y
      if (y < min) min = y
      if (y > max) max = y
    }
  }

  const hasWater = shape.waterFrac > 0
  const waterLevel = hasWater ? min + (max - min) * shape.waterFrac : min - 1

  return { size: WORLD_SIZE, seg, cell, data, min, max, waterLevel, hasWater }
}

function borderMask(x: number, z: number): number {
  const fx = Math.abs(x) / HALF_WORLD
  const fz = Math.abs(z) / HALF_WORLD
  const f = Math.max(fx, fz)
  return 1 - smoothstep(0.86, 1.0, f) * 0.92
}

/** Bilinear height sample. Clamps outside the map rather than throwing. */
export function sampleHeight(hf: Heightfield, x: number, z: number): number {
  const n = hf.seg + 1
  const fx = clamp((x + HALF_WORLD) / hf.cell, 0, hf.seg - 1e-4)
  const fz = clamp((z + HALF_WORLD) / hf.cell, 0, hf.seg - 1e-4)
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const tx = fx - ix
  const tz = fz - iz
  const i = iz * n + ix
  const h00 = hf.data[i]
  const h10 = hf.data[i + 1]
  const h01 = hf.data[i + n]
  const h11 = hf.data[i + n + 1]
  const a = h00 + (h10 - h00) * tx
  const b = h01 + (h11 - h01) * tx
  return a + (b - a) * tz
}

/** Terrain gradient (dh/dx, dh/dz) by central difference. Drives ridge lift. */
export function sampleGradient(hf: Heightfield, x: number, z: number, out: { x: number; z: number }) {
  const d = hf.cell
  out.x = (sampleHeight(hf, x + d, z) - sampleHeight(hf, x - d, z)) / (2 * d)
  out.z = (sampleHeight(hf, x, z + d) - sampleHeight(hf, x, z - d)) / (2 * d)
  return out
}

/** Surface height for collision — the water plane counts as ground. */
export function surfaceHeight(hf: Heightfield, x: number, z: number): number {
  const h = sampleHeight(hf, x, z)
  return hf.hasWater && h < hf.waterLevel ? hf.waterLevel : h
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v: number) => clamp(v, 0, 1)

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
