import type { Rng } from './rng'

/**
 * Seeded 2D gradient (Perlin) noise. Gradient rather than value noise because
 * ridged fbm — which is where the alpine and volcanic biomes get their spines —
 * looks mushy on value noise.
 */
export class Noise2D {
  private perm = new Uint8Array(512)
  private gx = new Float32Array(256)
  private gy = new Float32Array(256)

  constructor(rng: Rng) {
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    // Fisher-Yates with the seeded stream
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
    for (let i = 0; i < 256; i++) {
      const a = rng() * Math.PI * 2
      this.gx[i] = Math.cos(a)
      this.gy[i] = Math.sin(a)
    }
  }

  /** Returns roughly [-1, 1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const X = xi & 255
    const Y = yi & 255

    const u = fade(xf)
    const v = fade(yf)

    const aa = this.perm[X + this.perm[Y]]
    const ab = this.perm[X + this.perm[Y + 1]]
    const ba = this.perm[X + 1 + this.perm[Y]]
    const bb = this.perm[X + 1 + this.perm[Y + 1]]

    const n00 = this.gx[aa] * xf + this.gy[aa] * yf
    const n10 = this.gx[ba] * (xf - 1) + this.gy[ba] * yf
    const n01 = this.gx[ab] * xf + this.gy[ab] * (yf - 1)
    const n11 = this.gx[bb] * (xf - 1) + this.gy[bb] * (yf - 1)

    const x1 = n00 + u * (n10 - n00)
    const x2 = n01 + u * (n11 - n01)
    return (x1 + v * (x2 - x1)) * 1.4
  }
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

export interface FbmOptions {
  octaves: number
  frequency: number
  lacunarity: number
  gain: number
}

export function fbm(n: Noise2D, x: number, y: number, o: FbmOptions): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = o.frequency
  for (let i = 0; i < o.octaves; i++) {
    sum += n.noise(x * f, y * f) * amp
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return sum / norm
}

/** Ridged multifractal — sharp crests, rounded valleys. The alpine look. */
export function ridged(n: Noise2D, x: number, y: number, o: FbmOptions): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = o.frequency
  for (let i = 0; i < o.octaves; i++) {
    const v = 1 - Math.abs(n.noise(x * f, y * f))
    sum += v * v * amp
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return (sum / norm) * 2 - 1
}

/** Billow — rounded lumps, the inverse feel of ridged. Forested valleys. */
export function billow(n: Noise2D, x: number, y: number, o: FbmOptions): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = o.frequency
  for (let i = 0; i < o.octaves; i++) {
    sum += Math.abs(n.noise(x * f, y * f)) * amp
    norm += amp
    amp *= o.gain
    f *= o.lacunarity
  }
  return (sum / norm) * 2 - 1
}
