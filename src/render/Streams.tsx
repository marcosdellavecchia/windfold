import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  Vector2,
} from 'three'
import type { World } from '../sim/world'
import { rgbToHex, type Rgb } from '../sim/palette'
import { meshHeight, type Heightfield } from '../sim/terrain'
import { Noise2D } from '../sim/noise'
import { mulberry32 } from '../sim/rng'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS, CLOUD_SHADOW_GLSL, cloudShadowSeed } from './atmosphere'
import { TONEMAP_GLSL } from './grade'

/**
 * Rivers, as geometry.
 *
 * Water in this game is one plane at one altitude, and a river runs downhill, so
 * for a long time the `rivers` landform carved channels that stayed bone dry. The
 * terrain paints a damp seam along the drainage, but a vertex is 32 m from its
 * neighbours, so the narrowest mark that paint can make is wider than most rivers
 * and it can only ever say "the valley is damp here".
 *
 * This is the other half. The accumulation pass had to choose a downstream
 * neighbour for every cell, and that set of choices is a tree whose branches are
 * the watercourses; `flowTo` keeps it. Each channel cell contributes the stretch
 * between itself and the cell it drains into, and the result follows the valley
 * floor downhill — the one thing a flat plane can never do.
 *
 * A stretch per cell rather than traced polylines, deliberately. Tracing from
 * every channel head down to the sea walks the trunk once per tributary and has
 * to dedupe; going per cell visits each exactly once and gets confluences for
 * nothing, because two tributaries simply both emit into the same node.
 */

/** Flow below this is a damp seam and not a stream; the terrain paint has it. */
const CHANNEL = 0.5
/**
 * Shortest watercourse worth drawing, end to end, in metres.
 *
 * The drainage comes out as a set of separate networks — one per catchment that
 * reaches the sea, the map edge or a closed basin — and most of them are trunks
 * with tributaries. A few are not: a catchment can cross the flow threshold a
 * couple of cells before it arrives at a basin, and what gets drawn is a hundred
 * metres of river lying in the landscape with no source and no mouth. That reads
 * as a mistake from the air, because it is one.
 *
 * Ten cells. Below that there is not enough length to see a direction in, and the
 * terrain's damp paint still marks the valley, so the ground does not go dry —
 * it just stops claiming there is a river in it.
 */
const MIN_LENGTH = 320
/** Metres across, at the threshold and at full flow. */
const WIDTH_MIN = 7
const WIDTH_MAX = 22
/**
 * Floor on the finished width, after the steepness and the wobble have both had
 * a go at it. Between them they could take a headwater stream under three
 * metres, and since the outer fifth of the ribbon is feathered to nothing that
 * leaves well under a metre of solid water — which is a sub-pixel thread from
 * any altitude worth flying at, so it simply disappears.
 */
const WIDTH_FLOOR = 4.5
/** What a spring is, as a fraction of the width it would otherwise start at. */
const HEAD_TAPER = 0.16
/**
 * Metres of daylight between the ribbon and the ground it lies on.
 *
 * Small enough to sit in the channel, large enough not to z-fight with a triangle
 * that dips away under the width of it.
 */
const LIFT = 0.7
/**
 * Pieces each cell-to-cell stretch is drawn in.
 *
 * The drainage tree is eight-way: every cell drains to one of eight neighbours,
 * so every direction change is a multiple of 45 degrees, and a river drawn
 * straight from node to node is a staircase of hard corners. That is exactly what
 * it looked like. Splitting each stretch and running it through a Catmull-Rom
 * spline turns those corners into bends, for three times the triangles of
 * something that was already costing under a hundred kilobytes.
 */
const SUB = 4
/**
 * Relaxation passes that round off the eight-way zigzag before the spline runs.
 *
 * The spline alone curves *through* every node, so on its own it reproduces each
 * 45-degree kink as a faithful, curvy 45-degree kink. Pulling each node toward
 * its neighbours first takes the amplitude out of the zigzag, and then there is
 * something worth interpolating.
 */
const SMOOTH_PASSES = 2
/**
 * How much the width wanders, and over what distance.
 *
 * Width from flow alone makes two perfectly parallel curves — an extruded strip,
 * which is what it looked like. A real river is pinching and opening the whole
 * way down: bars, narrows, wide slow reaches. At a 140 m wavelength consecutive
 * nodes stay close enough to vary smoothly rather than to flicker, since they are
 * only 32 to 45 m apart.
 */
