/**
 * Headless flight-model harness. Not a unit test suite — a way to check that the
 * numbers in tuning.ts produce an aircraft worth flying before opening a browser.
 *
 *   npx esbuild src/dev/glideTest.ts --bundle --platform=node --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import { buildWorld, type World } from '../sim/world'
import { Flight } from '../sim/flight'
import { TUNING } from '../sim/tuning'
import { sampleAir, type Thermal } from '../sim/air'
import { BIOME_ORDER } from '../sim/palette'
import { sampleHeight, surfaceHeight } from '../sim/terrain'

const DT = 1 / 60

/**
 * How many days the day-sweeps cover.
 *
 * One cycle of BIOME_ORDER used to be a complete sample, because a biome fully
 * determined its terrain and every alpine day was the same alpine. Now the day also
 * draws its own amplitude, frequency, water fraction and landform, so one alpine
 * day says nothing about the next one — and the failure this is here to catch is a
 * *particular* day being a free ride, not a biome being one. Three cycles is enough
 * to see the outliers without making the run slow enough to skip.
 */
const SWEEP_DAYS = BIOME_ORDER.length * 3

function fly(day: number, pilot: (f: Flight, t: number) => { x: number; y: number }, maxT = 300) {
  const world = buildWorld(day)
  const f = new Flight(world.heightfield, world.air, world.launch)
  f.launch()
  let t = 0
  let peak = f.pos.y
  while (f.phase === 'flying' && t < maxT) {
    f.update(DT, pilot(f, t))
    t += DT
    if (f.pos.y > peak) peak = f.pos.y
  }
  return { world, f, t, peak }
}

const level = () => ({ x: 0, y: 0 })

/**
 * Nearest thermal that is further downwind than we already are. The downwind
 * progress test is what stops the autopilot ping-ponging between two adjacent
 * columns — which it will happily do forever, staying airborne and going nowhere.
 */
