import { mulberry32 } from './rng'
import { sampleGradient, sampleHeight, HALF_WORLD, type Heightfield } from './terrain'
import type { BiomeId } from './palette'

/**
 * The day's landmark: one built (or in the vent's case, geological) object placed
 * once somewhere on the map.
 *
 * Terrain gives a day its character but not a *place* — nothing on a procedural
 * heightfield has a name or a direction. One landmark fixes that: it is the point
 * players mention when they compare flights ("out past the lighthouse"), and
 * where a kind can carry information it does. The vent's smoke leans downwind,
 * and the vent also anchors a strong permanent thermal, so the most visible
 * point on a volcanic map is also the best lift on it.
 *
 * Every biome has exactly one kind. The four quieter ones are pure places — a
 * cross marking the summit, an arch worth flying through, a bridge over the
 * day's river, a wreck in the shallows — with no flight-model side effects.
 */
export type LandmarkKind = 'lighthouse' | 'vent' | 'cross' | 'arch' | 'bridge' | 'wreck'

export interface Landmark {
  kind: LandmarkKind
  x: number
  z: number
  /** Terrain height under the site — the physics surface, not the drawn one. */
  y: number
  /**
   * Yaw, in three.js rotation.y terms, for kinds with a meaningful facing:
   * the bridge lies across its river, the arch and wreck take a seeded one.
   * Absent for the radially symmetric kinds.
   */
  heading?: number
}

const KINDS: Record<BiomeId, LandmarkKind> = {
  alpine: 'cross',
  mesa: 'arch',
  coastal: 'lighthouse',
  valley: 'bridge',
  volcanic: 'vent',
  archipelago: 'wreck',
}

/** What the share card calls each kind — the phrase a day gets known by. */
export const LANDMARK_NAMES: Record<LandmarkKind, string> = {
  lighthouse: 'lighthouse',
  vent: 'smoking vent',
  cross: 'summit cross',
  arch: 'rock arch',
  bridge: 'stone bridge',
  wreck: 'shipwreck',
}

/**
 * Sites are scored on the same whole-map grid the launch search uses, and for the
 * same reason it gave up on searching a subregion: a search that can come up
 * empty will eventually hand somebody a broken day. A fallback site is tracked
 * unconditionally, so even a coastal day whose land never passes the headland
 * test still gets its lighthouse somewhere sane.
 */
const STEPS = 72
/**
 * Slightly inside the launch search's 0.9: a landmark at the map edge is half
 * outside the playable air (the flight ends at 0.985 of half-world), and unlike a
 * launch site it exists to be flown past.
 */
const EDGE = 0.85

/** Probes for the lighthouse's around-the-point ring. */
const RING = 8
const RING_R = 240

/**
 * How far below the single best score a site may sit and still be drawn. This is
 * where the day-to-day variety comes from: terrain usually offers several
 * headlands or crests within a few points of each other, and the seeded pick
 * among them moves the landmark around even between similar maps. No entries for
 * the summit kinds (vent, cross) — their site is the summit, exactly, found by
 * their own vertex scan — or for the bridge, whose channel scan has its own
 * margin in `wet` units.
 */
const TIE_MARGIN: Record<Exclude<LandmarkKind, 'vent' | 'cross' | 'bridge'>, number> = {
  lighthouse: 25,
  arch: 10,
  wreck: 1.5,
}

/** See TIE_MARGIN — the bridge equivalent, in units of the drainage field. */
const BRIDGE_MARGIN = 0.08

/**
 * The minor tier: two to four small, unnamed curiosities per map.
 *
 * The day's landmark is a destination — you plan a leg around it and it goes
 * on the share card. These are the opposite, and the map needs both: things
 * you were not looking for and pass anyway. A cairn on a shoulder you happen
 * to skim, standing stones in a meadow you only see because you were low, a
 * buoy that tells you the water below you has a shore somewhere. None of them
 * is worth a detour, which is exactly what makes finding one feel like
 * *finding* rather than arriving.
 *
 * They are deliberately not named, not scored, not on the card and not in the
 * HUD. A landscape with two kinds of place in it reads as a place; a landscape
 * where everything is a waypoint reads as a checklist.
 */
export type MinorKind = 'cairn' | 'stones' | 'fumarole' | 'buoy' | 'spring'

export interface MinorLandmark {
  kind: MinorKind
  x: number
  z: number
  y: number
  heading: number
  /** Per-instance size, so two cairns on one map are not the same cairn. */
  scale: number
}

