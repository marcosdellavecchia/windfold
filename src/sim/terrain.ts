import { Noise2D, fbm, ridged, billow, type FbmOptions } from './noise'
import { mulberry32, randRange, type Rng } from './rng'
import type { BiomeId } from './palette'

/**
 * 12 km across at 32 m cells — the same 385^2 vertex count and draw cost as the
 * original 6 km / 16 m map, for four times the area.
 *
 * The map size was doubled when the score was straight-line displacement and the
 * map radius was therefore a hard ceiling on it. The score is path distance flown
 * now, which has no such ceiling — but the size still matters: it is the room a
 * flight has to wander before the border ends it, and the fog-to-border ratio is
 * what keeps the world feeling open.
 *
 * Coarser cells mean the finest noise octave has to go — see SHAPES below.
 */
export const WORLD_SIZE = 12288 // metres across
export const TERRAIN_SEG = 384 // 32 m cells
export const HALF_WORLD = WORLD_SIZE / 2

export interface Heightfield {
  size: number
  seg: number
  cell: number
  /** (seg + 1)^2 heights in metres, row-major by z then x. */
  data: Float32Array
  min: number
  max: number
  /** Absolute altitude of the water plane. Below `hasWater` this is unused. */
  waterLevel: number
  hasWater: boolean
  /** The day's structural modifier. Carried for the tuning panel and for debugging. */
  landform: LandformId
  /** A rare second modifier — most days 'plain', meaning none. */
  landform2: LandformId
  /** Whether two noise characters were blended across the map. */
  hybrid: boolean
}

/**
 * Octave counts are bounded by the 32 m cell size: the finest octave has to stay
 * above the ~64 m Nyquist wavelength or it turns into single-vertex spikes rather
 * than terrain. At lacunarity ~2 that caps every biome at five octaves.
 */
type NoiseKind = 'ridged' | 'fbm' | 'billow'

/**
 * A structural modifier drawn per day, on top of the biome.
 *
 * Biome shape alone gave every alpine day the same alpine: same relief, same
 * frequency, same amount of water, differing only by which part of an infinite
 * noise field it sampled. Six biomes on a strict rotation then meant a player who
 * came back for a week saw six landscapes and started seeing them again. These are
 * the second axis — they change what *kind* of place the day is rather than how its
 * numbers are set, and they are the difference between "alpine again" and "the day
 * with the fault line across it".
 *
 * Each is a handful of arithmetic inside the generation loop. None of them needs a
 * second pass over the heightfield, which is why there are seven of them rather
 * than one erosion simulation.
 */
export type LandformId =
  /** No modifier. Deliberately in every biome's list — a plain day is a day too. */
  | 'plain'
  /** A branching network of carved channels, following the domain warp. */
  | 'rivers'
  /** The same carve, much deeper and much narrower. */
  | 'canyons'
  /** One large circular depression with a raised rim. */
  | 'caldera'
  /** A single fault line across the map; everything on one side steps up. */
  | 'escarpment'
  /** Long parallel ridges at one heading, over whatever is underneath. */
  | 'dunes'
  /** Stepped contours, the mesa treatment applied somewhere it does not belong. */
  | 'terraces'
  /** Isolated steep-sided rises off a noise threshold — tables on a mesa day, tors on a field day, stacks off a coast. */
  | 'buttes'
  /** One wide U-shaped trough across the map, as if something enormous slid through. */
  | 'glacial'
  /** A handful of small craters scattered across the map — a meteor-pocked day. */
  | 'craters'

/**
 * Which modifiers each biome may draw. Restricted by what reads as plausible —
 * dunes on an alpine day look like a mistake — and weighted only by list length.
 */
const LANDFORMS: Record<BiomeId, readonly LandformId[]> = {
  alpine: ['plain', 'rivers', 'caldera', 'escarpment', 'terraces', 'glacial'],
  mesa: ['plain', 'canyons', 'canyons', 'dunes', 'escarpment', 'buttes', 'craters'],
  // Buttes on a coast are sea stacks: the ones that land offshore rise
  // straight out of the shallows.
  coastal: ['plain', 'rivers', 'escarpment', 'dunes', 'buttes'],
  valley: ['plain', 'rivers', 'rivers', 'terraces', 'escarpment', 'glacial'],
  volcanic: ['plain', 'canyons', 'caldera', 'caldera', 'craters'],
  field: ['plain', 'rivers', 'rivers', 'escarpment', 'terraces', 'buttes'],
  archipelago: ['plain', 'rivers', 'terraces', 'escarpment'],
}

