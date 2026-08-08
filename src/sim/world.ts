import { Vector3 } from 'three'
import { mulberry32, hashSeed, randRange, type Rng } from './rng'
import { BIOME_ORDER, buildPalette, type BiomeId, type Palette } from './palette'
import { generateHeightfield, sampleHeight, surfaceHeight, HALF_WORLD, type Heightfield } from './terrain'
import { generateAir, type Air } from './air'
import { TUNING } from './tuning'
import type { LaunchSite } from './flight'

/** Day 0. Everything downstream is `days since this date, in Los Angeles`. */
const EPOCH = '2026-01-01'

export interface World {
  day: number
  seed: number
  biome: BiomeId
  palette: Palette
  heightfield: Heightfield
  air: Air
  launch: LaunchSite
  /** Unit vector pointing at the sun. Low, for long shadows and rim light. */
  sunDir: Vector3
}

export function dayNumber(now: Date = new Date()): number {
  return laDayIndex(now) - isoDayIndex(EPOCH)
}

function laDayIndex(now: Date): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return isoDayIndex(fmt.format(now))
}

function isoDayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000)
}

export function buildWorld(day: number): World {
  const seed = hashSeed(`paper-trail/${day}`)
  const rng = mulberry32(seed)

  // A strict rotation, so consecutive days are guaranteed to be different biomes.
  // The seed still decides the palette, the terrain, and where in the biome you are.
  const n = BIOME_ORDER.length
  const biome = BIOME_ORDER[((day % n) + n) % n]

  const palette = buildPalette(biome, rng)
  const heightfield = generateHeightfield(biome, rng)
  const air = generateAir(heightfield, rng)
  const launch = findLaunchSite(heightfield, air, rng)

  const sunAz = randRange(rng, 0, Math.PI * 2)
  const sunEl = randRange(rng, 0.16, 0.42) // ~9 to 24 degrees. Always a low sun.
  const sunDir = new Vector3(
    Math.cos(sunAz) * Math.cos(sunEl),
    Math.sin(sunEl),
    Math.sin(sunAz) * Math.cos(sunEl),
  ).normalize()

  return { day, seed, biome, palette, heightfield, air, launch, sunDir }
}

/** Yaw that points the aircraft's nose along (dx, dz). Forward is -Z. */
export const headingFromDir = (dx: number, dz: number) => Math.atan2(-dx, -dz)

/**
 * Choose where the flight starts. The job here is not to find the most dramatic
 * peak — it is to make altitude scarce from the first second.
 *
 * An earlier version scored candidates as `height - heightAhead`, which picked a
 * summit with a valley in front of it. That made the ground fall away faster than
 * the aircraft sank, so a hands-off glide crossed the map and the lift in the air
 * was decoration. Now the release height is measured against the terrain *ahead*,
 * a drop in front earns nothing, and a reachable thermal is a scoring term. The
 * opening glide is a decision: which column do I go for?
 *
 * It scans the whole map rather than a disc in the upwind quarter: on the
 * archipelago and coastal biomes that quarter is frequently all ocean, and a
 * search that can come up empty will eventually hand somebody a day that starts
 * in the sea.
 */
