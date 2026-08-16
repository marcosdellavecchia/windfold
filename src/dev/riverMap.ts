/**
 * Top-down PNG of a day's drainage: the ground in grey, every drawn watercourse
 * over it, each connected piece in its own colour. What "a short piece of river
 * in the middle of nowhere" looks like, at a glance.
 *
 * `npm run river:map -- 75481 out.ppm`
 */
import { buildWorld } from '../sim/world'

// Node's own globals, declared rather than typed: this file is bundled by
// esbuild for a one-off run, and the project does not carry @types/node.
declare const process: { argv: string[]; env: Record<string, string | undefined> }
declare const Buffer: { from(v: string | Uint8Array, enc?: string): Uint8Array; concat(v: Uint8Array[]): Uint8Array }
declare function require(id: string): any
const { writeFileSync } = require('node:fs') as { writeFileSync: (p: string, d: Uint8Array) => void }

const CHANNEL = 0.5
const day = Number(process.argv[2] ?? 75481)
const out = process.argv[3] ?? 'river.ppm'
const SCALE = 2

const w = buildWorld(day)
const hf = w.heightfield
const n = hf.seg + 1
const isChannel = (i: number) =>
  hf.wet[i] > CHANNEL && hf.flowTo[i] >= 0 && !(hf.hasWater && hf.data[i] <= hf.waterLevel)

const W = n * SCALE
const img = new Uint8Array(W * W * 3)

// Ground: grey by height, blue under the water plane.
for (let iz = 0; iz < n; iz++) {
  for (let ix = 0; ix < n; ix++) {
    const i = iz * n + ix
    const t = (hf.data[i] - hf.min) / Math.max(hf.max - hf.min, 1e-6)
    const wet = hf.hasWater && hf.data[i] <= hf.waterLevel
    const r = wet ? 40 : 60 + t * 180
    const g = wet ? 70 : 60 + t * 180
    const b = wet ? 120 : 60 + t * 180
    for (let sz = 0; sz < SCALE; sz++) {
      for (let sx = 0; sx < SCALE; sx++) {
        const p = ((iz * SCALE + sz) * W + ix * SCALE + sx) * 3
        img[p] = r
        img[p + 1] = g
        img[p + 2] = b
      }
    }
  }
}

// Components, so each piece gets its own colour.
const parent = new Map<number, number>()
const find = (a: number): number => {
  while (parent.get(a) !== a) a = parent.get(a)!
  return a
}
const chan: number[] = []
for (let i = 0; i < hf.wet.length; i++) if (isChannel(i)) chan.push(i)
for (const i of chan) {
  parent.set(i, i)
  parent.set(hf.flowTo[i], hf.flowTo[i])
}
for (const i of chan) {
  const a = find(i)
  const b = find(hf.flowTo[i])
  if (a !== b) parent.set(a, b)
}
const len = new Map<number, number>()
for (const i of chan) {
  const j = hf.flowTo[i]
  const d = Math.hypot((i % n) - (j % n), ((i / n) | 0) - ((j / n) | 0)) * hf.cell
  const r = find(i)
  len.set(r, (len.get(r) ?? 0) + d)
}

// The renderer's own filter: trunk length per network, anything under MIN_LENGTH
// never drawn. Kept in step with Streams.tsx by hand — this is a dev picture.
const MIN_LENGTH = Number(process.env.MIN_LENGTH ?? 320)
const mouth = new Int32Array(hf.wet.length).fill(-1)
const outletOf = (i: number): number => {
  let a = i
  const path: number[] = []
  while (mouth[a] < 0) {
    const d = hf.flowTo[a]
    if (!isChannel(a) || d < 0) break
    path.push(a)
    a = d
  }
  const end = mouth[a] >= 0 ? mouth[a] : a
  for (const p of path) mouth[p] = end
  return end
}
const stretch = (i: number) =>
  Math.hypot((i % n) - (hf.flowTo[i] % n), ((i / n) | 0) - ((hf.flowTo[i] / n) | 0)) * hf.cell
const runTo = new Float32Array(hf.wet.length)
const trunk = new Map<number, number>()
const waiting = new Int32Array(hf.wet.length)
for (const i of chan) if (isChannel(hf.flowTo[i])) waiting[hf.flowTo[i]]++
const queue = chan.filter((i) => waiting[i] === 0)
for (let q = 0; q < queue.length; q++) {
  const i = queue[q]
  const d = hf.flowTo[i]
  const run = runTo[i] + stretch(i)
  if (run > runTo[d]) runTo[d] = run
  const m = outletOf(i)
  if (run > (trunk.get(m) ?? 0)) trunk.set(m, run)
  if (isChannel(d) && --waiting[d] === 0) queue.push(d)
}
const drawn = chan.filter((i) => (trunk.get(outletOf(i)) ?? 0) >= MIN_LENGTH)

const plot = (x: number, y: number, c: [number, number, number]) => {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= W || py >= W) return
  const p = (py * W + px) * 3
  img[p] = c[0]
  img[p + 1] = c[1]
  img[p + 2] = c[2]
}

for (const i of drawn) {
  const j = hf.flowTo[i]
  // Long pieces read as a network, short ones as litter — so colour by length
  // rather than at random, and the eye sorts them without being told.
  const l = len.get(find(i)) ?? 0
  const c: [number, number, number] =
    l < 200 ? [255, 40, 40] : l < 600 ? [255, 180, 40] : l < 2000 ? [90, 220, 255] : [255, 255, 255]
  const x0 = (i % n) * SCALE
  const y0 = ((i / n) | 0) * SCALE
  const x1 = (j % n) * SCALE
  const y1 = ((j / n) | 0) * SCALE
  const steps = SCALE * 2
  for (let s = 0; s <= steps; s++) {
    plot(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, c)
  }
}

// The launch point, for orientation.
const lx = ((w.launch.pos.x + hf.size / 2) / hf.cell) * SCALE
const lz = ((w.launch.pos.z + hf.size / 2) / hf.cell) * SCALE
for (let d = -6; d <= 6; d++) {
  plot(lx + d, lz, [80, 255, 80])
  plot(lx, lz + d, [80, 255, 80])
}

const header = Buffer.from(`P6\n${W} ${W}\n255\n`, 'ascii')
writeFileSync(out, Buffer.concat([header, Buffer.from(img)]))
const shown = new Set(drawn.map((i) => outletOf(i)))
const tiny = [...len.values()].filter((l) => l < 200).length
console.log(
  `${out}: day ${day} ${w.biome}/${hf.landform}, ${len.size} pieces (${tiny} under 200 m),` +
    ` ${shown.size} drawn after the ${MIN_LENGTH} m filter`,
)