interface BiomeShape {
  kind: NoiseKind
  amplitude: number
  /** Cycles per metre for the first octave. */
  baseFreq: number
  octaves: number
  lacunarity: number
  gain: number
  /** Domain warp strength in metres — breaks up the grid-aligned look of raw fbm. */
  warp: number
  /** Fraction of the height range that is water. 0 = dry biome. */
  waterFrac: number
  /** Number of terrace steps, 0 = smooth. */
  terrace: number
  /** Pull the map into islands with a radial falloff. */
  islands: boolean
  /** Exponent applied to the normalised field. >1 flattens lowlands, sharpens peaks. */
  curve: number
}

const SHAPES: Record<BiomeId, BiomeShape> = {
  alpine: {
    kind: 'ridged',
    amplitude: 820,
    baseFreq: 1 / 2600,
    octaves: 5,
    lacunarity: 2.05,
    gain: 0.5,
    warp: 240,
    waterFrac: 0.04,
    terrace: 0,
    islands: false,
    curve: 1.5,
  },
  mesa: {
    kind: 'fbm',
    amplitude: 520,
    baseFreq: 1 / 2200,
    octaves: 5,
    lacunarity: 2.1,
    gain: 0.48,
    warp: 180,
    // A trace of water, so the deepest basins hold a playa. Even a desert reads
    // better with something reflective in it.
    waterFrac: 0.03,
    terrace: 7,
    islands: false,
    curve: 1.35,
  },
  coastal: {
    kind: 'fbm',
    amplitude: 640,
    baseFreq: 1 / 2400,
    octaves: 5,
    lacunarity: 2.0,
    gain: 0.52,
    warp: 300,
    waterFrac: 0.3,
    terrace: 0,
    islands: false,
    curve: 1.8,
  },
  valley: {
    kind: 'billow',
    amplitude: 560,
    baseFreq: 1 / 2100,
    octaves: 5,
    lacunarity: 2.0,
    gain: 0.5,
    warp: 260,
    waterFrac: 0.08,
    terrace: 0,
    islands: false,
    curve: 1.1,
  },
  volcanic: {
    kind: 'ridged',
    amplitude: 700,
    baseFreq: 1 / 1900,
    octaves: 5,
    lacunarity: 2.2,
    gain: 0.46,
    warp: 200,
    waterFrac: 0.05,
    terrace: 0,
    islands: false,
    curve: 1.9,
  },
  field: {
    // Rolling hay country. A third of the relief of anything else in the game,
    // which is the point: this is the biome with no mountains in it. Ridge lift
    // barely exists on ground this gentle, so the day's lift comes almost
    // entirely from thermals — generateAir notices the low relief and organizes
    // them into streets. Long-wavelength billow so the hills are swells you fly
    // along, not bumps you fly over.
    kind: 'billow',
    amplitude: 230,
    baseFreq: 1 / 3100,
    octaves: 5,
    lacunarity: 2.0,
    gain: 0.46,
    warp: 320,
    // Ponds and a stream threading the lowest ground.
    waterFrac: 0.06,
    terrace: 0,
    islands: false,
    curve: 1.0,
  },
  archipelago: {
    kind: 'fbm',
    amplitude: 480,
    baseFreq: 1 / 1500,
    octaves: 5,
    lacunarity: 2.1,
    gain: 0.5,
    warp: 220,
    waterFrac: 0.42,
    terrace: 0,
    islands: true,
    curve: 1.6,
  },
}