const WOBBLE = 0.34
const WOBBLE_SCALE = 140
/**
 * How much wider the mesh is built than the water it will end up showing.
 *
 * A lake's outline is not drawn: it is wherever the terrain crosses the water
 * plane, and the shader finds it per pixel. That is the whole reason a lake reads
 * as natural and an extruded ribbon does not — the ribbon's outline is a polyline
 * through vertices eleven metres apart, and at close range those facets are
 * exactly what you see.
 *
 * So the mesh here is only a conservative bound, comfortably larger than the
 * river, and the fragment shader decides where the water actually stops. The
 * silhouette then has pixel resolution rather than vertex resolution, and it can
 * take a noise term along the way and come out ragged like a bank instead of
 * parallel like a road marking.
 */
const BOUND = 1.55

export function Streams({ world }: { world: World }) {
  const { mesh, material } = useMemo(() => {
    const hf = world.heightfield
    const pal = world.palette
    const n = hf.seg + 1
    const half = hf.size / 2
    const count = hf.wet.length

    const isChannel = (i: number) =>
      hf.wet[i] > CHANNEL && hf.flowTo[i] >= 0 && !(hf.hasWater && hf.data[i] <= hf.waterLevel)

    // --- the network, smoothed ------------------------------------------------
    // Positions start on the grid and relax toward their neighbours. Only xz is
    // carried here at all: height is read off the ground once the centreline is
    // final, because a smoothed path is no longer over the cell it came from.
    let px = new Float32Array(count)
    let pz = new Float32Array(count)
    let qx = new Float32Array(count)
    let qz = new Float32Array(count)
    // Every channel cell, grouped into networks, with anything too short to be a
    // river dropped before a single vertex is built for it.
    //
    // A network is found by walking downstream and keeping the last cell reached
    // — cheap here because the walk is bounded: `flowTo` is a tree with no cycles
    // by construction, and the path memoises, so this is linear overall.
    const mouth = new Int32Array(count).fill(-1)
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
    // Length along the longest single thread of each network — its trunk — rather
    // than the sum of every branch in it. A hundred short tributaries adding up
    // to a kilometre is still a hundred short tributaries.
    const trunk = new Map<number, number>()
    const runTo = new Float32Array(count)
    const channels: number[] = []
    for (let i = 0; i < count; i++) if (isChannel(i)) channels.push(i)
    // Springs first and confluences only once both tributaries have arrived, so
    // each cell's run is final before anything downstream reads it. `wet` looks
    // like it would order this and does not: it saturates, so every cell along a
    // trunk carries the same 1.0 and their order would be arbitrary.
    const waiting = new Int32Array(count)
    for (const i of channels) if (isChannel(hf.flowTo[i])) waiting[hf.flowTo[i]]++
    const queue = channels.filter((i) => waiting[i] === 0)
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]
      const d = hf.flowTo[i]
      const run = runTo[i] + stretch(i)
      if (run > runTo[d]) runTo[d] = run
      const m = outletOf(i)
      if (run > (trunk.get(m) ?? 0)) trunk.set(m, run)
      if (isChannel(d) && --waiting[d] === 0) queue.push(d)
    }

    const touched: number[] = []
    const mark = (i: number) => {
      px[i] = -half + (i % n) * hf.cell
      pz[i] = -half + ((i / n) | 0) * hf.cell
    }
    for (const i of channels) {
      if ((trunk.get(outletOf(i)) ?? 0) < MIN_LENGTH) continue
      touched.push(i)
      mark(i)
      mark(hf.flowTo[i])
      const dd = hf.flowTo[hf.flowTo[i]]
      if (dd >= 0) mark(dd)
    }

    // The strongest tributary into each node — the one the trunk should be
    // considered to continue from. Taking any upstream neighbour would make the
    // spline swing toward whichever side creek happened to be visited first.
    const mainUp = new Int32Array(count).fill(-1)
    for (const i of touched) {
      const j = hf.flowTo[i]
      if (mainUp[j] < 0 || hf.wet[i] > hf.wet[mainUp[j]]) mainUp[j] = i
    }

    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      qx.set(px)
      qz.set(pz)
      for (const i of touched) {
        const u = mainUp[i]
        const d = hf.flowTo[i]
        const ux = u >= 0 ? px[u] : px[i]
        const uz = u >= 0 ? pz[u] : pz[i]
        const dx = d >= 0 ? px[d] : px[i]
        const dz = d >= 0 ? pz[d] : pz[i]
        qx[i] = px[i] * 0.5 + (ux + dx) * 0.25
        qz[i] = pz[i] * 0.5 + (uz + dz) * 0.25
      }
      ;[px, qx] = [qx, px]
      ;[pz, qz] = [qz, pz]
    }

    // --- ribbon ---------------------------------------------------------------
    const quads = touched.length * SUB
    const pos = new Float32Array(quads * 4 * 3)
    /** Signed metres from the centreline. The mesh reaches BOUND; water does not. */
    const side = new Float32Array(quads * 4)
    /** Metres the water should reach at this point, for the shader to cut against. */
    const halfW = new Float32Array(quads * 4)
    /** Downstream direction in xz, so the surface scrolls the way the water goes. */
    const flow = new Float32Array(quads * 4 * 2)
    /** 0..1 whitewater, from how hard the stretch falls. */
    const foam = new Float32Array(quads * 4)
    const idx = new Uint32Array(quads * 6)

    const wobbleNoise = new Noise2D(mulberry32(world.seed ^ 0x71e4))
    const halfWidth = (i: number, wet: number) => {
      // Steepness thins it: partly because it is true — a mountain torrent is a
      // crack and a lowland river is broad — and partly because a level ribbon on
      // a steep cross-slope has further to reach before it finds the ground.
      const narrow = 1 - 0.55 * Math.min(1, slopeAt(hf, i, n) / 0.6)
      const wobble = 1 + wobbleNoise.noise(px[i] / WOBBLE_SCALE, pz[i] / WOBBLE_SCALE) * WOBBLE
      const full = (WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * norm(wet)) * narrow * wobble
      return Math.max(full, WIDTH_FLOOR) * 0.5
    }

    // Where fast water lands, it churns. The strongest fall arriving at each
    // node leaves a pool of foam that decays down the next stretch — the
    // bright pad at the foot of every waterfall, which is how the eye finds
    // the waterfall in the first place. Computed before the emit loop,
    // because a stretch's pool comes from the stretches *above* it.
    const fallOf = new Map<number, number>()
    const poolAt = new Map<number, number>()
    for (const i of touched) {
      const j = hf.flowTo[i]
      const straight = Math.hypot(px[j] - px[i], pz[j] - pz[i]) || 1
      const fall = Math.min(1, Math.max(0, (hf.data[i] - hf.data[j]) / straight / 0.22))
      fallOf.set(i, fall)
      if (fall > 0.55) poolAt.set(j, Math.max(poolAt.get(j) ?? 0, fall))
    }

    const cx: number[] = []
    const cz: number[] = []
    let v = 0
    let t = 0

    for (const i of touched) {
      const j = hf.flowTo[i]
      const u = mainUp[i]
      const dd = hf.flowTo[j]

      // Catmull-Rom wants a point either side of the stretch. Where the network
      // ends — a spring at the top, the sea at the bottom — reflect the stretch
      // outward, which carries the curve straight on instead of hooking it.
      const ax = px[i]
      const az = pz[i]
      const bx = px[j]
      const bz = pz[j]
      const p0x = u >= 0 ? px[u] : 2 * ax - bx
      const p0z = u >= 0 ? pz[u] : 2 * az - bz
      const p3x = dd >= 0 ? px[dd] : 2 * bx - ax
      const p3z = dd >= 0 ? pz[dd] : 2 * bz - az

      // A head — nothing upstream carries enough flow to be drawn — starts from
      // almost nothing rather than from the floor width. Without this every
      // spring in the network began as a square-ended plank 4.5 m wide, which is
      // the one place a river has no business having a straight edge at all.
      const wa = halfWidth(i, hf.wet[i]) * (u < 0 ? HEAD_TAPER : 1)
      // A node under the waterline carries no flow of its own — `wet` is zeroed
      // there, because the lake already draws it. Taking its width at face value
      // pinched every river mouth down to the minimum just as it should have been
      // opening out, so the outlet inherits the width of the last dry cell.
      const wb = halfWidth(j, hf.wet[j] > 0 ? hf.wet[j] : hf.wet[i])

      // Whitewater where it falls steeply. Real streams are white exactly where
      // they are steep, and it is the one cue that separates a river from a
      // painted line at any distance. The pool is the churn left by whatever
      // fell into this stretch's head, fading out along the first stretch.
      const fall = fallOf.get(i) ?? 0
      const pool = poolAt.get(i) ?? 0

      cx.length = 0
      cz.length = 0
      for (let k = 0; k <= SUB; k++) {
        const s = k / SUB
        cx.push(catmull(p0x, ax, bx, p3x, s))
        cz.push(catmull(p0z, az, bz, p3z, s))
      }

      for (let k = 0; k < SUB; k++) {
        const s0 = k / SUB
        const s1 = (k + 1) / SUB
        // Tangents from each point's neighbours, so the cross-section turns with
        // the bend rather than with the chord of one piece.
        const [t0x, t0z] = tangent(cx, cz, k)
        const [t1x, t1z] = tangent(cx, cz, k + 1)
        const w0 = wa + (wb - wa) * s0
        const w1 = wa + (wb - wa) * s1
        // Height from the ground the centreline is actually over, not carried
        // along from the grid node it started at.
        //
        // Interpolating the node heights was the obvious thing and it does not
        // survive the smoothing: relaxing the path moves it off the drainage
        // line, and on steep ground ten metres sideways is enough for the hill
        // to fall away underneath. Measured that way, a sixth of the ribbon on
        // an alpine map hung more than a metre and a half clear of the ground.
        const y0 = surfaceY(hf, cx[k], cz[k])
        const y1 = surfaceY(hf, cx[k + 1], cz[k + 1])

        // The mesh runs out to BOUND; the water stops somewhere inside it. Heights
        // are taken at the *water's* edge rather than at the bound, so the surface
        // stays flat across the part that will actually be drawn instead of being
        // dragged down by ground the shader is about to discard.
        const b0 = w0 * BOUND
        const b1 = w1 * BOUND
        const ey0 = Math.min(
          edgeY(hf, y0, cx[k] - t0z * w0, cz[k] + t0x * w0),
          edgeY(hf, y0, cx[k] + t0z * w0, cz[k] - t0x * w0),
        )
        const ey1 = Math.min(
          edgeY(hf, y1, cx[k + 1] - t1z * w1, cz[k + 1] + t1x * w1),
          edgeY(hf, y1, cx[k + 1] + t1z * w1, cz[k + 1] - t1x * w1),
        )

        const p = v * 3
        pos[p] = cx[k] - t0z * b0
        pos[p + 1] = ey0
        pos[p + 2] = cz[k] + t0x * b0
        pos[p + 3] = cx[k] + t0z * b0
        pos[p + 4] = ey0
        pos[p + 5] = cz[k] - t0x * b0
        pos[p + 6] = cx[k + 1] - t1z * b1
        pos[p + 7] = ey1
        pos[p + 8] = cz[k + 1] + t1x * b1
        pos[p + 9] = cx[k + 1] + t1z * b1
        pos[p + 10] = ey1
        pos[p + 11] = cz[k + 1] - t1x * b1

        // Signed metres from the centreline, and the half-width the water should
        // reach — both in metres, so the shader compares like with like.
        side[v] = -b0
        side[v + 1] = b0
        side[v + 2] = -b1
        side[v + 3] = b1
        halfW[v] = w0
        halfW[v + 1] = w0
        halfW[v + 2] = w1
        halfW[v + 3] = w1
        flow[v * 2] = t0x
        flow[v * 2 + 1] = t0z
        flow[(v + 1) * 2] = t0x
        flow[(v + 1) * 2 + 1] = t0z
        flow[(v + 2) * 2] = t1x
        flow[(v + 2) * 2 + 1] = t1z
        flow[(v + 3) * 2] = t1x
        flow[(v + 3) * 2 + 1] = t1z
        const f0 = Math.max(fall, pool * Math.pow(1 - s0, 1.5))
        const f1 = Math.max(fall, pool * Math.pow(1 - s1, 1.5))
        foam[v] = f0
        foam[v + 1] = f0
        foam[v + 2] = f1
        foam[v + 3] = f1

        idx[t] = v
        idx[t + 1] = v + 1
        idx[t + 2] = v + 2
        idx[t + 3] = v + 1
        idx[t + 4] = v + 3
        idx[t + 5] = v + 2
        v += 4
        t += 6
      }
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(pos, 3))
    geo.setAttribute('aSide', new BufferAttribute(side, 1))
    geo.setAttribute('aHalf', new BufferAttribute(halfW, 1))
    geo.setAttribute('aFlow', new BufferAttribute(flow, 2))
    geo.setAttribute('aFoam', new BufferAttribute(foam, 1))
    geo.setIndex(new BufferAttribute(idx, 1))
    geo.computeBoundingSphere()

    const mat = new ShaderMaterial({
      transparent: true,
      side: DoubleSide,
      // The ribbon hugs ground it is only centimetres above, and nothing is ever
      // behind a river. Skipping the depth write removes the last place the two
      // surfaces could argue about which is in front.
      depthWrite: false,
      uniforms: {
        // Exactly the tones the lake is built from, for a reason that took a
        // while to see: `water` is not an airborne colour, so it takes the day's
        // *ground* hue rotation while the sky takes the sky one. On a violet day
        // `pal.water` stays blue — the lakes look violet because they are
        // reflecting a violet sky. A river mixing a token amount of sky therefore
        // came out blue on a map whose water was plainly not. Sharing the lake's
        // tones *and* its reflection is what makes the two agree on every palette
        // rather than on the ones that happen to line up.
        uDeep: { value: new Color(rgbToHex(pal.water)).multiplyScalar(0.5) },
        uShallow: { value: new Color(rgbToHex(pal.water)).multiplyScalar(1.45) },
        uSkyTop: { value: new Color(rgbToHex(pal.skyTop)) },
        uSkyHorizon: { value: new Color(rgbToHex(pal.skyHorizon)) },
        uFog: { value: new Color(rgbToHex(pal.fog)) },
        // The bed. `sand` is the shore tone the terrain already paints at every
        // waterline, so a river running over it agrees with the beaches on the
        // same map by construction rather than by a second guess at the palette.
        uBed: { value: new Color(rgbToHex(pal.sand)) },
        // The day's light, as a tint that carries hue without carrying
        // brightness — the same trick the terrain uses on its slopes. Sun only:
        // blending ambient in made it measurably worse, because ambient is the
        // sky's own cool colour and it cancelled the warmth this exists to add.
        //
        // Everything else in the scene is lit: the terrain is multiplied by sun
        // and ambient, and the lake borrows warmth from the sky it reflects. A
        // ShaderMaterial with no lights in it shows raw palette colour, so the
        // river was the one surface on the map wearing none of the day's
        // weather, which is why it stayed cold blue under an orange sunset.
        uLight: { value: new Color(...chromaOf(pal.sunLight)) },
        uSun: { value: new Color(rgbToHex(pal.sun)) },
        uSunDir: { value: world.sunDir.clone() },
        uTime: { value: 0 },
        uCloudWind: { value: new Vector2(world.air.windX, world.air.windZ) },
        uCloudSeed: { value: cloudShadowSeed(world.seed) },
        ...AIR_FOG_UNIFORMS,
      },
      vertexShader: /* glsl */ `
        attribute float aSide;
        attribute float aHalf;
        attribute vec2 aFlow;
        attribute float aFoam;
        varying float vSide;
        varying float vHalf;
        varying vec2 vFlow;
        varying float vFoam;
        varying vec3 vWorld;
        varying float vFogDist;
        void main() {
          vec4 world4 = modelMatrix * vec4(position, 1.0);
          vWorld = world4.xyz;
          vSide = aSide;
          vHalf = aHalf;
          vFlow = aFlow;
          vFoam = aFoam;
          vec4 mv = viewMatrix * world4;
          vFogDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uFog;
        uniform float uTime;
        uniform vec2 uCloudWind;
        uniform float uCloudSeed;
        uniform vec3 uBed;
        uniform vec3 uLight;
        uniform vec3 uSun;
        uniform vec3 uSunDir;
        varying float vSide;
        varying float vHalf;
        varying vec2 vFlow;
        varying float vFoam;
        varying vec3 vWorld;
        varying float vFogDist;

        ${CLOUD_SHADOW_GLSL}
        ${AIR_FOG_GLSL}

        /**
         * The sky's own gradient — the same two steps Sky.tsx and the lake
         * use, with the lake's directional horizon: a river reflecting a warm
         * sky glows on the sunward reach, exactly as the lake it feeds does.
         */
        vec3 skyTone(float up, vec2 az) {
          vec3 h = mix(uSkyHorizon, airFogColor(normalize(vec3(az.x, 0.12, az.y))), 0.55);
          vec3 s = mix(h, uSkyTop, smoothstep(0.0, 0.55, up));
          return mix(uFog, s, smoothstep(-0.03, 0.28, up));
        }

        /**
         * The moving surface. Wavelengths of roughly eleven and four metres,
         * against a river seven to twenty-five wide — so the chop is a few waves
         * across the channel rather than a texture beneath the pixel grid.
         *
         * This was sampled at 0.42, a lattice of 2.4 m, and driven into the
         * normal at more than twice this strength. Sub-metre normal noise gives
         * every pixel a wildly different Fresnel term, which arrives as harsh
         * black and white speckle rather than as water. The lake's own waves are
         * 20 to 80 m and its comments say why: the wavelengths matter more than
         * they look.
         */
        float ripple(vec2 p) {
          return csNoise(p * 0.09) * 0.62 + csNoise(p * 0.25 + 4.2) * 0.38;
        }

        void main() {
          // The surface, dragged downstream. Sampling at a position that slides
          // along the flow direction makes the water move *with the valley*
          // rather than in one direction across the whole map, and it costs an
          // attribute rather than a second texture. Steep water moves fast —
          // the extra speed on a cascade is half of what makes it read as
          // falling rather than as painted white.
          vec2 drift = vWorld.xz - vFlow * (uTime * (4.5 + vFoam * 8.0));
          float r0 = ripple(drift);
          float e = 3.2;
          float rx = ripple(drift + vec2(e, 0.0)) - r0;
          float rz = ripple(drift + vec2(0.0, e)) - r0;

          // Where the water actually stops, decided here rather than by the mesh.
          //
          // The bank wanders on two scales: a long one that opens the river out
          // and pinches it closed over tens of metres, and a short one that
          // roughens the margin itself. Neither is available to geometry at any
          // sane vertex count, and both are what a real edge does. The mesh runs
          // to BOUND either side and everything past this line is thrown away.
          float bank = csNoise(vWorld.xz * 0.021 + 3.1) - 0.5;
          bank += (csNoise(vWorld.xz * 0.115 + 8.7) - 0.5) * 0.45;
          float reach = vHalf * (1.0 + bank * 0.62);
          float dist = abs(vSide);
          // Feathered in metres, not in fractions: a wide river and a narrow one
          // have the same kind of edge, and scaling the softness with the width
          // made big rivers look out of focus.
          float alpha = 1.0 - smoothstep(reach - 1.6, reach, dist);
          if (alpha <= 0.004) discard;

          // Pale at the banks, deeper mid-channel: a stream really is shallow at
          // its edges, and it stops the ribbon reading as a flat decal.
          float mid = clamp(1.0 - dist / max(reach, 0.001), 0.0, 1.0);
          // A shallow stream is not the same optical object as a lake, and
          // treating it as one leaves it navy on a day where every other surface
          // is warm. Two things a real river has and this did not:
          //
          // The bed shows through. A metre of water over sand is mostly the
          // colour of the sand, which is why a desert river is ochre and not
          // blue. Nothing else in the scene was giving this ribbon the day's
          // ground colour — the terrain is lit by the sun and the lake borrows
          // warmth from the sky it reflects, while an unlit strip of raw
          // palette water borrows from neither and sits in the frame as the one
          // cold object on a warm map.
          // Depth across the channel: nothing at the banks, most in the middle.
          float depth = smoothstep(0.2, 0.95, mid);
          // The water column on its own, darker where there is more of it...
          vec3 water = mix(uShallow, uDeep, depth * 0.45);
          // ...and the bed underneath, showing through more at the edges than in
          // the middle but never absent. Blending the bed only at the banks was
          // the first attempt and it changed nothing worth seeing, because the
          // middle of the channel is the part anyone actually looks at.
          vec3 body = mix(uBed, water, 0.6 + depth * 0.12) * uLight;

          // The same reflection the lake has, for the same reason: a surface that
          // returns one fixed colour is not read as a surface. Chop only — the
          // ribbon is level across its width, so the sheet is flat and the waves
          // are all there is to tilt it.
          vec3 nrm = normalize(vec3(-rx * 0.7, 1.0, -rz * 0.7));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 refl = reflect(-viewDir, nrm);
          vec3 skyCol = skyTone(mix(max(refl.y, 0.0), 0.8, 0.45), refl.xz);
          float fres = pow(1.0 - clamp(dot(nrm, viewDir), 0.0, 1.0), 4.0);
          // And a floor under the reflection. Fresnel is right for a lake seen
          // across its length — a grazing view is nearly all sky, which is
          // exactly why the lake in the distance is the colour of the sunset. A
          // river is only ever seen from more or less above, so it never earns
          // any of that and stayed the one surface on the map wearing none of
          // the day's light. The floor is what puts it back in the same weather
          // as everything around it.
          vec3 col = mix(body, skyCol, clamp(fres, 0.38, 0.55));
          col *= 0.96 + r0 * 0.08;

          // Riffle and pool: a river alternates fast shallow water and slow
          // deep reaches every hundred metres or so, and from the air the
          // alternation arrives as brightness. Static by construction — it is
          // the riverbed doing this, not the weather.
          float along = dot(vWorld.xz, vFlow);
          col *= 1.0 + sin(along * 0.05 + csNoise(vWorld.xz * 0.01) * 3.0) * 0.05;

          // Whitewater where it falls steeply, and a trace where it breaks along
          // the bank. The bank term is small: it used to be the loudest thing at
          // the edge and it fought the contact shadow below, which is the cue
          // that actually matters.
          float white = vFoam * (0.35 + 0.65 * smoothstep(0.35, 0.9, r0));
          white += (1.0 - smoothstep(0.08, 0.5, mid)) * 0.12;

          // Cascades. The ripple field is isotropic, so on its own the steepest
          // drop in the network is a pale patch of the same chop as everywhere
          // else. Falling water is streaked *along* the flow: noise squeezed
          // hard across the channel, stretched down it, and pulled downstream
          // faster than the surface — those streaks are what the eye knows a
          // waterfall by, at any distance the river is visible at all. Only the
          // steepest stretches earn it; an ordinary riffle keeps the quiet tint.
          float cascade = smoothstep(0.45, 1.0, vFoam);
          if (cascade > 0.0) {
            float along = dot(vWorld.xz, vFlow);
            float across = dot(vWorld.xz, vec2(-vFlow.y, vFlow.x));
            float rush = csNoise(vec2(across * 0.3, along * 0.05 - uTime * 4.0));
            white += cascade * (0.3 + 0.7 * smoothstep(0.3, 0.85, rush));
          }
          col = mix(col, vec3(1.0), clamp(white, 0.0, 0.9) * (0.55 + cascade * 0.25));

          // A dark line right at the waterline.
          //
          // Water sits below the ground it runs through, so its last metre is in
          // the shadow of its own edge. The grid is far too coarse to cut a bank
          // that could cast one — the narrowest trough 32 m cells can hold is
          // about 96 m across, against a river of fourteen — so the shadow is
          // painted instead. It is the whole difference between a ribbon lying on
          // a hillside and water running through it, and it costs one smoothstep.
          // Tighter and lighter than it was: at 34% over the outer third, a
          // fourteen-metre river was more shadow than water.
          col *= 1.0 - (1.0 - smoothstep(0.0, 0.2, mid)) * 0.2;

          // The same glitter the lake carries. Two surfaces of the same water on
          // the same map should catch the sun the same way, and without it a
          // river stayed matte while the lake beside it sparkled. The road —
          // the broad soft lobe the sparkle sits in — is what lets a whole
          // reach light up when it happens to run toward the sun.
          vec3 hv = normalize(normalize(uSunDir) + viewDir);
          col += uSun * pow(max(dot(nrm, hv), 0.0), 180.0) * 0.7;
          col += uSun * pow(max(dot(nrm, hv), 0.0), 18.0) * 0.15;

          col *= cloudShadow(vWorld.xz, uCloudWind, uTime, uCloudSeed);
          // The shared directional haze, so a distant river hazes to the same
          // colour as the hillside it runs down.
          col = mix(col, airFogColor(-viewDir), airFogAmount(vFogDist, vWorld.y));

          // Feathered edges. The ribbon is a strip laid on a hillside, and a hard
          // boundary would draw its own outline; fading the last fifth lets the
          // water sit in the ground rather than on it.
          gl_FragColor = vec4(col, alpha * 0.92);
          ${TONEMAP_GLSL}
        }
      `,
    })

    const m = new Mesh(geo, mat)
    m.renderOrder = 1
    // A stream network is thin ribbons spread over the whole map, so its bounding
    // sphere is the map: culling it as one object can only cost a test it always
    // passes.
    m.frustumCulled = false
    return { mesh: touched.length > 0 ? m : null, material: mat }
  }, [world])

  // Every world swap builds a new network, and R is pressed a lot. Without this
  // the old buffers stay on the GPU for the life of the tab.
  useEffect(
    () => () => {
      mesh?.geometry.dispose()
      material.dispose()
    },
    [mesh, material],
  )

  useFrame((_, dt) => {
    material.uniforms.uTime.value += Math.min(dt, 0.1)
  })

  if (!mesh) return null
  return <primitive object={mesh} />
}

