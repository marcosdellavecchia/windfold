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

export function generateAir(hf: Heightfield, rng: Rng): Air {
  const windDir = rng() * Math.PI * 2
  // Deliberately gentle relative to a 21 m/s glider. A stronger wind drifts a
  // circling aircraft out of any ground-anchored thermal faster than it can
  // climb, which reads as "thermals are broken". RIDGE_GAIN carries the slope
  // lift that the weaker wind would otherwise lose.
  const windSpeed = randRange(rng, 2, 5.5)

  const thermals: Thermal[] = []
  let guard = 0
  while (thermals.length < THERMAL_COUNT && guard++ < 4000) {
    const x = randRange(rng, -HALF_WORLD * 0.88, HALF_WORLD * 0.88)
    const z = randRange(rng, -HALF_WORLD * 0.88, HALF_WORLD * 0.88)
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
      strength: randRange(rng, 7, 13),
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