export function generateHeightfield(biome: BiomeId, rng: Rng): Heightfield {
  const shape = varyShape(SHAPES[biome], rng)
  const base = new Noise2D(rng)
  const warpA = new Noise2D(rng)
  const warpB = new Noise2D(rng)
  const alt = new Noise2D(rng)
  const blend = new Noise2D(rng)
  const feature = new Noise2D(rng)

  const opts: FbmOptions = {
    octaves: shape.octaves,
    frequency: shape.baseFreq,
    lacunarity: shape.lacunarity,
    gain: shape.gain,
  }
  const warpOpts: FbmOptions = { octaves: 3, frequency: shape.baseFreq * 0.7, lacunarity: 2, gain: 0.5 }

  // --- the day's second character ------------------------------------------
  // A single noise kind makes the whole 12 km map one texture: alpine is spines
  // everywhere, valley is lumps everywhere, and after one flight you have seen all
  // of it. Blending a second kind in under a slow mask means a map can be ridges at
  // one end and rounded hills at the other, which gives a flight somewhere to be
  // going. The mask is deliberately coarse — two or three regions across the map,
  // not a checkerboard.
  const others: NoiseKind[] = (['ridged', 'fbm', 'billow'] as NoiseKind[]).filter((k) => k !== shape.kind)
  const altKind = others[Math.floor(rng() * others.length)]
  const altOpts: FbmOptions = {
    octaves: Math.max(3, shape.octaves - 1),
    frequency: shape.baseFreq * randRange(rng, 0.8, 1.5),
    lacunarity: shape.lacunarity,
    gain: shape.gain,
  }
  const blendOpts: FbmOptions = { octaves: 2, frequency: 1 / randRange(rng, 3600, 6000), lacunarity: 2, gain: 0.5 }
  const hybrid = rng() < 0.65

  // --- the day's landform ---------------------------------------------------
  const landform = LANDFORMS[biome][Math.floor(rng() * LANDFORMS[biome].length)]

  // One day in four draws a second landform, so "rivers and buttes" and
  // "escarpment and craters" are days that exist — the variety of the
  // landform list, squared, for a handful of lines. The one forbidden pair
  // is two carvers: rivers and canyons share the same ridge field, and
  // carving it twice cuts channels deep enough to glide down for free —
  // the exact ramp the carve depths were tuned to prevent.
  const isCarver = (l: LandformId) => l === 'rivers' || l === 'canyons'
  const secondRoll = rng()
  const secondPick = LANDFORMS[biome][Math.floor(rng() * LANDFORMS[biome].length)]
  const landform2: LandformId =
    secondRoll < 0.25 && secondPick !== landform && !(isCarver(secondPick) && isCarver(landform))
      ? secondPick
      : 'plain'

  // River channels stay shallow. They are drainage, not a route: cut deep enough and
  // a glide can follow one downhill for kilometres without ever working for it.
  const carveDepth = landform === 'canyons' ? randRange(rng, 0.22, 0.36) : randRange(rng, 0.09, 0.16)
  // Where the carve starts biting, as a fraction of the ridge field. Higher is
  // narrower, which is the whole difference between a river valley and a canyon.
  const carveEdge = landform === 'canyons' ? 0.9 : 0.8
  const carveOpts: FbmOptions = { octaves: 2, frequency: 1 / randRange(rng, 2400, 4400), lacunarity: 2, gain: 0.5 }

  const calderaX = randRange(rng, -HALF_WORLD * 0.45, HALF_WORLD * 0.45)
  const calderaZ = randRange(rng, -HALF_WORLD * 0.45, HALF_WORLD * 0.45)
  // Radius is the number that matters, and not for looks. At 2.8 km the bowl spans
  // 5.6 km of a 12 km map, which is a funnel the whole flight can ride down: a
  // hands-off glide on such a day went 7.2 km against the 1.0-2.4 km the rest of
  // the game sits at, and there is no launch site the scorer could have picked that
  // would have avoided it. Kept small enough to be a feature on the map rather than
  // the shape of the map.
  const calderaR = randRange(rng, 800, 1500)
  const calderaDepth = randRange(rng, 0.12, 0.22)
  const calderaRim = randRange(rng, 0.06, 0.15)

  const faultAngle = randRange(rng, 0, Math.PI * 2)
  const faultX = Math.cos(faultAngle)
  const faultZ = Math.sin(faultAngle)
  const faultOffset = randRange(rng, -0.3, 0.3)
  // Same reasoning as the caldera radius: a step is a large-scale height difference
  // across the whole map, so it stays small enough not to become a ramp.
  const faultStep = randRange(rng, 0.08, 0.16)
  const faultOpts: FbmOptions = { octaves: 2, frequency: 1 / randRange(rng, 2200, 4000), lacunarity: 2, gain: 0.5 }

  // Buttes stand on a noise threshold: the narrow smoothstep is the steep side,
  // the noise's own plateau above the threshold is the flat top. Local rises like
  // the caldera rim, never a map-scale ramp — the flight can use one, not ride it.
  const butteEdge = randRange(rng, 0.3, 0.46)
  const butteHeight = randRange(rng, 0.1, 0.17)
  const butteOpts: FbmOptions = { octaves: 2, frequency: 1 / randRange(rng, 1300, 2100), lacunarity: 2, gain: 0.5 }

  // The glacial trough reuses the fault's heading and crook. Constant depth along
  // its whole length, so entering it is one drop rather than a downhill to follow —
  // the same lesson the rivers and the caldera had to learn, applied in advance.
  const troughWidth = randRange(rng, 0.1, 0.18)
  const troughDepth = randRange(rng, 0.1, 0.16)

  const duneAngle = randRange(rng, 0, Math.PI * 2)
  const duneX = Math.cos(duneAngle)
  const duneZ = Math.sin(duneAngle)
  // 400-800 m between crests. Anything finer disappears into the 32 m cells.
  const duneFreq = randRange(rng, 0.008, 0.016)
  const duneAmp = randRange(rng, 0.025, 0.05)
  const duneOpts: FbmOptions = { octaves: 2, frequency: 1 / 2600, lacunarity: 2, gain: 0.5 }

  // The crater field: a handful of small ones instead of one caldera. Each is
  // the caldera's own math at a quarter the size, so each stays a local
  // feature — the ramp law is about any single bowl's diameter, not how many
  // there are.
  const CRATERS = 4
  const craterX: number[] = []
  const craterZ: number[] = []
  const craterR: number[] = []
  const craterDeep: number[] = []
  const craterRim: number[] = []
  for (let i = 0; i < CRATERS; i++) {
    craterX.push(randRange(rng, -HALF_WORLD * 0.7, HALF_WORLD * 0.7))
    craterZ.push(randRange(rng, -HALF_WORLD * 0.7, HALF_WORLD * 0.7))
    craterR.push(randRange(rng, 260, 560))
    craterDeep.push(randRange(rng, 0.05, 0.1))
    craterRim.push(randRange(rng, 0.04, 0.09))
  }

  if ((landform === 'terraces' || landform2 === 'terraces') && shape.terrace === 0) {
    shape.terrace = Math.round(randRange(rng, 4, 9))
  }

  // One landform's contribution to the normalised height at a point. Pulled
  // out of the vertex loop so a second landform can apply the same way.
  const applyLandform = (
    l: LandformId,
    t: number,
    x: number,
    z: number,
    wx: number,
    wz: number,
    px: number,
    pz: number,
  ): number => {
    switch (l) {
      case 'rivers':
      case 'canyons': {
        // 1 - |noise| ridges along the field's zero crossings, which is a
        // branching network rather than a set of parallel gouges. Sampled at the
        // warped coordinates so the channels meander with everything else.
        const ridge = 1 - Math.abs(fbm(feature, px, pz, carveOpts))
        return t - smoothstep(l === 'canyons' ? 0.9 : carveEdge, 1, ridge) * carveDepth
      }
      case 'caldera': {
        const d = Math.hypot(x - calderaX, z - calderaZ) / calderaR
        // Rim first, then the floor drops out from under it. The gaussian rim is
        // what stops it reading as a dent and starts it reading as a crater.
        const rim = Math.exp(-(((d - 1) * 2.4) ** 2)) * calderaRim
        return t + rim - (1 - smoothstep(0.72, 1, d)) * calderaDepth
      }
      case 'escarpment': {
        // A straight fault, made crooked by a noise term, with a step across it.
        // Centred on zero so the map's overall height is unchanged and the launch
        // scorer is not handed a free 200 m on one side.
        const s = (x * faultX + z * faultZ) / HALF_WORLD + fbm(feature, wx, wz, faultOpts) * 0.45 + faultOffset
        return t + smoothstep(-0.05, 0.05, s) * faultStep - faultStep * 0.5
      }
      case 'dunes': {
        const u = x * duneX + z * duneZ
        return t + Math.sin(u * duneFreq + fbm(feature, wx, wz, duneOpts) * 3.2) * duneAmp
      }
      case 'buttes': {
        const f = fbm(feature, px, pz, butteOpts)
        return t + smoothstep(butteEdge, butteEdge + 0.09, f) * butteHeight
      }
      case 'glacial': {
        const s = (x * faultX + z * faultZ) / HALF_WORLD + fbm(feature, wx, wz, faultOpts) * 0.3 + faultOffset
        return t - Math.exp(-((s / troughWidth) ** 2)) * troughDepth
      }
      case 'craters': {
        for (let ci = 0; ci < CRATERS; ci++) {
          const d = Math.hypot(x - craterX[ci], z - craterZ[ci]) / craterR[ci]
          if (d > 2.2) continue
          t += Math.exp(-(((d - 1) * 2.6) ** 2)) * craterRim[ci] - (1 - smoothstep(0.6, 1, d)) * craterDeep[ci]
        }
        return t
      }
      default:
        return t
    }
  }

  const seg = TERRAIN_SEG
  const n = seg + 1
  const cell = WORLD_SIZE / seg
  const data = new Float32Array(n * n)

  // Seeded offset so the same biome on two different days is a different place.
  const ox = rng() * 20000 - 10000
  const oz = rng() * 20000 - 10000

  // --- the day's accidents ---------------------------------------------------
  //
  // Between the 32 m cells and the kilometre-scale landforms there was nothing.
  // The finest noise octave has to stay above ~64 m or it turns into vertex
  // spikes, and every landform is sized in kilometres because that is what a
  // landform is — so the whole hundred-to-four-hundred-metre band, which is the
  // scale at which real ground is *incidental*, was empty. Terrain came out
  // shaped but featureless: nowhere in particular to aim for, nothing to notice
  // on the way past.
  //
  // These are that band. A knoll to clear, a hollow you only see once you are
  // over its lip, a notch cut through a ridge that turns it into a pass, a spur
  // running off a shoulder. Every one is a couple of lines of arithmetic and
  // none of them needs its own pass over the field.
  //
  // Drawn after `ox`/`oz` on purpose: everything above this line has already
  // taken its numbers from the stream, so adding these leaves the base terrain of
  // every existing day exactly where it was and lays the accidents on top.
  //
  // Sizes obey the ramp law the same way the craters do. The rule is about any
  // single feature's diameter, not how many there are: at 380 m across and 7.5%
  // of the height range, the steepest thing here is far short of a glide slope,
  // so it is something to fly over rather than something to ride down. Rises and
  // dips are drawn with equal probability, which keeps the map's mean height
  // where the noise put it.
  // Their own stream, seeded by exactly one draw from the main one.
  //
  // This is not tidiness. `generateAir` and `findLaunchSite` both run after this
  // function and share its generator, so drawing a variable number of values here
  // would move every thermal and every launch site on the map — and then any
  // measurement of "with features against without" is really measuring a reshuffled
  // sky. One fixed draw means the count and the sizes below can be tuned, or
  // switched off outright, with the rest of the day held still.
  const featRng = mulberry32((rng() * 0xffffffff) >>> 0)
  const FEATURES = Math.round(randRange(featRng, 16, 26))
  const featX = new Float32Array(FEATURES)
  const featZ = new Float32Array(FEATURES)
  const featAmp = new Float32Array(FEATURES)
  const featR = new Float32Array(FEATURES)
  const featLong = new Float32Array(FEATURES)
  const featCos = new Float32Array(FEATURES)
  const featSin = new Float32Array(FEATURES)
  const featReach = new Float32Array(FEATURES)
  for (let i = 0; i < FEATURES; i++) {
    // Round ones are knolls and hollows; drawn-out ones are spurs and notches.
    const round = featRng() < 0.5
    const rise = featRng() < 0.5
    const r = randRange(featRng, 90, 380)
    const long = round ? 1 : randRange(featRng, 2.4, 4.8)
    const ang = featRng() * Math.PI * 2
    featX[i] = randRange(featRng, -HALF_WORLD * 0.85, HALF_WORLD * 0.85)
    featZ[i] = randRange(featRng, -HALF_WORLD * 0.85, HALF_WORLD * 0.85)
    featR[i] = r
    featLong[i] = long
    featAmp[i] = randRange(featRng, 0.03, round ? 0.075 : 0.06) * (rise ? 1 : -1)
    featCos[i] = Math.cos(ang)
    featSin[i] = Math.sin(ang)
    // Where the gaussian has faded to under half a percent, so the box test
    // below can reject without evaluating anything.
    featReach[i] = r * long * 1.6
  }

  /**
   * Every accident that reaches this point, summed. Runs 147k times, so the
   * rejection is two compares against a box before any multiplying happens —
   * at these sizes all but a handful of features miss any given vertex.
   */
  const applyFeatures = (t: number, fx: number, fz: number): number => {
    for (let i = 0; i < FEATURES; i++) {
      const reach = featReach[i]
      const dx = fx - featX[i]
      if (dx < -reach || dx > reach) continue
      const dz = fz - featZ[i]
      if (dz < -reach || dz > reach) continue
      const u = (dx * featCos[i] + dz * featSin[i]) / (featR[i] * featLong[i])
      const v = (-dx * featSin[i] + dz * featCos[i]) / featR[i]
      const q = u * u + v * v
      if (q > 2.6) continue
      t += featAmp[i] * Math.exp(-q * 2.2)
    }
    return t
  }

  for (let iz = 0; iz < n; iz++) {
    const z = -HALF_WORLD + iz * cell
    for (let ix = 0; ix < n; ix++) {
      const x = -HALF_WORLD + ix * cell

      const wx = x + ox
      const wz = z + oz
      const dx = fbm(warpA, wx, wz, warpOpts) * shape.warp
      const dz = fbm(warpB, wx, wz, warpOpts) * shape.warp
      const px = wx + dx
      const pz = wz + dz

      let h = sampleKind(shape.kind, base, px, pz, opts)
      if (hybrid) {
        const m = smoothstep(-0.22, 0.3, fbm(blend, wx, wz, blendOpts))
        if (m > 0) h += (sampleKind(altKind, alt, px, pz, altOpts) - h) * m
      }

      // to 0..1
      let t = clamp01(h * 0.5 + 0.5)
      t = Math.pow(t, shape.curve)

      t = applyLandform(landform, t, x, z, wx, wz, px, pz)
      if (landform2 !== 'plain') t = applyLandform(landform2, t, x, z, wx, wz, px, pz)
      // Accidents on top of the day's structure, sampled at a third of the domain
      // warp. Analytic gaussians are perfect ellipses and read as dropped-in
      // pottery; the warp is already computed, so borrowing a fraction of it
      // costs nothing and pulls every one of them out of true. A third rather
      // than all of it — at full strength the warp is wider than the features and
      // tears them apart instead of bending them.
      t = applyFeatures(t, x + (px - wx) * 0.35, z + (pz - wz) * 0.35)
      t = clamp01(t)

      if (shape.islands) {
        // A gentle radial bias, not a hard cone: at this map size a strong falloff
        // makes a single continent instead of an archipelago. The island shapes
        // come from the noise and the water level.
        const r = Math.sqrt(x * x + z * z) / HALF_WORLD
        t *= clamp01(1.35 - r * 0.8)
        t = clamp01(t * 1.65 - 0.14)
      }

      if (shape.terrace > 0) {
        const s = t * shape.terrace
        const fl = Math.floor(s)
        const fr = s - fl
        t = (fl + smoothstep(0.32, 0.68, fr)) / shape.terrace
      }

      // Soften the outer border so the map does not end in a cliff wall.
      const edge = borderMask(x, z)
      t *= edge

      data[iz * n + ix] = t * shape.amplitude
    }
  }

  // The one pass over the finished field. Min and max are taken after it, since
  // it shaves the peaks and fills the hollows — and everything downstream, from
  // the waterline to the treeline to the snowline, is a fraction of that range.
  settle(data, n, cell)

  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < data.length; i++) {
    const y = data[i]
    if (y < min) min = y
    if (y > max) max = y
  }

  const hasWater = shape.waterFrac > 0
  const waterLevel = hasWater ? min + (max - min) * shape.waterFrac : min - 1

  return { size: WORLD_SIZE, seg, cell, data, min, max, waterLevel, hasWater, landform, landform2, hybrid }
}

