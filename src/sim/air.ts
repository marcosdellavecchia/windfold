import { sampleGradient, sampleHeight, smoothstep, clamp01, HALF_WORLD, type Heightfield } from './terrain'
import { randRange, type Rng } from './rng'

export interface Thermal {
  x: number
  z: number
  radius: number
  /** Peak core climb rate, m/s. */
  strength: number
  /** Altitude at which the column dies out. */
  top: number
  /** Terrain height under the column, cached. */
  base: number
}

export interface Air {
  /** Horizontal wind at reference altitude, m/s. */
  windX: number
  windZ: number
  windSpeed: number
  windDir: number
  thermals: Thermal[]
  /** Ambient sink, m/s. Makes lift worth hunting for. */
  sink: number
  refAlt: number
  /**
   * Condensation level for the day — where cumulus sits. One altitude for the whole
   * map, as in a real sky, rather than each column topping out at its own height.
   * Every cloud marks a thermal, which makes "fly to the cloud" a rule the player
   * can learn in one flight without being told.
   */
  cloudBase: number
}

export interface Vec3Like {
  x: number
  y: number
  z: number
}

const RIDGE_GAIN = 2.7
const RIDGE_DECAY = 220 // metres above terrain
// Scaled with the map area so column density stays what it was tuned to be at
// 6 km: roughly one per 2.7 km^2.
const THERMAL_COUNT = 48

/**
 * `vent`, when present, is the volcanic landmark: a permanent thermal is seeded
 * at it before the natural columns are drawn. It goes in first so the existing
 * separation test keeps natural columns off it, and it draws nothing from `rng`,
 * so days without a vent are untouched byte for byte.
 */
export function generateAir(hf: Heightfield, rng: Rng, vent?: { x: number; z: number }): Air {
  const windDir = rng() * Math.PI * 2
  // Deliberately gentle relative to a 21 m/s glider. A stronger wind drifts a
  // circling aircraft out of any ground-anchored thermal faster than it can
  // climb, which reads as "thermals are broken". RIDGE_GAIN carries the slope
  // lift that the weaker wind would otherwise lose.
  const windSpeed = randRange(rng, 2, 5.5)

  // Flat country is the failure mode of this game's air: ridge lift is
  // `wind · ∇terrain`, so ground with no gradient has none, and a day that is all
  // ambient sink is a day with no decisions in it. Real flat country compensates
  // the same way this does — convection organizes into streets, rows of thermals
  // aligned downwind. Below ~520 m of relief the columns start snapping to a
  // street lattice, and by ~200 m (a field day) the organization is total: the
  // sky becomes rows of cumulus and the game becomes "pick a street and run it".
  // Driven by measured relief rather than by biome, so a flat plain-landform day
  // in any biome gets the same rescue.
  const relief = hf.max - hf.min
  const street = clamp01((520 - relief) / 320)
  const streetSpacing = randRange(rng, 1400, 2000)
  const streetPhase = randRange(rng, 0, streetSpacing)
  // Skewed 20-35 degrees off the wind, and not because real streets are — real
  // streets run dead downwind. So does the launch heading, and a lift corridor
  // laid under the opening glide is a free ride: the first downwind-aligned build
  // of this handed a hands-off flight 6.1 km, 3x the tuning target. At this angle
  // a hands-off glide falls out of its street inside a kilometre, while a player
  // who banks to track the line keeps it. The skew is what makes the street a
  // skill rather than a ramp.
  const streetDir = windDir + (rng() < 0.5 ? 1 : -1) * randRange(rng, 0.35, 0.6)
  // Unit vector across the streets: the coordinate they are spaced along.
  const crossX = -Math.sin(streetDir)
  const crossZ = Math.cos(streetDir)

  // More columns on organized days — streets concentrate lift into lines, which
  // leaves the ground between them emptier than a random scatter would be, and
  // a chosen street has to be able to carry a whole flight.
  const target = Math.round(THERMAL_COUNT * (1 + street * 0.5))

  const thermals: Thermal[] = []
  if (vent) {
    const base = sampleHeight(hf, vent.x, vent.z)
    thermals.push({
      x: vent.x,
      z: vent.z,
      // Wider and stronger than anything the natural ranges (260-460 m, 7-13 m/s)
      // can roll, and taller than the 520-980 m natural tops: the vent is the
      // day's landmark, and the lift is what makes it worth flying to rather
      // than just looking at. It sits on the map's summit, so it is also the
      // highest climb available — the reward for reaching the most visible
      // point on a volcanic day.
      radius: 500,
      strength: 14,
      top: base + 1200,
      base,
    })
  }
  let guard = 0
  while (thermals.length < target && guard++ < 6000) {
    let x = randRange(rng, -HALF_WORLD * 0.88, HALF_WORLD * 0.88)
    let z = randRange(rng, -HALF_WORLD * 0.88, HALF_WORLD * 0.88)
    if (rng() < street) {
      const cross = crossX * x + crossZ * z
      const snapped = Math.round((cross - streetPhase) / streetSpacing) * streetSpacing + streetPhase
      const shift = snapped - cross + randRange(rng, -150, 150)
      x += crossX * shift
      z += crossZ * shift
      if (Math.abs(x) > HALF_WORLD * 0.88 || Math.abs(z) > HALF_WORLD * 0.88) continue
    }
    const base = sampleHeight(hf, x, z)
    // Thermals form over sun-warmed ground, not over water.
    if (hf.hasWater && base < hf.waterLevel + 20) continue
    if (thermals.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 1250 ** 2)) continue
    // Wide on purpose. The columns are anchored to the ground they rise from, but
    // an aircraft circling in them is carried downwind at the wind speed — a 30 s
    // climb drifts 150 m. A core smaller than that is one the player experiences
    // as "thermals don't work" rather than as a centring problem.
    const radius = randRange(rng, 260, 460)
    thermals.push({
      x,
      z,
      radius,
      // A modest boost where streets are organized — flat ground has no ridge
      // lift to fall back on, so the columns carry the whole day.
      strength: randRange(rng, 7, 13) * (1 + street * 0.2),
      top: base + randRange(rng, 520, 980),
      base,
    })
  }

  const cloudBase =
    thermals.length > 0
      ? thermals.reduce((sum, t) => sum + t.top, 0) / thermals.length
      : hf.max + 600

  return {
    windDir,
    windSpeed,
    windX: Math.cos(windDir) * windSpeed,
    windZ: Math.sin(windDir) * windSpeed,
    thermals,
    // Ambient sink between the lift. This, rather than aircraft drag, is what
    // keeps a hands-off glide short: raising drag instead would also eat the
    // energy of a dive, and diving to build speed is the skill the game is about.
    //
    // Paired with strong, sparse cores it also sets the rhythm of the game —
    // mostly descending, occasionally climbing hard — so arriving at a column low
    // is the normal state rather than a mistake.
    sink: 2.0,
    refAlt: hf.max,
    cloudBase,
  }
}

