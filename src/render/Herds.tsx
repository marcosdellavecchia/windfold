import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Color,
  Group,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import type { BiomeId, Palette, Rgb } from '../sim/palette'
import { mulberry32 } from '../sim/rng'
import { sampleGradient, sampleHeight, smoothstep } from '../sim/terrain'
import { merge, translated, scaled, mix, scale } from './Trees'

/**
 * Animals on the ground. From three hundred metres up an animal is a handful of
 * vertices, but a scatter of dots that *moves* is the difference between scenery
 * and a place where things live. One species per biome, placed in herds rather
 * than sprinkled — animals cluster, and the cluster is what reads from altitude
 * — each drifting around its home on its own slow loop. No AI, no collision:
 * the wander is a closed curve of two sines, so a herd needs no state at all.
 *
 * Volcanic days have no herd on purpose. Almost nothing survives there, and the
 * one biome with an empty ground says more than a seventh species would.
 */
type HerdKind = 'sheep' | 'deer' | 'ibex' | 'flamingo' | 'seal' | 'turtle'

interface HerdSpec {
  kind: HerdKind
  /** Chance that a scatter cell holds a herd at all. */
  chance: number
  /** Animals per herd. */
  size: [number, number]
  /** Herd centres rejected on ground steeper than this. */
  maxSlope: number
  /** Height window as a fraction of the day's range. */
  band: [number, number]
  /** If > 0, only within this many metres above the waterline. */
  shore: number
  /** Body length in metres — deliberately a touch large, like the hay bales. */
  scale: [number, number]
  /** How far members stray from the herd centre, metres. */
  spread: number
  /**
   * How hard the species takes a low pass, as a multiplier on the shove. 0 would
   * be an animal that never looks up.
   *
   * This is the one number in the file that is about behaviour rather than
   * placement, and it is worth more than a seventh species: a herd that scatters
   * when your shadow crosses it is the difference between a landscape with
   * animals drawn on it and a landscape with animals in it. Deer bolt, turtles
   * essentially do not, and both are true.
   */
  startle: number
}

const HERDS: Record<BiomeId, HerdSpec | null> = {
  // Flocks in the pastures between the hedgerows.
  field: { kind: 'sheep', chance: 0.22, size: [5, 11], maxSlope: 0.22, band: [0.03, 0.7], shore: 0, scale: [2.2, 2.8], spread: 34, startle: 1.0 },
  // Small groups at the edges of the clearings.
  valley: { kind: 'deer', chance: 0.12, size: [3, 6], maxSlope: 0.3, band: [0.02, 0.6], shore: 0, scale: [2.4, 3.0], spread: 26, startle: 1.45 },
  // Strings of them on ledges the trees cannot reach.
  alpine: { kind: 'ibex', chance: 0.1, size: [3, 7], maxSlope: 0.5, band: [0.35, 0.8], shore: 0, scale: [2.0, 2.6], spread: 30, startle: 0.9 },
  // A pink crescent on the alkali shore of the playa. Shore species take the
  // full height band: the waterline's *fraction* of the height range moves with
  // the day's water roll, so gating them by band as well silently starves them
  // on high-water days — the shore distance is the only filter that means
  // anything to a wading bird.
  mesa: { kind: 'flamingo', chance: 0.3, size: [7, 14], maxSlope: 0.14, band: [0, 1], shore: 14, scale: [1.8, 2.2], spread: 55, startle: 1.3 },
  // Hauled out on the sand below the headlands.
  coastal: { kind: 'seal', chance: 0.3, size: [4, 9], maxSlope: 0.16, band: [0, 1], shore: 12, scale: [2.6, 3.4], spread: 24, startle: 0.45 },
  volcanic: null,
  // Up the beaches, barely moving, exactly as advertised. Slope and shore match
  // the palms' tolerances — tropical islands rise steeply, and a stricter gate
  // left every beach empty.
  archipelago: { kind: 'turtle', chance: 0.25, size: [3, 6], maxSlope: 0.32, band: [0, 1], shore: 20, scale: [2.0, 2.6], spread: 22, startle: 0.15 },
}

const CELL = 384
const RADIUS = 2100
const REDRAW_AT = CELL * 0.6
const MAX = 240

/**
 * How close the plane has to come before anything notices, in metres — and the
 * distance is measured in three dimensions on purpose. A pass at three hundred
 * metres is ignored entirely; you have to actually come down to the deck to put
 * a flock up. That makes the low line over a pasture worth flying for its own
 * sake, which is the whole point of putting animals in a gliding game.
 */