/**
 * Where the ribbon's centreline sits: on the drawn surface, and never below the
 * lake it is running into — a river reaching water has to meet it flush rather
 * than dive under the plane a few metres short of the shore.
 */
function surfaceY(hf: Heightfield, x: number, z: number): number {
  return Math.max(meshHeight(hf, x, z), hf.hasWater ? hf.waterLevel : -Infinity) + LIFT
}

/**
 * Height of one edge of the ribbon, given where its centreline sits.
 *
 * A water surface is level across its width, and for the width of a stream that
 * is what it should be — so where the bank rises the edge holds the centre's
 * height and simply disappears into the hillside, which is water sitting in a
 * channel and is exactly right.
 *
 * Where the ground falls away it cannot hold. A 32 m grid has no channel narrower
 * than about 64 m in it, so a great deal of this network runs across open
 * hillside with nothing to sit in, and a level ribbon there sticks its outer edge
 * out into the air — measured at up to seventy metres of daylight on the steepest
 * maps, which is a river hanging off a cliff. Dropping the edge to the ground
 * when the ground is below it costs a cross-tilt of a degree or two on a ribbon
 * a few metres wide, which nobody will ever see, and removes the whole failure.
 */
function edgeY(hf: Heightfield, centreY: number, x: number, z: number): number {
  return Math.min(centreY, surfaceY(hf, x, z))
}