/**
 * Gradient a slope may hold before loose material starts leaving it — 0.9, or
 * about 42 degrees. Rock talus really sits nearer 35, but at 32 m cells a single
 * gradient is an average over a whole cell rather than the face of one boulder,
 * and clamping this hard flattened the alpine biome's character in testing.
 */
const REPOSE = 0.9
/** Fraction of the excess that moves per pass. Under-relaxed on purpose: see `settle`. */
const SETTLE_RATE = 0.35
const SETTLE_PASSES = 3

/**
 * The angle of repose — the cheap eighty percent of erosion.
 *
 * Everything above this is additive noise and analytic landforms, and neither has
 * any history in it. Real slopes are convex at the top and concave at the bottom
 * because loose material leaves steep ground and collects at the foot of it; fbm
 * has no idea. That absence is most of what reads as "computer-generated" from a
 * kilometre up, and no amount of extra octaves fixes it, because it is not a
 * missing frequency — it is a missing process.
 *
 * So: wherever a cell stands more than REPOSE above a neighbour, some of the
 * excess moves downhill. Below that threshold nothing happens at all. Faces stay
 * faces and grow scree aprons at their feet, gullies fill from the bottom, and the
 * single-cell spikes the finest octave leaves behind get shaved off.
 *
 * The threshold does the biome selection by itself, which is why there is one
 * constant here rather than seven. The mountain biomes carry slopes past it on a
 * few percent of their cells and get talus; `field` never reaches it — its 99th
 * percentile slope is 24 degrees — and comes out untouched. That is exactly where
 * scree does and does not occur, and it fell out of the distribution rather than
 * being tuned in.
 *
 * Deliberately NOT hydraulic erosion, however much better that would look.
 * Droplets carve drainage, drainage is a continuous downhill route across the
 * map, and a continuous downhill route is the precise thing the carve depths, the
 * caldera radius and the glacial trough are all tuned to prevent.
 */
