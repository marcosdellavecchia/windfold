/**
 * Measure the drainage network: how long its drawn pieces actually are, and why
 * they end where they do. Run with `npm run river:check -- 75481 [more days]`.
 */
import { buildWorld } from '../sim/world'

const CHANNEL = 0.5

declare const process: { argv: string[] }
declare const Date: { now(): number }
const args = process.argv.slice(2)
const sweep = args[0] === 'sweep'
const days: number[] = args.map(Number).filter((d: number) => Number.isFinite(d))
const list = sweep ? Array.from({ length: Number(args[1] ?? 60) }, (_, k) => 75481 + k) : days.length ? days : [75481]

if (sweep) {
  const t0 = Date.now()
  let comps = 0
  let tiny = 0
  let pitEnds = 0
  let drawn = 0
  let worst = { day: 0, tiny: 0 }
  for (const day of list) {
    const w = buildWorld(day)
    const hf = w.heightfield
    const nn = hf.seg + 1
    const isCh = (i: number) =>
      hf.wet[i] > CHANNEL && hf.flowTo[i] >= 0 && !(hf.hasWater && hf.data[i] <= hf.waterLevel)
    const par = new Map<number, number>()
    const find = (a: number): number => {
      while (par.get(a) !== a) a = par.get(a)!
      return a
    }
    const chan: number[] = []
    for (let i = 0; i < hf.wet.length; i++) if (isCh(i)) chan.push(i)
    for (const i of chan) {
      par.set(i, i)
      par.set(hf.flowTo[i], hf.flowTo[i])
    }
    for (const i of chan) {
      const a = find(i), b = find(hf.flowTo[i])
      if (a !== b) par.set(a, b)
    }
    const len = new Map<number, number>()
    for (const i of chan) {
      const j = hf.flowTo[i]
      const d = Math.hypot((i % nn) - (j % nn), ((i / nn) | 0) - ((j / nn) | 0)) * hf.cell
      const r = find(i)
      len.set(r, (len.get(r) ?? 0) + d)
    }
    let dayTiny = 0
    for (const l of len.values()) if (l < 200) dayTiny++
    // What the renderer will actually draw: pieces whose longest thread reaches
    // MIN_LENGTH. Kept in step with Streams.tsx by hand.
    for (const [, l] of len) if (l >= 320) drawn++
    for (const i of chan) {
      const j = hf.flowTo[i]
      if (isCh(j)) continue
      if (!(hf.hasWater && hf.data[j] <= hf.waterLevel) && hf.flowTo[j] < 0) pitEnds++
    }
    comps += len.size
    tiny += dayTiny
    const frac = len.size ? dayTiny / len.size : 0
    if (frac > worst.tiny) worst = { day, tiny: frac }
  }
  console.log(`${list.length} days in ${Date.now() - t0} ms`)
  console.log(`components ${comps}, under 200 m ${tiny} (${((tiny / comps) * 100).toFixed(0)}%)`)
  console.log(`drawn (piece over 320 m): ${drawn}`)
  console.log(`components ending at a land pit: ${pitEnds}`)
  console.log(`worst day ${worst.day}: ${(worst.tiny * 100).toFixed(0)}% tiny`)
} else

