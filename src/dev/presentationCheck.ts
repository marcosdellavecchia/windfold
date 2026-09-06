import { Quaternion, Vector3 } from 'three'
import { ApproachReplay, type ReplayPose } from '../game/replay'
import { buildRoute, crossesGate, RouteProgress } from '../game/routes'
import { Flight } from '../sim/flight'
import { makeChasePilot } from '../sim/par'
import { buildWorld } from '../sim/world'
import { sampleGradient, sampleHeight } from '../sim/terrain'

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
const close = (a: number, b: number) => Math.abs(a - b) < 1e-5

// Replay wraps its ring, holds copies, interpolates orientation, and ends exactly.
const replay = new ApproachReplay()
const p = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)
const out: ReplayPose = { time: 0, position: new Vector3(), rotation: new Quaternion(), speed: 0, lift: 0, stall: 0 }
for (let i = 0; i <= 900; i++) {
  const t = i / 60
  p.set(t * 10, 100 - t, 0); q.setFromAxisAngle(up, t * 0.1)
  replay.record(t, p, q, 20 + t, 1, 0.2)
}
p.set(999, 999, 999); q.identity()
replay.finish(); replay.start(); replay.sample(0, out)
check(out.time >= 7 && out.time < 7.05, 'Replay must keep the final eight seconds')
check(close(out.position.x, out.time * 10), 'Recorded positions must not alias the aircraft')
let previous = out.time
while (replay.active) {
  replay.sample(1 / 60, out)
  check(out.time >= previous, 'Replay time must be monotonic after ring wrap')
  check(close(out.rotation.length(), 1), 'Replay quaternion must stay normalized')
  previous = out.time
}
check(close(out.time, 15) && close(out.position.x, 150), 'Replay must reach the exact impact pose')
replay.start(); replay.stop(); check(!replay.active, 'Replay must be skippable')
replay.reset(); replay.start(); check(!replay.active && !replay.available, 'Restart must clear replay')
console.log('ok replay ring, interpolation, finish, skip, restart')

// Gate crossing is directional and uses the swept frame segment.
const gate = { position: new Vector3(), normal: new Vector3(0, 0, 1), radius: 30 }
check(crossesGate(new Vector3(0, 0, -100), new Vector3(0, 0, 100), gate), 'Fast crossing must count')
check(!crossesGate(new Vector3(40, 0, -100), new Vector3(40, 0, 100), gate), 'Passing outside the ring must not count')
check(!crossesGate(new Vector3(0, 0, 100), new Vector3(0, 0, -100), gate), 'Reverse crossing must not count')
check(!crossesGate(new Vector3(0, 0, -100), new Vector3(0, 0, -10), gate), 'Approaching a gate must not count')
console.log('ok gate tunnelling, misses, direction, approach')

// Multiple days across every biome: repeatability, reachable gates, safe targets.
let gatesChecked = 0, meadows = 0
for (let day = 0; day < 14; day++) {
  const world = buildWorld(day)
  const heights = world.heightfield.data.slice()
  const route = buildRoute(world)
  const again = buildRoute(world)
  check(JSON.stringify(route) === JSON.stringify(again), `World ${day}: route is not deterministic`)
  check(heights.every((h, i) => h === world.heightfield.data[i]), 'Route must not mutate the daily terrain')
  check(route.gates.length > 0, `World ${day}: route needs at least one passage`)
  const flight = new Flight(world.heightfield, world.air, world.launch), pilot = route.pilot === 'chase' ? makeChasePilot(world) : () => ({ x: 0, y: 0 })
  const progress = new RouteProgress(), from = new Vector3()
  flight.launch()
  while (flight.phase === 'flying' && flight.time < 90 && progress.gates < route.gates.length) {
    from.copy(flight.pos); flight.update(1 / 60, pilot(flight)); progress.update(route, world, from, flight)
  }
  check(progress.gates === route.gates.length, `World ${day}: autopilot cannot reach all ${route.gates.length} gates (got ${progress.gates})`)
  gatesChecked += progress.gates
  if (route.landing) {
    meadows++
    const grad = { x: 0, z: 0 }
    sampleGradient(world.heightfield, route.landing.x, route.landing.z, grad)
    check(Math.hypot(grad.x, grad.z) <= 0.22, 'Landing target must be gentle')
    check(!world.heightfield.hasWater || sampleHeight(world.heightfield, route.landing.x, route.landing.z) > world.heightfield.waterLevel, 'Landing meadow must be dry')
    flight.pos.copy(route.landing); flight.phase = 'down'; flight.landed = true
    progress.update(route, world, from, flight)
    check(progress.landed, 'Finishing the route in the meadow must count')
  }
  flight.cheated = true; progress.update(route, world, from, flight)
  check(progress.gates === 0 && !progress.landed, 'Turbo must invalidate the route')
  flight.turbo = true; flight.reset()
  check(!flight.cheated && !flight.turbo && flight.phase === 'ready', 'New flight must clear turbo eligibility')
  progress.reset(); check(!progress.discovered, 'New flight must clear discoveries')
  console.log(`ok world ${day} (${world.biome}): ${route.gates.length} reachable passages${route.landing ? ', dry landing meadow' : ''}`)
}
console.log(`Passed: ${gatesChecked} reachable gates across 14 worlds, ${meadows} safe landing meadows, replay, and restart checks.`)