function settle(data: Float32Array, n: number, cell: number) {
  const maxDrop = REPOSE * cell
  // Transfers accumulate here and are applied between passes, so the result does
  // not depend on which corner the sweep started from. Every transfer subtracts
  // from one cell exactly what it adds to another, so the map's mean height is
  // unchanged and no amount of settling can tilt the world into a ramp.
  const delta = new Float32Array(data.length)
  for (let pass = 0; pass < SETTLE_PASSES; pass++) {
    delta.fill(0)
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix
        const h = data[i]
        let moved = 0
        if (ix > 0) moved += shed(data, delta, i - 1, h, maxDrop)
        if (ix < n - 1) moved += shed(data, delta, i + 1, h, maxDrop)
        if (iz > 0) moved += shed(data, delta, i - n, h, maxDrop)
        if (iz < n - 1) moved += shed(data, delta, i + n, h, maxDrop)
        delta[i] -= moved
      }
    }
    for (let i = 0; i < data.length; i++) data[i] += delta[i]
  }
}

/**
 * Move a share of the excess from a cell to one lower neighbour, and report how
 * much left. The quarter is what stops a cell shedding to all four neighbours at
 * once from overshooting below them and oscillating on the next pass.
 */
function shed(data: Float32Array, delta: Float32Array, j: number, h: number, maxDrop: number): number {
  const excess = h - data[j] - maxDrop
  if (excess <= 0) return 0
  const t = excess * SETTLE_RATE * 0.25
  delta[j] += t
  return t
}