function nearestForward(
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
const progressOf = (world: World, x: number, z: number, dx: number, dz: number) =>
  (x - world.launch.pos.x) * dx + (z - world.launch.pos.z) * dz

/**
 * A rough cross-country autopilot: glide to the next column, circle while it is
 * lifting, move on. It exists to measure the *ceiling* of a day — the distance
 * available to someone who uses the air — so it can be compared against the
 * hands-off floor. It is not clever, so treat its number as a lower bound.
 */
function makeChasePilot(world: World) {
  const dx = Math.cos(world.air.windDir)
  const dz = Math.sin(world.air.windDir)
  let target = nearestForward(world, world.launch.pos.x, world.launch.pos.z, dx, dz, 0)
  let climbing = false

  return (f: Flight) => {
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

console.log('--- world generation ------------------------------------------')
console.time('buildWorld')
const w0 = buildWorld(0)
console.timeEnd('buildWorld')
console.log(
  `day 0: biome=${w0.biome} terrain=${w0.heightfield.min.toFixed(0)}..${w0.heightfield.max.toFixed(0)}m ` +
    `wind=${w0.air.windSpeed.toFixed(1)}m/s thermals=${w0.air.thermals.length}`,
)
console.log(
  `launch: (${w0.launch.pos.x.toFixed(0)}, ${w0.launch.pos.y.toFixed(0)}, ${w0.launch.pos.z.toFixed(0)})`,
)

console.log('\n--- determinism -----------------------------------------------')
const a = buildWorld(7)
const b = buildWorld(7)
let same = a.heightfield.data.length === b.heightfield.data.length
for (let i = 0; same && i < a.heightfield.data.length; i++) {
  if (a.heightfield.data[i] !== b.heightfield.data[i]) same = false
}
console.log(`day 7 rebuilt byte-identical: ${same}`)

console.log('\n--- launch sites: is altitude actually scarce? -----------------')
for (let day = 0; day < SWEEP_DAYS; day++) {
  const w = buildWorld(day)
  const dx = Math.cos(w.air.windDir)
  const dz = Math.sin(w.air.windDir)
  const agl = w.launch.pos.y - sampleHeight(w.heightfield, w.launch.pos.x, w.launch.pos.z)

  // Height above the terrain the opening glide has to cross — the number that
  // decides whether the flight starts under pressure.
  let route = 0
  for (let k = 1; k <= 4; k++) {
    const d = k * 420
    route += surfaceHeight(w.heightfield, w.launch.pos.x + dx * d, w.launch.pos.z + dz * d)
  }
  route /= 4

  const first = nearestForward(w, w.launch.pos.x, w.launch.pos.z, dx, dz, -1)
  const range = first ? Math.hypot(first.t.x - w.launch.pos.x, first.t.z - w.launch.pos.z) : NaN

  console.log(
    `day ${String(day).padStart(2)} ${w.biome.padEnd(12)} ` +
      `${w.heightfield.landform.padEnd(11)} ` +
      `agl ${agl.toFixed(0).padStart(4)}m  ` +
      `above route ${(w.launch.pos.y - route).toFixed(0).padStart(4)}m  ` +
      `first column ${range.toFixed(0).padStart(4)}m ahead ` +
      `(needs ${(range / 4.6).toFixed(0)}m of ${(w.launch.pos.y - route).toFixed(0)}m ` +
      `${range / 4.6 < w.launch.pos.y - route ? 'OK' : 'UNREACHABLE'})`,
  )
}

console.log('\n--- floor vs ceiling: hands-off, then chaining thermals --------')
console.log('  (the chase pilot is crude, so its number is a lower bound on skilled play)')
for (let day = 0; day < SWEEP_DAYS; day++) {
  const idle = fly(day, level)
  const chased = fly(day, makeChasePilot(buildWorld(day)))
  const ratio = chased.f.distance / Math.max(idle.f.distance, 1)
  console.log(
    `day ${String(day).padStart(2)} ${idle.world.biome.padEnd(12)} ` +
      `${idle.world.heightfield.landform.padEnd(11)} ` +
      `hands-off ${idle.f.distance.toFixed(0).padStart(5)}m/${idle.t.toFixed(0).padStart(3)}s   ` +
      `chained ${chased.f.distance.toFixed(0).padStart(5)}m/${chased.t.toFixed(0).padStart(3)}s   ` +
      `climbed +${Math.max(0, chased.peak - chased.world.launch.pos.y).toFixed(0)}m   ` +
      `${ratio.toFixed(1)}x`,
  )
}

console.log('\n--- trim: does it settle, or porpoise? -------------------------')
{
  const world = buildWorld(0)
  const f = new Flight(world.heightfield, world.air, world.launch)
  f.launch()
  const speeds: number[] = []
  for (let i = 0; i < 60 * 20 && f.phase === 'flying'; i++) {
    f.update(DT, level())
    if (i % 60 === 0) speeds.push(f.airspeed)
  }
  console.log('airspeed each second: ' + speeds.map((s) => s.toFixed(0)).join(' '))
}

console.log('\n--- stall entry and recovery -----------------------------------')
{
  const world = buildWorld(0)
  const f = new Flight(world.heightfield, world.air, world.launch)
  f.launch()
  let minSpeed = Infinity
  let maxAlpha = 0
  let stalled = false
  // Hold full back-pointer for 6 s, then let go and see if it flies again.
  for (let i = 0; i < 60 * 6 && f.phase === 'flying'; i++) {
    f.update(DT, { x: 0, y: 1 })
    minSpeed = Math.min(minSpeed, f.airspeed)
    maxAlpha = Math.max(maxAlpha, Math.abs(f.alpha))
    if (f.stallFactor > 0.3) stalled = true
  }
  const speedAtRelease = f.airspeed
  for (let i = 0; i < 60 * 6 && f.phase === 'flying'; i++) f.update(DT, level())
  console.log(
    `held nose up: min speed ${minSpeed.toFixed(1)}m/s, max AoA ${((maxAlpha * 180) / Math.PI).toFixed(0)}deg, ` +
      `stalled=${stalled}`,
  )
  console.log(
    `after release: phase=${f.phase} speed ${speedAtRelease.toFixed(0)} -> ${f.airspeed.toFixed(0)}m/s ` +
      `alpha ${((f.alpha * 180) / Math.PI).toFixed(0)}deg`,
  )
}

console.log('\n--- dive and flare: can you trade height for speed? ------------')
{
  const world = buildWorld(0)
  const f = new Flight(world.heightfield, world.air, world.launch)
  f.launch()
  for (let i = 0; i < 60 * 4 && f.phase === 'flying'; i++) f.update(DT, { x: 0, y: -1 })
  const diveSpeed = f.airspeed

  // Measure the zoom from the bottom of the pull-out, not from where the flare
  // was commanded — the aircraft is still descending for the first second of it.
  let low = Infinity
  let peak = -Infinity
  for (let i = 0; i < 60 * 8 && f.phase === 'flying'; i++) {
    f.update(DT, { x: 0, y: 0.55 })
    low = Math.min(low, f.pos.y)
    peak = Math.max(peak, f.pos.y)
  }
  console.log(
    `dive to ${diveSpeed.toFixed(0)}m/s, then flare: pulls out at ${low.toFixed(0)}m, ` +
      `zooms to ${peak.toFixed(0)}m (+${(peak - low).toFixed(0)}m), ends at ${f.airspeed.toFixed(0)}m/s`,
  )
}

console.log('\n--- turn rate at full bank -------------------------------------')
{
  const world = buildWorld(0)
  const f = new Flight(world.heightfield, world.air, world.launch)
  f.launch()
  for (let i = 0; i < 30; i++) f.update(DT, level())
  const h0 = Math.atan2(f.vel.x, f.vel.z)
  for (let i = 0; i < 60 * 2 && f.phase === 'flying'; i++) f.update(DT, { x: 1, y: 0.25 })
  const h1 = Math.atan2(f.vel.x, f.vel.z)
  let d = h1 - h0
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  console.log(
    `2s at full right bank: heading changed ${((d * 180) / Math.PI).toFixed(0)}deg ` +
      `(${((Math.abs(d) * 180) / Math.PI / 2).toFixed(0)} deg/s), bank ${((f.bank * 180) / Math.PI).toFixed(0)}deg`,
  )
}

console.log('\n--- circling sink in still air (the number to beat) ------------')
{
  const world = buildWorld(0)
  // Neutralise the air so this measures the airframe alone.
  const still = { ...world.air, windX: 0, windZ: 0, windSpeed: 0, sink: 0, thermals: [] }
  for (const bankCmd of [0, 0.3, 0.45, 0.6]) {
    const f = new Flight(world.heightfield, still, world.launch)
    f.pos.y = world.heightfield.max + 1500
    f.launch()
    const y0 = f.pos.y
    for (let i = 0; i < 60 * 20 && f.phase === 'flying'; i++) {
      const hold = Math.max(-1, Math.min(1, (21 - f.airspeed) * -0.12))
      f.update(DT, { x: bankCmd, y: hold })
    }
    console.log(
      `stick ${bankCmd}: sink ${(-(f.pos.y - y0) / 20).toFixed(2)} m/s ` +
        `at bank ${((f.bank * 180) / Math.PI).toFixed(0)}deg, ${f.airspeed.toFixed(0)}m/s`,
    )
  }
}

console.log('\n--- thermal: is a column actually climbable? -------------------')
{
  const world = buildWorld(0)
  const t = world.air.thermals[0]
  const probe = { x: 0, y: 0, z: 0 }
  sampleAir(world.air, world.heightfield, t.x, t.base + 200, t.z, probe)
  console.log(`core lift at ${(t.base + 200).toFixed(0)}m: ${probe.y.toFixed(1)} m/s (strength ${t.strength.toFixed(1)})`)
  sampleAir(world.air, world.heightfield, t.x + t.radius * 1.3, t.base + 200, t.z, probe)
  console.log(`edge lift: ${probe.y.toFixed(1)} m/s`)

  // Fly a circle inside the column and see whether it wins height. The pilot
  // holds a target airspeed rather than a fixed stick position, which is what a
  // player learns to do within a few flights.
  for (const bankCmd of [0.3, 0.45, 0.6]) {
    const f = new Flight(world.heightfield, world.air, world.launch)
    f.pos.set(t.x, t.base + 220, t.z)
    f.launch()
    f.vel.set(0, 0, -1).applyQuaternion(f.quat).multiplyScalar(TUNING.launchSpeed)
    const y0 = f.pos.y
    for (let i = 0; i < 60 * 30 && f.phase === 'flying'; i++) {
      const hold = Math.max(-1, Math.min(1, (21 - f.airspeed) * -0.12))
      f.update(DT, { x: bankCmd, y: hold })
    }
    const gain = f.pos.y - y0
    console.log(
      `30s circling, stick ${bankCmd}: ${(gain >= 0 ? '+' : '') + gain.toFixed(0)}m ` +
        `(${(gain / 30).toFixed(1)} m/s net, bank ${((f.bank * 180) / Math.PI).toFixed(0)}deg, ` +
        `${f.airspeed.toFixed(0)}m/s)`,
    )
  }
}

console.log('\n--- ridge lift --------------------------------------------------')
{
  const world = buildWorld(0)
  const hf = world.heightfield
  const probe = { x: 0, y: 0, z: 0 }
  let best = 0
  let bestAt = ''
  for (let i = 0; i < 4000; i++) {
    const x = (Math.random() * 2 - 1) * 2800
    const z = (Math.random() * 2 - 1) * 2800
    const g = hf.data[0]
    void g
    const ground = world.heightfield
    void ground
    sampleAir(world.air, hf, x, sampleGround(hf, x, z) + 40, z, probe)
    if (probe.y > best) {
      best = probe.y
      bestAt = `(${x.toFixed(0)}, ${z.toFixed(0)})`
    }
  }
  console.log(`best ridge/thermal lift found 40m above terrain: ${best.toFixed(1)} m/s at ${bestAt}`)
}

function sampleGround(hf: { seg: number; cell: number; data: Float32Array }, x: number, z: number) {
  const n = hf.seg + 1
  const HALF = (hf.seg * hf.cell) / 2
  const ix = Math.max(0, Math.min(hf.seg, Math.round((x + HALF) / hf.cell)))
  const iz = Math.max(0, Math.min(hf.seg, Math.round((z + HALF) / hf.cell)))
  return hf.data[iz * n + ix]
}
