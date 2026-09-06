import { Vector3 } from 'three'
import type { World } from '../sim/world'
import { Flight } from '../sim/flight'
import { makeChasePilot } from '../sim/par'
import { sampleGradient, sampleHeight, surfaceHeight, HALF_WORLD } from '../sim/terrain'

export interface RouteGate { position: Vector3; normal: Vector3; radius: number }
export interface ScenicRoute { gates: RouteGate[]; landing: Vector3 | null; title: string; pilot: 'chase' | 'glide' }
const LEVEL = { x: 0, y: 0 }
const TITLES = { alpine: 'Along the high ridges', mesa: 'Through amber country', coastal: 'Following the sea breeze', valley: 'Over the quiet valley', volcanic: 'Across the ashlands', archipelago: 'Between the islands' }

/** Use a real flight to lay out reachable gates, without changing par or world RNG. */
export function buildRoute(world: World): ScenicRoute {
  const trace = (chase: boolean) => {
    const pilot = chase ? makeChasePilot(world) : () => LEVEL
    const flight = new Flight(world.heightfield, world.air, world.launch)
    flight.launch()
    const track: Array<{ position: Vector3; normal: Vector3; distance: number; clearance: number }> = []
    let nextSample = 0
    while (flight.phase === 'flying' && flight.time < 85 && flight.distance < 1600) {
      flight.update(1 / 60, pilot(flight))
      if (flight.distance >= nextSample && flight.phase === 'flying') {
        track.push({ position: flight.pos.clone(), normal: flight.vel.clone().normalize(), distance: flight.distance, clearance: flight.aglHeight })
        nextSample = flight.distance + 25
      }
    }
    return track
  }
  // A thermal chase can turn into a nearby hillside on a difficult day. Prefer
  // the longer of two real flights, as par does, so the route stays worthwhile.
  const chased = trace(true), glided = trace(false)
  const pilot = (chased.at(-1)?.distance ?? 0) >= (glided.at(-1)?.distance ?? 0) ? 'chase' : 'glide'
  const track = pilot === 'chase' ? chased : glided
  const usable = track.filter((p) => p.distance > 100 && p.clearance > 30)
  const gates: RouteGate[] = []
  for (const fraction of [0.18, 0.5, 0.85]) {
    const point = usable[Math.floor((usable.length - 1) * fraction)]
    if (!point || gates.some((g) => g.position.distanceTo(point.position) < 90)) continue
    gates.push({ position: point.position, normal: point.normal, radius: Math.min(42, point.clearance * 0.65) })
  }
  const last = gates.at(-1)?.position ?? world.launch.pos
  let landing: Vector3 | null = null
  let best = Infinity
  const grad = { x: 0, z: 0 }
  // A dry, gentle meadow within one glide of the last gate; reject sloping rims.
  for (let dz = -400; dz <= 400; dz += 40) for (let dx = -400; dx <= 400; dx += 40) {
    const x = last.x + dx, z = last.z + dz
    if (Math.abs(x) > HALF_WORLD * 0.95 || Math.abs(z) > HALF_WORLD * 0.95) continue
    const h = sampleHeight(world.heightfield, x, z)
    const range = Math.hypot(dx, dz)
    if (range < 200 || h > last.y - range / 6 - 15) continue
    const heading = gates.at(-1)?.normal
    if (heading && dx * heading.x + dz * heading.z < range * 0.25) continue
    let valid = true
    // A low meadow beyond a high ridge is not an approach. Check the entire
    // descending corridor, with room for the aircraft above the terrain.
    for (let k = 1; k < 16; k++) {
      const t = k / 16
      const approachY = last.y + (h + 12 - last.y) * t
      if (surfaceHeight(world.heightfield, last.x + dx * t, last.z + dz * t) + 8 > approachY) { valid = false; break }
    }
    if (!valid) continue
    for (let k = 0; k < 9; k++) {
      const a = k * Math.PI / 4
      const px = x + (k === 8 ? 0 : Math.cos(a) * 65)
      const pz = z + (k === 8 ? 0 : Math.sin(a) * 65)
      const y = sampleHeight(world.heightfield, px, pz)
      sampleGradient(world.heightfield, px, pz, grad)
      if (Math.hypot(grad.x, grad.z) > 0.22 || (world.heightfield.hasWater && y < world.heightfield.waterLevel + 2)) { valid = false; break }
    }
    const cost = range + Math.abs(last.y - h - 70) * 2
    if (valid && cost < best) { best = cost; landing = new Vector3(x, surfaceHeight(world.heightfield, x, z), z) }
  }
  return { gates, landing, title: TITLES[world.biome], pilot }
}

/** Swept segment against a gate disc. A fast frame cannot tunnel through it. */
export function crossesGate(from: Vector3, to: Vector3, gate: RouteGate): boolean {
  const a = (from.x - gate.position.x) * gate.normal.x + (from.y - gate.position.y) * gate.normal.y + (from.z - gate.position.z) * gate.normal.z
  const b = (to.x - gate.position.x) * gate.normal.x + (to.y - gate.position.y) * gate.normal.y + (to.z - gate.position.z) * gate.normal.z
  if (a > 0 || b < 0 || b - a < 1e-6) return false
  const t = -a / (b - a)
  const x = from.x + (to.x - from.x) * t - gate.position.x
  const y = from.y + (to.y - from.y) * t - gate.position.y
  const z = from.z + (to.z - from.z) * t - gate.position.z
  return x * x + y * y + z * z <= gate.radius * gate.radius
}

export class RouteProgress {
  gates = 0
  discovered = false
  landed = false
  reset() { this.gates = 0; this.discovered = false; this.landed = false }
  update(route: ScenicRoute, world: World, from: Vector3, flight: Flight) {
    if (flight.cheated) { this.reset(); return }
    const gate = route.gates[this.gates]
    if (gate && crossesGate(from, flight.pos, gate)) this.gates++
    const l = world.landmark
    if (Math.hypot(flight.pos.x - l.x, flight.pos.y - l.y, flight.pos.z - l.z) < 180) this.discovered = true
    if (flight.phase === 'down' && flight.landed && route.landing && this.gates === route.gates.length) {
      this.landed = Math.hypot(flight.pos.x - route.landing.x, flight.pos.z - route.landing.z) <= 65
    }
  }
}