function sampleKind(kind: NoiseKind, n: Noise2D, x: number, z: number, o: FbmOptions): number {
  switch (kind) {
    case 'ridged':
      return ridged(n, x, z, o)
    case 'billow':
      return billow(n, x, z, o)
    default:
      return fbm(n, x, z, o)
  }
}

/**
 * The day's own take on the biome.
 *
 * Everything in a BiomeShape was a constant, so the only thing separating two
 * alpine days was which patch of noise they sampled — same relief, same scale, same
 * coastline fraction. These ranges are wide enough to be felt (a 22% swing in
 * amplitude is 180 m of relief on an alpine map) and narrow enough that the biome
 * still reads as itself.
 *
 * `baseFreq` is the one with a hard ceiling. Octaves multiply it by lacunarity four
 * times over, and the finest octave has to stay above the ~64 m Nyquist wavelength
 * of a 32 m cell or the terrain turns into single-vertex spikes — so 1.3 is as far
 * up as this may go without also dropping an octave.
 */
function varyShape(shape: BiomeShape, rng: Rng): BiomeShape {
  return {
    ...shape,
    amplitude: shape.amplitude * randRange(rng, 0.85, 1.15),
    baseFreq: shape.baseFreq * randRange(rng, 0.78, 1.24),
    lacunarity: shape.lacunarity * randRange(rng, 0.95, 1.06),
    gain: clamp(shape.gain * randRange(rng, 0.93, 1.08), 0.4, 0.6),
    // Warp is the free one. It moves terrain sideways, never up or down, so no
    // amount of it can turn a map into a ramp — and it is most of what makes two
    // days of the same biome read as different country.
    warp: shape.warp * randRange(rng, 0.55, 1.7),
    // Capped at 0.5: past that the archipelago and coastal maps are more sea than
    // land, and the launch scorer starts having to fall back to whatever peak it
    // can find rather than choosing one.
    waterFrac: shape.waterFrac > 0 ? clamp(shape.waterFrac * randRange(rng, 0.8, 1.18), 0.02, 0.5) : 0,
    // Curve is an exponent on the normalised field: it does not scale the terrain,
    // it flattens the lowlands into a basin and stands the peaks out of it, which is
    // the difference between rolling country and peaks-above-a-plain.
    //
    // It was the obvious suspect for the long-glide days and it is not the culprit.
    // Holding it fixed across 60 days moved the hands-off mean from 2391 m to
    // 2291 m and left the tail where it was — inside the sampling noise of a
    // distribution this skewed. The tail is in the base terrain, not in this.
    curve: shape.curve * randRange(rng, 0.9, 1.12),
  }
}