const STARTLE_RADIUS = 95
/** Shove at the centre of that radius, m/s². Falls off linearly to nothing at the edge. */
const STARTLE_ACCEL = 26
/** Nothing here outruns a paper plane. */
const STARTLE_SPEED = 11
/** Pull back toward the wander curve. Low, so a scattered herd takes a while to re-form. */
const HOME_SPRING = 0.9
/** Just under critical damping for that spring, so they mill a little on the way back. */
const DRAG = 2

export function Herds({ world, planeRef }: { world: World; planeRef: React.RefObject<Group | null> }) {
  const camera = useThree((s) => s.camera)
  const spec = HERDS[world.biome]

  const built = useMemo(() => {
    if (!spec) return null
    const mesh = new InstancedMesh(herdGeometry(spec.kind), new MeshLambertMaterial({ vertexColors: true }), MAX)
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
    mesh.frustumCulled = false
    mesh.count = 0
    return {
      mesh,
      palette: herdColours(spec.kind, world.palette),
      // Per-animal wander parameters, filled at scatter time.
      home: new Float32Array(MAX * 2),
      phase: new Float32Array(MAX),
      rate: new Float32Array(MAX),
      orbit: new Float32Array(MAX),
      size: new Float32Array(MAX),
      // Displacement away from the wander curve, and its velocity. The only
      // state in the file: the wander itself is a closed curve and needs none,
      // but an animal that ran somewhere has to still be there next frame.
      offX: new Float32Array(MAX),
      offZ: new Float32Array(MAX),
      velX: new Float32Array(MAX),
      velZ: new Float32Array(MAX),
      count: 0,
    }
  }, [world, spec])

  const last = useRef(new Vector3(1e9, 0, 1e9))
  const clock = useRef(0)

  useFrame((_, dt) => {
    if (!built || !spec) return
    const step = Math.min(dt, 0.1)
    clock.current += step
    const p = camera.position
    if (last.current.distanceTo(p) >= REDRAW_AT) {
      last.current.copy(p)
      scatter(world, spec, built, p.x, p.z)
    }
    // The plane, not the camera, is what frightens them — the camera trails it by
    // tens of metres, which is enough to put the shove behind the animals rather
    // than under them. This runs before Simulation's own frame callback, so the
    // position is one frame stale; at 22 m/s that is 40 cm.
    animate(world, spec, built, clock.current, step, planeRef.current)
  })

  if (!built) return null
  return <primitive object={built.mesh} />
}

interface Built {
  mesh: InstancedMesh
  palette: Rgb[]
  home: Float32Array
  phase: Float32Array
  rate: Float32Array
  orbit: Float32Array
  size: Float32Array
  offX: Float32Array
  offZ: Float32Array
  velX: Float32Array
  velZ: Float32Array
  count: number
}

const MATRIX = new Matrix4()
const POS = new Vector3()
const QUAT = new Quaternion()
const SCL = new Vector3()
const UP = new Vector3(0, 1, 0)
const COLOR = new Color()
const GRAD = { x: 0, z: 0 }