/** A colour's hue and saturation with its brightness divided out. */
function chromaOf(c: Rgb): Rgb {
  const mean = (c[0] + c[1] + c[2]) / 3
  return mean < 1e-4 ? [1, 1, 1] : [c[0] / mean, c[1] / mean, c[2] / mean]
}

/** CHANNEL..1 remapped to 0..1, so width tracks flow across the visible range. */
const norm = (w: number) => Math.min(1, Math.max(0, (w - CHANNEL) / (1 - CHANNEL)))

/** Catmull-Rom through p1 and p2, with p0 and p3 setting the tangents. */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

/** Unit direction at point k of a polyline, from its neighbours where it has two. */
function tangent(xs: number[], zs: number[], k: number): [number, number] {
  const a = Math.max(0, k - 1)
  const b = Math.min(xs.length - 1, k + 1)
  const dx = xs[b] - xs[a]
  const dz = zs[b] - zs[a]
  const len = Math.hypot(dx, dz) || 1
  return [dx / len, dz / len]
}

/** Terrain gradient at a grid index, by central difference, clamped at the edge. */
function slopeAt(hf: Heightfield, i: number, n: number): number {
  const ix = i % n
  const iz = (i / n) | 0
  const l = hf.data[iz * n + Math.max(ix - 1, 0)]
  const r = hf.data[iz * n + Math.min(ix + 1, n - 1)]
  const u = hf.data[Math.max(iz - 1, 0) * n + ix]
  const d = hf.data[Math.min(iz + 1, n - 1) * n + ix]
  return Math.hypot(r - l, d - u) / (2 * hf.cell)
}