const grad = { x: 0, z: 0 }

/**
 * Air velocity at a point: seeded wind, ridge lift off windward slopes,
 * thermal columns, and a little ambient sink between them.
 */
export function sampleAir(air: Air, hf: Heightfield, x: number, y: number, z: number, out: Vec3Like): Vec3Like {
  // Mild altitude gradient: it blows a bit harder up high.
  const altScale = 1 + clamp01(y / Math.max(air.refAlt, 1)) * 0.35
  const wx = air.windX * altScale
  const wz = air.windZ * altScale

  const ground = sampleHeight(hf, x, z)
  const agl = y - ground

  let wy = -air.sink

  // Ridge lift: air deflected up a windward slope. w = V . grad(h), decaying with
  // height above the surface.
  //
  // The dot product is unbounded — an alpine face can have a gradient of 3, which
  // would turn a 5 m/s breeze into 40 m/s of free climb and let a hands-off glider
  // ride the range forever. Real deflected air cannot rise much faster than the
  // wind that is driving it, so cap both directions against the wind speed.
  if (agl < RIDGE_DECAY * 3.5) {
    sampleGradient(hf, x, z, grad)
    const slopeLift = wx * grad.x + wz * grad.z
    const decay = Math.exp(-Math.max(agl, 0) / RIDGE_DECAY)
    const cap = air.windSpeed * altScale
    if (slopeLift > 0) {
      wy += Math.min(slopeLift * RIDGE_GAIN, cap * 1.3) * decay
    } else {
      // Lee-side sink, weaker than the lift so ridges are net-positive to work.
      wy += Math.max(slopeLift * 0.7, -cap * 0.8) * decay
    }
  }

  // Thermals.
  for (let i = 0; i < air.thermals.length; i++) {
    const t = air.thermals[i]
    const dx = x - t.x
    const dz = z - t.z
    const r2 = dx * dx + dz * dz
    const outer = t.radius * 1.9
    if (r2 > outer * outer) continue
    if (y > t.top || y < t.base) continue

    const core = Math.exp(-r2 / (t.radius * t.radius))
    // Ring of compensating sink outside the core — rewards centring the turn.
    const r = Math.sqrt(r2)
    const ring = smoothstep(t.radius * 1.05, t.radius * 1.4, r) * (1 - smoothstep(t.radius * 1.55, outer, r))

    const topFade = 1 - smoothstep(t.top - 260, t.top, y)
    const baseFade = smoothstep(t.base, t.base + 60, y)

    wy += t.strength * core * topFade * baseFade
    wy -= t.strength * 0.22 * ring * topFade
  }

  out.x = wx
  out.y = wy
  out.z = wz
  return out
}