/**
 * Two kinds per biome, drawn per instance. One kind per biome made every
 * minor landmark on a map the same object at different sizes, which is scatter
 * rather than curiosity.
 */
const MINOR_KINDS: Record<BiomeId, MinorKind[]> = {
  alpine: ['cairn', 'stones'],
  mesa: ['stones', 'cairn'],
  coastal: ['buoy', 'cairn'],
  valley: ['stones', 'spring'],
  volcanic: ['fumarole', 'spring'],
  archipelago: ['buoy', 'cairn'],
}

/** Coarser than the landmark grid: these are small and want no precision. */
const MINOR_STEPS = 48
/**
 * Nothing minor stands within this of the day's landmark or of another minor
 * one. A curiosity beside the monument is part of the monument, and two of
 * them together are a settlement — both read as intent, which is the one thing
 * these must never read as.
 */
const MINOR_APART = 1100

export function placeMinorLandmarks(
  biome: BiomeId,
  hf: Heightfield,
  seed: number,
  main: Landmark,
): MinorLandmark[] {
  // Its own stream, like the landmark's, and for the same reason: a draw taken
  // from the world's rng here would regenerate every historical day.
  const rng = mulberry32(seed ^ 0x2b7f)
  const kinds = MINOR_KINDS[biome]
  const count = 2 + Math.floor(rng() * 3)
  const reach = HALF_WORLD * EDGE
  const grad = { x: 0, z: 0 }
  const water = hf.hasWater ? hf.waterLevel : -Infinity

  /** -Infinity for ground this kind cannot stand on; higher is a better site. */
  const score = (kind: MinorKind, x: number, z: number, h: number): number => {
    const t = (h - hf.min) / Math.max(hf.max - hf.min, 1)
    if (kind === 'buoy') {
      // Moored water: deep enough to float a buoy, shallow enough to be worth
      // marking, and with land somewhere close — a buoy in the middle of the
      // ocean marks nothing.
      if (!hf.hasWater) return -Infinity
      const depth = water - h
      if (depth < 4 || depth > 45) return -Infinity
      let land = 0
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        if (sampleHeight(hf, x + Math.cos(a) * 420, z + Math.sin(a) * 420) > water) land++
      }
      return land > 0 ? 40 - Math.abs(depth - 14) : -Infinity
    }

    if (h < water + 5) return -Infinity
    sampleGradient(hf, x, z, grad)
    const slope = Math.hypot(grad.x, grad.z)

    switch (kind) {
      case 'cairn': {
        // A shoulder or a minor top — high ground that is not the summit, since
        // the summit is where the alpine day's own landmark already stands.
        if (t < 0.45 || slope > 0.3) return -Infinity
        let around = 0
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2
          around += sampleHeight(hf, x + Math.cos(a) * 260, z + Math.sin(a) * 260)
        }
        return h - around / 6
      }
      case 'stones':
        // Flat open ground, low to middling: a meadow, a bench, a pan.
        if (t < 0.08 || t > 0.65 || slope > 0.09) return -Infinity
        return 10 - slope * 60
      case 'fumarole':
        // Upper slopes, where a volcanic map's heat would actually vent.
        if (t < 0.35 || slope > 0.36) return -Infinity
        return t * 10
      case 'spring':
        // The flattest low ground there is — a pool has to sit level.
        if (t > 0.45 || slope > 0.07) return -Infinity
        return 10 - slope * 80
      default:
        return -Infinity
    }
  }

  const out: MinorLandmark[] = []
  const farEnough = (x: number, z: number) => {
    if (Math.hypot(x - main.x, z - main.z) < MINOR_APART) return false
    return out.every((m) => Math.hypot(x - m.x, z - m.z) >= MINOR_APART)
  }

  for (let n = 0; n < count; n++) {
    const kind = kinds[Math.floor(rng() * kinds.length) % kinds.length]
    // Every site that clears the gate and the spacing, then a seeded pick —
    // the same shape as the landmark search, without the tie margin, because
    // for these the variety *is* the point and the best site is not.
    const xs: number[] = []
    const zs: number[] = []
    for (let i = 0; i <= MINOR_STEPS; i++) {
      for (let j = 0; j <= MINOR_STEPS; j++) {
        const x = -reach + (i / MINOR_STEPS) * reach * 2
        const z = -reach + (j / MINOR_STEPS) * reach * 2
        if (score(kind, x, z, sampleHeight(hf, x, z)) > -Infinity && farEnough(x, z)) {
          xs.push(x)
          zs.push(z)
        }
      }
    }
    // A day whose terrain offers this kind nowhere simply has one fewer. There
    // is no fallback on purpose: a cairn dumped on the one cell that scored
    // -Infinity least is the kind of thing that ends up floating in a lake.
    if (xs.length === 0) continue
    const at = Math.floor(rng() * xs.length) % xs.length
    const jx = xs[at] + (rng() * 2 - 1) * 70
    const jz = zs[at] + (rng() * 2 - 1) * 70
    const ok = score(kind, jx, jz, sampleHeight(hf, jx, jz)) > -Infinity
    const x = ok ? jx : xs[at]
    const z = ok ? jz : zs[at]
    out.push({
      kind,
      x,
      z,
      y: sampleHeight(hf, x, z),
      heading: rng() * Math.PI * 2,
      scale: 0.8 + rng() * 0.5,
    })
  }
  return out
}