for (const day of list) {
  const w = buildWorld(day)
  const hf = w.heightfield
  const n = hf.seg + 1
  const count = hf.wet.length
  const isChannel = (i: number) =>
    hf.wet[i] > CHANNEL && hf.flowTo[i] >= 0 && !(hf.hasWater && hf.data[i] <= hf.waterLevel)

  // Every drawn node, and the tree structure over them.
  const chan: number[] = []
  for (let i = 0; i < count; i++) if (isChannel(i)) chan.push(i)

  // Component = maximal set joined by drawn stretches. A stretch runs i -> flowTo[i];
  // the endpoint may itself not be drawn (sea, or a pit), but it still joins.
  const parent = new Int32Array(count).fill(-1)
  const find = (a: number): number => {
    let r = a
    while (parent[r] !== r) r = parent[r]
    while (parent[a] !== r) {
      const nx = parent[a]
      parent[a] = r
      a = nx
    }
    return r
  }
  const touched = new Set<number>()
  for (const i of chan) {
    touched.add(i)
    touched.add(hf.flowTo[i])
  }
  for (const i of touched) parent[i] = i
  for (const i of chan) {
    const a = find(i)
    const b = find(hf.flowTo[i])
    if (a !== b) parent[a] = b
  }

  // Length of each component, in metres of stretch.
  const lenOf = new Map<number, number>()
  const nodesOf = new Map<number, number>()
  for (const i of chan) {
    const j = hf.flowTo[i]
    const d = Math.hypot((i % n) - (j % n), ((i / n) | 0) - ((j / n) | 0)) * hf.cell
    const r = find(i)
    lenOf.set(r, (lenOf.get(r) ?? 0) + d)
    nodesOf.set(r, (nodesOf.get(r) ?? 0) + 1)
  }

  // Why each component's outlet stops. Its outlet is the one node whose flowTo
  // leaves the component's drawn set.
  let endSea = 0
  let endPit = 0
  let endDry = 0 // flow continues downhill but fell back below the draw threshold
  let endEdge = 0
  const outletKind = new Map<number, string>()
  for (const i of chan) {
    const j = hf.flowTo[i]
    if (isChannel(j)) continue
    let kind: string
    if (hf.hasWater && hf.data[j] <= hf.waterLevel) kind = 'sea'
    else if (hf.flowTo[j] < 0) kind = 'pit'
    else if (hf.wet[j] <= CHANNEL) kind = 'dry'
    else kind = 'edge'
    outletKind.set(find(i), kind)
  }
  for (const k of outletKind.values()) {
    if (k === 'sea') endSea++
    else if (k === 'pit') endPit++
    else if (k === 'dry') endDry++
    else endEdge++
  }

  const lens = [...lenOf.entries()].sort((a, b) => b[1] - a[1])
  const total = lens.reduce((s, [, l]) => s + l, 0)
  const short = lens.filter(([, l]) => l < 400).length
  const tiny = lens.filter(([, l]) => l < 200).length

  // How many cells are true 8-neighbour local minima (pits), on dry land.
  let pits = 0
  let dryLand = 0
  for (let i = 0; i < count; i++) {
    if (hf.hasWater && hf.data[i] <= hf.waterLevel) continue
    dryLand++
    if (hf.flowTo[i] < 0) pits++
  }

  console.log(`\n=== day ${day} — ${w.biome} / ${hf.landform}${hf.hybrid ? '+' + hf.landform2 : ''} ===`)
  console.log(`  channel nodes:      ${chan.length}`)
  console.log(`  components:         ${lens.length}`)
  console.log(`  total length:       ${(total / 1000).toFixed(1)} km`)
  console.log(`  under 400 m:        ${short} (${((short / lens.length) * 100).toFixed(0)}%)`)
  console.log(`  under 200 m:        ${tiny} (${((tiny / lens.length) * 100).toFixed(0)}%)`)
  console.log(`  longest 8:          ${lens.slice(0, 8).map(([, l]) => (l / 1000).toFixed(2) + 'km').join(' ')}`)
  console.log(`  median length:      ${(lens[(lens.length / 2) | 0]?.[1] ?? 0).toFixed(0)} m`)
  console.log(`  ends at sea/pit/dry/edge: ${endSea} / ${endPit} / ${endDry} / ${endEdge}`)
  console.log(`  land pits:          ${pits} of ${dryLand} (${((pits / dryLand) * 100).toFixed(1)}%)`)

  // Does the drawn ribbon ever run uphill over the real ground? Filling is a
  // routing trick; the mesh takes its height from the ground itself, so a river
  // crossing a filled hollow is water visibly climbing out of it.
  let up = 0
  let maxRise = 0
  let riseTotal = 0
  const runs: number[] = []
  let run = 0
  for (const i of chan) {
    const j = hf.flowTo[i]
    const rise = hf.data[j] - hf.data[i]
    if (rise > 0) {
      up++
      riseTotal += rise
      if (rise > maxRise) maxRise = rise
      run++
    } else if (run) {
      runs.push(run)
      run = 0
    }
  }
  if (run) runs.push(run)
  runs.sort((a, b) => b - a)

  // How high the water climbs in one go: the sum of the rises along each uphill
  // run, which is what the eye reads as "the river goes up there".
  const climbs: number[] = []
  let climb = 0
  for (const i of chan) {
    const rise = hf.data[hf.flowTo[i]] - hf.data[i]
    if (rise > 0) climb += rise
    else if (climb) {
      climbs.push(climb)
      climb = 0
    }
  }
  if (climb) climbs.push(climb)
  climbs.sort((a, b) => a - b)
  const pct = (f: number) => (climbs[Math.min(climbs.length - 1, (climbs.length * f) | 0)] ?? 0).toFixed(2)
  console.log(
    `  climbs (m):         n=${climbs.length} p50 ${pct(0.5)} p90 ${pct(0.9)} p99 ${pct(0.99)}` +
      ` max ${(climbs[climbs.length - 1] ?? 0).toFixed(1)}` +
      `  over 3 m: ${climbs.filter((c) => c > 3).length}` +
      `  over 10 m: ${climbs.filter((c) => c > 10).length}`,
  )
  console.log(
    `  uphill stretches:   ${up} of ${chan.length} (${((up / chan.length) * 100).toFixed(1)}%),` +
      ` max rise ${maxRise.toFixed(2)} m, total ${riseTotal.toFixed(0)} m,` +
      ` longest run ${runs[0] ?? 0} cells`,
  )
}
