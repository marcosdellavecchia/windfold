import { Flight, type FlightInput } from './flight'
import type { Thermal } from './air'
import type { World } from './world'

/**
 * The day's par: what the paper pilot scores.
 *
 * A pure distance chase has no "done" — Wordle works for casual players because
 * six rows is a completable goal, and this is that goal here. The chase autopilot
 * that already bounds each day's ceiling in the test harness flies the day once
 * at world build, and its distance is the day's par: beat the paper pilot and the
 * day is won, however far the grinders go beyond it. Par also normalises days
 * against each other — beating par by 400 m means the same thing on a mean day
 * and a monster day — which raw distance never gives.
 *
 * Deterministic by construction: the pilot draws no random numbers and the world
 * is the day's seed, so everyone gets the same par without a server. (Floating
 * point differences between JS engines could in principle diverge a long flight;
 * the rounding below is most of the guard, and the two-browser check that build
 * step 3 already owes will say whether more is needed.)
 */
export function computePar(world: World): number {
  // The floor is a hands-off glide: par must never be below what doing nothing
  // achieves, or the day is won by watching it.
  const handsOff = flyOnce(world, () => LEVEL)
  const chased = flyOnce(world, makeChasePilot(world))
  return Math.round(Math.max(handsOff, chased) / 50) * 50
}

const LEVEL: FlightInput = { x: 0, y: 0 }
const PAR_DT = 1 / 60
/**
 * The paper pilot gets one honest two-and-a-half-minute flight, not a marathon.
 * Uncapped it flies the day to its ceiling — 5-7 km paths on good days — and a
 * daily goal most players cannot reach is a stressor, which is the opposite of
 * this mechanic's job. 150 s of thermal-chaining still puts par comfortably above
 * the hands-off floor, so it asks the player to use the air, just not to move in.
 */
const PAR_MAX_T = 150

function flyOnce(world: World, pilot: (f: Flight) => FlightInput): number {
  const f = new Flight(world.heightfield, world.air, world.launch)
  f.launch()
  let t = 0
  while (f.phase === 'flying' && t < PAR_MAX_T) {
    f.update(PAR_DT, pilot(f))
    t += PAR_DT
  }
  return f.distance
}

/**
 * A rough cross-country autopilot: glide to the next column, circle while it is
 * lifting, move on. It exists to measure a day's ceiling from below — the
 * distance available to someone who uses the air — so its number is honest
 * about being a lower bound on skilled play. It is deliberately not clever;
 * a par that only experts can reach defeats its purpose.
 */
export function makeChasePilot(world: World) {
  const dx = Math.cos(world.air.windDir)
  const dz = Math.sin(world.air.windDir)
  let target = nearestForward(world, world.launch.pos.x, world.launch.pos.z, dx, dz, 0)
  let climbing = false

  return (f: Flight): FlightInput => {
    const holdSpeed = (want: number) => Math.max(-1, Math.min(1, (want - f.airspeed) * -0.12))

    // Only circle when the lift is a thermal. Ridge lift is also positive air, but
    // circling in it just drifts off the slope and loses everything — an earlier
    // version of this pilot spent 226 s doing exactly that and covered 650 m.
    const inCore = world.air.thermals.some(
      (t) => Math.hypot(t.x - f.pos.x, t.z - f.pos.z) < t.radius * 1.3,
    )
    if (f.airLift > 1.5 && inCore) climbing = true
    // Leave once the climb has banked enough height for the next leg, rather than
    // grinding to the top of every column — that is what a real pilot does, and
    // without it the autopilot circles all day and covers no ground.
    const climbedEnough = target ? f.pos.y > target.t.base + 420 : false
    if (climbing && (f.airLift < 0.2 || climbedEnough || (target && f.pos.y > target.t.top - 120))) {
      climbing = false
      target = nearestForward(world, f.pos.x, f.pos.z, dx, dz, progressOf(world, f.pos.x, f.pos.z, dx, dz) + 250)
    }

    // Hard banking near the ground just flies into it; ease off when low.
    const bankCap = f.aglHeight < 90 ? 0.4 : 1

    if (climbing) return { x: Math.min(0.45, bankCap), y: holdSpeed(21) }

    if (!target) return { x: 0, y: holdSpeed(24) }

    // Steer toward the column, a bit faster than best glide between climbs.
    const want = Math.atan2(target.t.z - f.pos.z, target.t.x - f.pos.x)
    const have = Math.atan2(f.vel.z, f.vel.x)
    let err = want - have
    while (err > Math.PI) err -= Math.PI * 2
    while (err < -Math.PI) err += Math.PI * 2
    return { x: Math.max(-bankCap, Math.min(bankCap, err * 1.6)), y: holdSpeed(24) }
  }
}

/**
 * Nearest thermal that is further downwind than we already are. The downwind
 * progress test is what stops the autopilot ping-ponging between two adjacent
 * columns — which it will happily do forever, staying airborne and going nowhere.
 */
export function nearestForward(
  world: World,
  x: number,
  z: number,
  dx: number,
  dz: number,
  minProgress: number,
): { t: Thermal; i: number } | null {
  let best: { t: Thermal; i: number } | null = null
  let bestCost = Infinity
  world.air.thermals.forEach((t, i) => {
    const progress = (t.x - world.launch.pos.x) * dx + (t.z - world.launch.pos.z) * dz
    if (progress < minProgress) return
    const range = Math.hypot(t.x - x, t.z - z)
    if (range < 150) return
    if (range < bestCost) {
      bestCost = range
      best = { t, i }
    }
  })
  return best
}

/** How far downwind of the launch a point is. */
export const progressOf = (world: World, x: number, z: number, dx: number, dz: number) =>
  (x - world.launch.pos.x) * dx + (z - world.launch.pos.z) * dz