export function placeLandmark(biome: BiomeId, hf: Heightfield, seed: number): Landmark {
  const kind = KINDS[biome]

  // A private stream, never the world's. buildWorld threads one rng through
  // terrain, air and launch in a fixed order, so a single draw inserted there
  // would silently regenerate every historical day. This stream costs nothing.
  const rng = mulberry32(seed ^ 0x1a0d)

  // The summit kinds sit on the highest point of the map, exactly — for the
  // vent that is where a vent belongs (on a caldera day, the rim), for the
  // cross it is the whole point of a summit cross. The candidate grid below
  // samples every ~143 m, and on a ridged peak that misses the top by tens of
  // metres (measured: 55 m on one sweep day), with the landmark visibly hanging
  // off the summit. So these skip the grid and read the vertices directly.
  if (kind === 'vent' || kind === 'cross') {
    const n = hf.seg + 1
    const lim = HALF_WORLD * EDGE
    let bx = 0
    let bz = 0
    let bh = -Infinity
    for (let iz = 0; iz < n; iz++) {
      const z = -HALF_WORLD + iz * hf.cell
      if (z < -lim || z > lim) continue
      for (let ix = 0; ix < n; ix++) {
        const x = -HALF_WORLD + ix * hf.cell
        if (x < -lim || x > lim) continue
        const h = hf.data[iz * n + ix]
        if (h > bh) {
          bh = h
          bx = x
          bz = z
        }
      }
    }
    return { kind, x: bx, z: bz, y: bh }
  }

  // The bridge has to actually span the day's river, so it does not search
  // open ground at all — it searches the drainage tree the terrain already
  // computed (the same `wet`/`flowTo` the streams are drawn from), and takes
  // the strongest channel it can find above the lake. The heading is
  // perpendicular to the local flow: a bridge lies across its river.
  if (kind === 'bridge') {
    const n = hf.seg + 1
    const lim = HALF_WORLD * EDGE
    const dry = hf.hasWater ? hf.waterLevel + 4 : -Infinity

    const channel = (i: number, x: number, z: number) =>
      hf.wet[i] > 0.5 && hf.flowTo[i] >= 0 && hf.data[i] > dry && Math.abs(x) < lim && Math.abs(z) < lim

    let best = -Infinity
    for (let i = 0; i < hf.wet.length; i++) {
      const x = -HALF_WORLD + (i % n) * hf.cell
      const z = -HALF_WORLD + ((i / n) | 0) * hf.cell
      if (channel(i, x, z) && hf.wet[i] > best) best = hf.wet[i]
    }

    if (best > -Infinity) {
      const ties: number[] = []
      for (let i = 0; i < hf.wet.length; i++) {
        const x = -HALF_WORLD + (i % n) * hf.cell
        const z = -HALF_WORLD + ((i / n) | 0) * hf.cell
        if (channel(i, x, z) && hf.wet[i] >= best - BRIDGE_MARGIN) ties.push(i)
      }
      const i = ties[Math.floor(rng() * ties.length) % ties.length]
      const x = -HALF_WORLD + (i % n) * hf.cell
      const z = -HALF_WORLD + ((i / n) | 0) * hf.cell
      // Flow direction from the drainage tree: this cell to the one it drains
      // into. The deck runs perpendicular; a vector (px, pz) becomes rotation.y
      // via atan2(-pz, px), because +X rotated by yaw lands on (cos, -sin).
      const d = hf.flowTo[i]
      const fx = (d % n) - (i % n)
      const fz = ((d / n) | 0) - ((i / n) | 0)
      return { kind, x, z, y: sampleHeight(hf, x, z), heading: Math.atan2(-fx, -fz) }
    }
    // No channel anywhere (a bone-dry day): fall through to the grid scan,
    // which for the bridge degrades to "lowest open ground" — a dry gulch
    // crossing, which still reads as a place.
  }

  const reach = HALF_WORLD * EDGE
  const grad = { x: 0, z: 0 }

  const score = (x: number, z: number, h: number): number => {
    switch (kind) {
      case 'lighthouse': {
        // A headland: ground above the waterline with sea on most sides of it.
        // The ring count does the real work — prominence alone would pick any
        // inland peak, since the seabed around a point sits far below the water
        // and inflates every coastal height difference.
        if (!hf.hasWater || h < hf.waterLevel + 8) return -Infinity
        let sea = 0
        for (let k = 0; k < RING; k++) {
          const a = (k / RING) * Math.PI * 2
          if (sampleHeight(hf, x + Math.cos(a) * RING_R, z + Math.sin(a) * RING_R) < hf.waterLevel) sea++
        }
        if (sea < RING / 2) return -Infinity
        // Mostly-surrounded wins; among comparable points, prefer modest height
        // over the water — a light on a 40 m point reads better than one lost
        // halfway up a 400 m cliff face.
        return sea * 60 + Math.min(h - hf.waterLevel, 90) * 0.6
      }

      case 'arch': {
        // An open bench in the middle band of the mesa: flat enough that the
        // arch stands clear of the broken ground around it, high enough to
        // stand against the sky. The slope gate is forgiving — mesa ground is
        // nowhere truly flat.
        if (hf.hasWater && h < hf.waterLevel + 10) return -Infinity
        const t = (h - hf.min) / Math.max(hf.max - hf.min, 1)
        if (t < 0.2 || t > 0.8) return -Infinity
        sampleGradient(hf, x, z, grad)
        if (Math.hypot(grad.x, grad.z) > 0.12) return -Infinity
        let around = 0
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2
          around += sampleHeight(hf, x + Math.cos(a) * 380, z + Math.sin(a) * 380)
        }
        return h - around / 6
      }

      case 'wreck': {
        // The shallows: a hull run aground just under the surface, not a deep
        // sinking (invisible) and not beached (implausible). Peak score two
        // metres under the waterline, falling off both ways.
        if (!hf.hasWater) return -Infinity
        if (h < hf.waterLevel - 7 || h > hf.waterLevel + 1) return -Infinity
        return -Math.abs(h - (hf.waterLevel - 2))
      }

      // Only reachable on a dry valley day with no channels: lowest open
      // ground, where the river would have been.
      case 'bridge':
        return -h

      default:
        return -Infinity
    }
  }

  // Pass 1: the best score, plus the highest cell as the unconditional fallback.
  let best = -Infinity
  let fallbackX = 0
  let fallbackZ = 0
  let fallbackH = -Infinity
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const x = -reach + (i / STEPS) * reach * 2
      const z = -reach + (j / STEPS) * reach * 2
      const h = sampleHeight(hf, x, z)
      if (h > fallbackH) {
        fallbackH = h
        fallbackX = x
        fallbackZ = z
      }
      const s = score(x, z, h)
      if (s > best) best = s
    }
  }

  let x = fallbackX
  let z = fallbackZ
  if (best > -Infinity) {
    // Pass 2: gather everything within the tie margin and let the seed choose.
    // Two passes rather than one sorted list: the candidate set is tiny and this
    // keeps pass 1 allocation-free.
    const xs: number[] = []
    const zs: number[] = []
    const margin = kind === 'bridge' ? 6 : TIE_MARGIN[kind]
    const floor = best - margin
    for (let i = 0; i <= STEPS; i++) {
      for (let j = 0; j <= STEPS; j++) {
        const cx = -reach + (i / STEPS) * reach * 2
        const cz = -reach + (j / STEPS) * reach * 2
        if (score(cx, cz, sampleHeight(hf, cx, cz)) >= floor) {
          xs.push(cx)
          zs.push(cz)
        }
      }
    }
    const pickAt = Math.floor(rng() * xs.length) % xs.length
    x = xs[pickAt]
    z = zs[pickAt]

    // Off-grid jitter, so the landmark is not visibly on a 170 m lattice —
    // kept only if the jittered point still passes the kind's hard gates.
    const jx = x + (rng() * 2 - 1) * 55
    const jz = z + (rng() * 2 - 1) * 55
    if (score(jx, jz, sampleHeight(hf, jx, jz)) > -Infinity) {
      x = jx
      z = jz
    }
  }

  // The oriented kinds take a seeded facing; anything upright ignores it.
  const heading = rng() * Math.PI * 2
  return { kind, x, z, y: sampleHeight(hf, x, z), heading }
}