function findLaunchSite(hf: Heightfield, air: Air, rng: Rng): LaunchSite {
  const dx = Math.cos(air.windDir)
  const dz = Math.sin(air.windDir)
  const dryFloor = hf.hasWater ? hf.waterLevel + 25 : -Infinity

  let bestX = 0
  let bestZ = 0
  let bestRoute = 0
  let bestScore = -Infinity
  let fallbackX = 0
  let fallbackZ = 0
  let fallbackH = -Infinity

  const STEPS = 72
  const reach = HALF_WORLD * 0.9
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
      if (h < dryFloor) continue

      // Terrain along the downwind route. This, not the height of the launch peak,
      // is what the glide has to clear.
      //
      // Sampled out to 3.4 km, because that is how far a good flight actually
      // travels. A short horizon misses the case that was giving away the game:
      // a summit that is level with the next ridge but sits at the head of a range
      // descending 700 m over the following three kilometres. Locally it scores as
      // flat; in practice it is a free ramp.
      // surfaceHeight, not sampleHeight: over water the heightfield holds the
      // seabed, which is well below the surface the aircraft actually has to clear.
      // Reading the seabed made `route` too low on the coastal and archipelago
      // biomes, which pushed the release height up and handed back exactly the free
      // altitude this function exists to take away.
      let route = 0
      let routeMin = Infinity
      for (let k = 1; k <= ROUTE_SAMPLES; k++) {
        const d = k * ROUTE_STEP
        const rh = surfaceHeight(hf, clampWorld(x + dx * d), clampWorld(z + dz * d))
        route += rh
        if (rh < routeMin) routeMin = rh
      }
      route /= ROUTE_SAMPLES
      const routeDrop = Math.max(0, h - routeMin)

      // Local prominence — is this a ridge or a peak, rather than a spot in the
      // middle of a slope? A prominent launch has ridge lift on tap right away.
      let around = 0
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        around += sampleHeight(hf, clampWorld(x + Math.cos(a) * 380), clampWorld(z + Math.sin(a) * 380))
      }
      const prominence = h - around / 6

      // Sitting upwind puts the whole map ahead of the flight.
      const upwind = -(x * dx + z * dz) / HALF_WORLD

      // The first thermal has to be inside the opening glide, or the day is a
      // coin flip. Score the best forward-arc column by how comfortably it is
      // reachable from the release height.
      let reachability = -400
      for (const t of air.thermals) {
        const tx = t.x - x
        const tz = t.z - z
        const range = Math.hypot(tx, tz)
        if (range < 200) continue
        // Only count columns roughly ahead: dot > 0.35 is about a 140-degree arc.
        if ((tx * dx + tz * dz) / range < 0.35) continue
        const needed = range / GLIDE_RATIO
        const slack = TUNING.launchAboveRoute - needed - (t.base - route)
        if (slack > reachability) reachability = slack
      }

      const score =
        prominence * 1.1 +
        upwind * 300 +
        Math.min(reachability, 120) * 1.4 +
        // The term that actually makes altitude scarce: every metre the route
        // drops below the launch is a metre the player gets to spend without
        // earning it, so pay it back almost one for one.
        -routeDrop * 0.9 +
        // A mild preference for higher ground, so launches are not in a basin.
        h * 0.15
      if (score > bestScore) {
        bestScore = score
        bestX = x
        bestZ = z
        bestRoute = route
      }
    }
  }

  if (bestScore === -Infinity) {
    bestX = fallbackX
    bestZ = fallbackZ
    bestRoute = fallbackH
  }

  // Release height is measured against the terrain *ahead*, not the ground below.
  // That is the whole trick: on a route that falls away, this gives back nothing,
  // so a launch peak with a valley in front of it is no longer free distance.
  // surfaceHeight, not sampleHeight: on a flooded map the water is the floor.
  const groundH = surfaceHeight(hf, bestX, bestZ)
  const y = Math.max(groundH + TUNING.launchMinClearance, bestRoute + TUNING.launchAboveRoute)

  const jitter = randRange(rng, -0.12, 0.12)
  return {
    pos: new Vector3(bestX, y, bestZ),
    heading: headingFromDir(dx, dz) + jitter,
  }
}

/**
 * Conservative still-air glide ratio, used only for launch-site reachability
 * scoring. Kept deliberately pessimistic so the opening glide is comfortable
 * even on a day whose first leg runs into sink.
 */
const GLIDE_RATIO = 4.6

/** Route samples — 12 at 480 m spacing reaches 5.8 km, about a good flight's length. */
const ROUTE_SAMPLES = 12
const ROUTE_STEP = 480

const clampWorld = (v: number) => Math.max(-HALF_WORLD * 0.95, Math.min(HALF_WORLD * 0.95, v))