function borderMask(x: number, z: number): number {
  const fx = Math.abs(x) / HALF_WORLD
  const fz = Math.abs(z) / HALF_WORLD
  const f = Math.max(fx, fz)
  return 1 - smoothstep(0.86, 1.0, f) * 0.92
}

/** Bilinear height sample. Clamps outside the map rather than throwing. */
export function sampleHeight(hf: Heightfield, x: number, z: number): number {
  const n = hf.seg + 1
  const fx = clamp((x + HALF_WORLD) / hf.cell, 0, hf.seg - 1e-4)
  const fz = clamp((z + HALF_WORLD) / hf.cell, 0, hf.seg - 1e-4)
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const tx = fx - ix
  const tz = fz - iz
  const i = iz * n + ix
  const h00 = hf.data[i]
  const h10 = hf.data[i + 1]
  const h01 = hf.data[i + n]
  const h11 = hf.data[i + n + 1]
  const a = h00 + (h10 - h00) * tx
  const b = h01 + (h11 - h01) * tx
  return a + (b - a) * tz
}

/** Terrain gradient (dh/dx, dh/dz) by central difference. Drives ridge lift. */
export function sampleGradient(hf: Heightfield, x: number, z: number, out: { x: number; z: number }) {
  const d = hf.cell
  out.x = (sampleHeight(hf, x + d, z) - sampleHeight(hf, x - d, z)) / (2 * d)
  out.z = (sampleHeight(hf, x, z + d) - sampleHeight(hf, x, z - d)) / (2 * d)
  return out
}

/** Surface height for collision — the water plane counts as ground. */
export function surfaceHeight(hf: Heightfield, x: number, z: number): number {
  const h = sampleHeight(hf, x, z)
  return hf.hasWater && h < hf.waterLevel ? hf.waterLevel : h
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v: number) => clamp(v, 0, 1)

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