function scatter(world: World, spec: HerdSpec, built: Built, cx: number, cz: number) {
  const hf = world.heightfield
  const range = Math.max(hf.max - hf.min, 1)
  const waterY = hf.hasWater ? hf.waterLevel : -Infinity

  const cell0x = Math.floor((cx - RADIUS) / CELL)
  const cell1x = Math.floor((cx + RADIUS) / CELL)
  const cell0z = Math.floor((cz - RADIUS) / CELL)
  const cell1z = Math.floor((cz + RADIUS) / CELL)
  const r2 = RADIUS * RADIUS

  // The herds themselves survive a rebuild — every one of them is a pure function
  // of its cell — but the *index* an animal lands on does not, because the cell
  // window has shifted. Flee state is keyed by index, so it has to go: keeping it
  // would apply one animal's panic to another. An animal caught mid-bolt by a
  // rebuild snaps back to its wander curve, which is a real if rare glitch. It is
  // survivable because a rebuild happens every 230 m of travel — roughly ten
  // seconds — and a startle is spent in three.
  built.offX.fill(0)
  built.offZ.fill(0)
  built.velX.fill(0)
  built.velZ.fill(0)

  let n = 0
  for (let ciz = cell0z; ciz <= cell1z && n < MAX; ciz++) {
    for (let cix = cell0x; cix <= cell1x && n < MAX; cix++) {
      // Same trick as the trees: placement is a pure function of the cell, so a
      // rebuild puts every herd back exactly where it was.
      const rng = mulberry32(cellSeed(cix, ciz, world.seed))
      const roll = rng()
      // Shore species get several candidate centres per cell: their habitat is a
      // ribbon a few metres wide, and one dart thrown at a 384 m cell almost
      // never lands on it — that starved the beaches of turtles entirely.
      const tries = spec.shore > 0 ? 6 : 1
      let hx = 0
      let hz = 0
      let found = false
      for (let attempt = 0; attempt < tries && !found; attempt++) {
        hx = (cix + rng()) * CELL
        hz = (ciz + rng()) * CELL
        const h = sampleHeight(hf, hx, hz)
        if (h < waterY) continue
        const band = (h - hf.min) / range
        if (band < spec.band[0] || band > spec.band[1]) continue
        if (spec.shore > 0 && (!hf.hasWater || h > hf.waterLevel + spec.shore)) continue
        sampleGradient(hf, hx, hz, GRAD)
        if (Math.hypot(GRAD.x, GRAD.z) > spec.maxSlope) continue
        found = true
      }
      if (roll > spec.chance || !found) continue

      const dx = hx - cx
      const dz = hz - cz
      if (dx * dx + dz * dz > r2) continue

      const edge = 1 - smoothstep(RADIUS * 0.78, RADIUS, Math.hypot(dx, dz))
      if (edge <= 0.05) continue

      const members = Math.round(spec.size[0] + rng() * (spec.size[1] - spec.size[0]))
      for (let k = 0; k < members && n < MAX; k++) {
        const a = rng() * Math.PI * 2
        const d = Math.sqrt(rng()) * spec.spread
        built.home[n * 2] = hx + Math.cos(a) * d
        built.home[n * 2 + 1] = hz + Math.sin(a) * d
        built.phase[n] = rng() * Math.PI * 2
        // Turtles amble, sheep drift, deer are the restless ones.
        built.rate[n] = (0.05 + rng() * 0.1) * (spec.kind === 'deer' ? 1.7 : spec.kind === 'turtle' ? 0.4 : 1)
        built.orbit[n] = 4 + rng() * 11
        built.size[n] = (spec.scale[0] + rng() * (spec.scale[1] - spec.scale[0])) * edge

        const base = built.palette[Math.floor(rng() * built.palette.length) % built.palette.length]
        const v = 0.86 + rng() * 0.26
        COLOR.setRGB(Math.min(base[0] * v, 1), Math.min(base[1] * v, 1), Math.min(base[2] * v, 1))
        built.mesh.setColorAt(n, COLOR)
        n++
      }
    }
  }

  built.count = n
  built.mesh.count = n
  if (built.mesh.instanceColor) built.mesh.instanceColor.needsUpdate = true
}

/**
 * The wander: each animal circles its home on two incommensurate sines, which
 * from the air reads as grazing drift rather than orbiting. Heading follows the
 * motion. ~200 height samples per frame, which is nothing.
 *
 * Laid over that, the startle: a shove away from the plane when it comes low
 * enough, against a spring back to the curve. A damped spring rather than a
 * scripted animation because it gets the whole shape for free — the burst, the
 * slowing, the milling about, and the drift back to grazing — and because it
 * needs four numbers per animal rather than a state machine.
 */
function animate(world: World, spec: HerdSpec, built: Built, t: number, dt: number, plane: Group | null) {
  const hf = world.heightfield
  // No plane yet (the first frames of a world) means nothing to run from.
  const px = plane ? plane.position.x : Infinity
  const py = plane ? plane.position.y : 0
  const pz = plane ? plane.position.z : 0
  const damp = Math.max(0, 1 - DRAG * dt)
  const shove = STARTLE_ACCEL * spec.startle * dt

  for (let i = 0; i < built.count; i++) {
    const w = built.phase[i] + t * built.rate[i]
    const r = built.orbit[i]
    const ox = built.offX[i]
    const oz = built.offZ[i]
    const x = built.home[i * 2] + Math.cos(w) * r + ox
    const z = built.home[i * 2 + 1] + Math.sin(w * 0.83 + 1.7) * r + oz
    // Velocity of the same curve, for the heading.
    const vx = -Math.sin(w) * built.rate[i] * r
    const vz = Math.cos(w * 0.83 + 1.7) * 0.83 * built.rate[i] * r

    let y = sampleHeight(hf, x, z)
    // Flamingos stand in the shallows; everyone else stays on the ground.
    if (spec.kind === 'flamingo' && hf.hasWater && y < hf.waterLevel) y = hf.waterLevel

    let fx = built.velX[i]
    let fz = built.velZ[i]
    const ax = x - px
    const ay = y - py
    const az = z - pz
    const d2 = ax * ax + ay * ay + az * az
    if (d2 < STARTLE_RADIUS * STARTLE_RADIUS) {
      // Straight away from the plane, but along the ground — nothing here flies,
      // so the vertical part of the gap only decides how frightening the pass was.
      const flat = Math.hypot(ax, az) || 1
      const push = (1 - Math.sqrt(d2) / STARTLE_RADIUS) * shove
      fx += (ax / flat) * push
      fz += (az / flat) * push
    }
    fx = (fx - ox * HOME_SPRING * dt) * damp
    fz = (fz - oz * HOME_SPRING * dt) * damp
    const speed = Math.hypot(fx, fz)
    if (speed > STARTLE_SPEED) {
      fx = (fx / speed) * STARTLE_SPEED
      fz = (fz / speed) * STARTLE_SPEED
    }
    built.velX[i] = fx
    built.velZ[i] = fz
    built.offX[i] = ox + fx * dt
    built.offZ[i] = oz + fz * dt

    POS.set(x, y, z)
    // Heading off the total motion, so a bolting animal faces where it is going
    // and turns round on its own when the spring walks it home. The flee term
    // dwarfs the graze term whenever it is non-zero, which is why this is a sum
    // rather than a blend.
    QUAT.setFromAxisAngle(UP, Math.atan2(-(vx + fx), -(vz + fz)))
    const s = built.size[i]
    SCL.set(s, s, s)
    MATRIX.compose(POS, QUAT, SCL)
    built.mesh.setMatrixAt(i, MATRIX)
  }
  built.mesh.instanceMatrix.needsUpdate = true
}

