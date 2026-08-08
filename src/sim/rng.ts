/**
 * Deterministic PRNG. Same seed, same world, on every device.
 * mulberry32 — 32-bit state, no dependence on Math.random or platform float quirks
 * beyond IEEE-754 doubles, which is what determinism across browsers needs.
 */
export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash a string to a 32-bit seed (FNV-1a), so biome names etc. can seed streams. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export const randRange = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo)
export const randInt = (rng: Rng, lo: number, hi: number) => Math.floor(randRange(rng, lo, hi + 1))
export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length]
