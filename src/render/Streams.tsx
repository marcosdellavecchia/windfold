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
import { rgbToHex } from '../sim/palette'
import { meshHeight, type Heightfield } from '../sim/terrain'
import { CLOUD_SHADOW_GLSL, FOG_DENSITY, cloudShadowSeed } from './atmosphere'

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
/** Metres across, at the threshold and at full flow. */
const WIDTH_MIN = 7
const WIDTH_MAX = 22
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
const SUB = 3
/**
 * Relaxation passes that round off the eight-way zigzag before the spline runs.
 *
 * The spline alone curves *through* every node, so on its own it reproduces each
 * 45-degree kink as a faithful, curvy 45-degree kink. Pulling each node toward
 * its neighbours first takes the amplitude out of the zigzag, and then there is
 * something worth interpolating.
 */
const SMOOTH_PASSES = 2

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
    const touched: number[] = []
    const mark = (i: number) => {
      px[i] = -half + (i % n) * hf.cell
      pz[i] = -half + ((i / n) | 0) * hf.cell
    }
    for (let i = 0; i < count; i++) {
      if (!isChannel(i)) continue
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
    /** -1 to 1 across the ribbon, for the edge fade. */
    const side = new Float32Array(quads * 4)
    /** Downstream direction in xz, so the surface scrolls the way the water goes. */
    const flow = new Float32Array(quads * 4 * 2)
    /** 0..1 whitewater, from how hard the stretch falls. */
    const foam = new Float32Array(quads * 4)
    const idx = new Uint32Array(quads * 6)

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

      const narrow = 1 - 0.55 * Math.min(1, slopeAt(hf, i, n) / 0.6)
      const wa = (WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * norm(hf.wet[i])) * 0.5 * narrow
      const wb = (WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * norm(hf.wet[j])) * 0.5 * narrow

      const straight = Math.hypot(bx - ax, bz - az) || 1
      // Whitewater where it falls steeply. Real streams are white exactly where
      // they are steep, and it is the one cue that separates a river from a
      // painted line at any distance.
      const fall = Math.min(1, Math.max(0, (hf.data[i] - hf.data[j]) / straight / 0.22))

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

        const l0x = cx[k] - t0z * w0
        const l0z = cz[k] + t0x * w0
        const r0x = cx[k] + t0z * w0
        const r0z = cz[k] - t0x * w0
        const l1x = cx[k + 1] - t1z * w1
        const l1z = cz[k + 1] + t1x * w1
        const r1x = cx[k + 1] + t1z * w1
        const r1z = cz[k + 1] - t1x * w1

        const p = v * 3
        pos[p] = l0x
        pos[p + 1] = edgeY(hf, y0, l0x, l0z)
        pos[p + 2] = l0z
        pos[p + 3] = r0x
        pos[p + 4] = edgeY(hf, y0, r0x, r0z)
        pos[p + 5] = r0z
        pos[p + 6] = l1x
        pos[p + 7] = edgeY(hf, y1, l1x, l1z)
        pos[p + 8] = l1z
        pos[p + 9] = r1x
        pos[p + 10] = edgeY(hf, y1, r1x, r1z)
        pos[p + 11] = r1z

        side[v] = 1
        side[v + 1] = -1
        side[v + 2] = 1
        side[v + 3] = -1
        flow[v * 2] = t0x
        flow[v * 2 + 1] = t0z
        flow[(v + 1) * 2] = t0x
        flow[(v + 1) * 2 + 1] = t0z
        flow[(v + 2) * 2] = t1x
        flow[(v + 2) * 2 + 1] = t1z
        flow[(v + 3) * 2] = t1x
        flow[(v + 3) * 2 + 1] = t1z
        foam[v] = fall
        foam[v + 1] = fall
        foam[v + 2] = fall
        foam[v + 3] = fall

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
        uTime: { value: 0 },
        uCloudWind: { value: new Vector2(world.air.windX, world.air.windZ) },
        uCloudSeed: { value: cloudShadowSeed(world.seed) },
      },
      vertexShader: /* glsl */ `
        attribute float aSide;
        attribute vec2 aFlow;
        attribute float aFoam;
        varying float vSide;
        varying vec2 vFlow;
        varying float vFoam;
        varying vec3 vWorld;
        varying float vFogAmt;
        void main() {
          vec4 world4 = modelMatrix * vec4(position, 1.0);
          vWorld = world4.xyz;
          vSide = aSide;
          vFlow = aFlow;
          vFoam = aFoam;
          vec4 mv = viewMatrix * world4;
          float f = length(mv.xyz) * ${FOG_DENSITY.toFixed(6)};
          vFogAmt = 1.0 - exp(-f * f);
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
        varying float vSide;
        varying vec2 vFlow;
        varying float vFoam;
        varying vec3 vWorld;
        varying float vFogAmt;

        ${CLOUD_SHADOW_GLSL}

        /** The sky's own gradient — the same two steps Sky.tsx and the lake use. */
        vec3 skyTone(float up) {
          vec3 s = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.55, up));
          return mix(uFog, s, smoothstep(-0.03, 0.28, up));
        }

        float ripple(vec2 p) {
          return csNoise(p * 0.42) * 0.6 + csNoise(p * 1.15 + 4.2) * 0.4;
        }

        void main() {
          // The surface, dragged downstream. Sampling at a position that slides
          // along the flow direction makes the water move *with the valley*
          // rather than in one direction across the whole map, and it costs an
          // attribute rather than a second texture.
          vec2 drift = vWorld.xz - vFlow * (uTime * 7.0);
          float r0 = ripple(drift);
          float e = 1.6;
          float rx = ripple(drift + vec2(e, 0.0)) - r0;
          float rz = ripple(drift + vec2(0.0, e)) - r0;

          // Pale at the banks, deeper mid-channel: a stream really is shallow at
          // its edges, and it stops the ribbon reading as a flat decal.
          float mid = 1.0 - abs(vSide);
          vec3 body = mix(uShallow, mix(uShallow, uDeep, 0.6), smoothstep(0.15, 0.85, mid));

          // The same reflection the lake has, for the same reason: a surface that
          // returns one fixed colour is not read as a surface. Chop only — the
          // ribbon is level across its width, so the sheet is flat and the waves
          // are all there is to tilt it.
          vec3 nrm = normalize(vec3(-rx * 2.2, 1.0, -rz * 2.2));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 refl = reflect(-viewDir, nrm);
          vec3 skyCol = skyTone(mix(max(refl.y, 0.0), 0.8, 0.45));
          float fres = pow(1.0 - clamp(dot(nrm, viewDir), 0.0, 1.0), 4.0);
          vec3 col = mix(body, skyCol, clamp(fres, 0.0, 0.42));
          col *= 0.94 + r0 * 0.12;

          // Whitewater where it falls steeply, and a little at the edges where
          // the water is breaking over the bank.
          float white = vFoam * (0.35 + 0.65 * smoothstep(0.35, 0.9, r0));
          white += (1.0 - smoothstep(0.0, 0.45, mid)) * 0.25;
          col = mix(col, vec3(1.0), clamp(white, 0.0, 0.8) * 0.55);

          col *= cloudShadow(vWorld.xz, uCloudWind, uTime, uCloudSeed);
          col = mix(col, uFog, vFogAmt);

          // Feathered edges. The ribbon is a strip laid on a hillside, and a hard
          // boundary would draw its own outline; fading the last fifth lets the
          // water sit in the ground rather than on it.
          gl_FragColor = vec4(col, smoothstep(0.0, 0.22, mid) * 0.92);
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