function cellSeed(x: number, z: number, seed: number): number {
  let h = (x | 0) * 668265263 + (z | 0) * 374761393 + (seed ^ 0x5e3d)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/* -------------------------------------------------------------- geometry ---- */

/**
 * Unit-length bodies, base at y = 0, vertex colour as a brightness mask — the
 * same contract as the trees. Nothing here has legs: from the game's altitudes
 * legs are sub-pixel, and a body at the right height reads better than a body
 * on stilts.
 */
function herdGeometry(kind: HerdKind): BufferGeometry {
  const body = (w: number, h: number, l: number, y: number) =>
    translated(scaled(new IcosahedronGeometry(0.5, 0), w, h, l), 0, y, 0)
  const head = (s: number, x: number, y: number, z: number) =>
    translated(scaled(new IcosahedronGeometry(0.5, 0), s, s, s), x, y, z)

  switch (kind) {
    case 'sheep':
      // Suffolk colouring: pale fleece, dark face.
      return merge([
        { geo: body(0.62, 0.44, 0.9, 0.42), tint: 1.0 },
        { geo: head(0.22, 0, 0.52, -0.48), tint: 0.3 },
      ])
    case 'deer':
      return merge([
        { geo: body(0.4, 0.4, 0.95, 0.5), tint: 1.0 },
        { geo: head(0.2, 0, 0.78, -0.5), tint: 0.85 },
      ])
    case 'ibex':
      return merge([
        { geo: body(0.42, 0.4, 0.8, 0.45), tint: 1.0 },
        { geo: head(0.2, 0, 0.66, -0.44), tint: 0.75 },
      ])
    case 'flamingo':
      // A blob on a stem. The stem is what says "wading bird" in silhouette.
      return merge([
        { geo: translated(new CylinderGeometry(0.03, 0.03, 0.5, 4), 0, 0.25, 0), tint: 0.6 },
        { geo: body(0.3, 0.26, 0.5, 0.62), tint: 1.0 },
        { geo: head(0.12, 0, 0.82, -0.3), tint: 0.9 },
      ])
    case 'seal':
      return merge([
        { geo: body(0.42, 0.26, 1.0, 0.2), tint: 1.0 },
        { geo: head(0.2, 0, 0.3, -0.5), tint: 0.9 },
      ])
    case 'turtle':
      return merge([
        { geo: body(0.7, 0.24, 0.85, 0.18), tint: 1.0 },
        { geo: head(0.16, 0, 0.16, -0.5), tint: 0.8 },
      ])
  }
}

/** Herd colours off the day's palette, so the animals live in the same light. */
function herdColours(kind: HerdKind, pal: Palette): Rgb[] {
  switch (kind) {
    case 'sheep':
      return [mix([1, 1, 1], pal.low, 0.14), mix([0.94, 0.92, 0.88], pal.low, 0.2)]
    case 'deer':
      return [mix(pal.rock, pal.sun, 0.3), mix(pal.rock, pal.mid, 0.4)]
    case 'ibex':
      return [scale(pal.rock, 1.05), mix(pal.rock, pal.mineral, 0.4)]
    case 'flamingo':
      return [mix(pal.glow, [1, 0.55, 0.62], 0.55), mix(pal.glow, [1, 0.7, 0.72], 0.4)]
    case 'seal':
      return [scale(pal.rock, 0.8), mix(pal.rock, pal.water, 0.25)]
    case 'turtle':
      return [mix(pal.mid, pal.low, 0.5), scale(pal.mid, 0.7)]
  }
}
