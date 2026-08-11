import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Points,
  ShaderMaterial,
} from 'three'
import type { World } from '../sim/world'
import { rgbToHex, type Rgb } from '../sim/palette'
import { meshHeight } from '../sim/terrain'
import { mulberry32 } from '../sim/rng'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS, patchAirFog } from './atmosphere'
import { merge, translated, rotatedX, rotatedZ, scaled, mix, scale } from './Trees'

/**
 * The day's landmark, drawn. Which biome gets what — and where it stands — is
 * decided in sim/landmark.ts; this file only knows how each kind looks and moves.
 *
 * Two of the kinds are instruments as much as scenery: the vent's smoke leans
 * downwind, and the lighthouse's beam sweeps, which is what makes a static white
 * tower read as *the* lighthouse from three kilometres out. The other four are
 * pure places — built once per world, no per-frame work at all. None of them
 * collide — nothing in this game does but the ground.
 */
export function Landmarks({ world }: { world: World }) {
  switch (world.landmark.kind) {
    case 'lighthouse':
      return <Lighthouse world={world} />
    case 'vent':
      return <VentPlume world={world} />
    case 'cross':
      return <StaticKind world={world} build={buildCross} />
    case 'arch':
      return <StaticKind world={world} build={buildArch} />
    case 'bridge':
      return <StaticKind world={world} build={buildBridge} />
    case 'wreck':
      return <StaticKind world={world} build={buildWreck} />
  }
}

/**
 * Shared lifecycle for the static kinds: built once per world, disposed when
 * the world swaps. One component rather than a hook in the switch above, so the
 * hook count stays constant when the day's kind changes. The builders are
 * module-level functions, so the memo's dependencies are honest.
 */
function StaticKind({
  world,
  build,
}: {
  world: World
  build: (world: World) => { group: Group; dispose: () => void }
}) {
  const { group, dispose } = useMemo(() => build(world), [world, build])
  useEffect(() => dispose, [dispose])
  return <primitive object={group} />
}

const WHITE: Rgb = [1, 1, 1]

/**
 * Structures sit on `meshHeight` — the drawn triangles — not the physics
 * surface, and their plinth is sunk a few metres besides: the base straddles a
 * slope the size of itself, and a corner hovering over daylight reads as a bug
 * from any altitude.
 */
const SINK = 2.5

/* ---------------------------------------------------------------- lighthouse */

/** Tall enough to clear the headland scrub, small enough to stay believable. */
const LH_TOWER = 22
const LH_PLINTH = 4
/** Sweep rate, rad/s. A full pass every ~11 s — patient, like the real thing. */
const LH_SWEEP = 0.55
const BEAM_LEN = 260

function Lighthouse({ world }: { world: World }) {
  const { group, beam, dispose } = useMemo(() => {
    const lm = world.landmark!
    const pal = world.palette
    const g = new Group()
    g.position.set(lm.x, meshHeight(world.heightfield, lm.x, lm.z) - SINK, lm.z)

    // One mesh, tints as brightness bands — the same contract as the trees. The
    // dark rings are what make it a lighthouse rather than a grain silo.
    const galleryY = LH_PLINTH + LH_TOWER
    const body = merge([
      { geo: translated(new CylinderGeometry(5.2, 6.0, LH_PLINTH, 8), 0, LH_PLINTH / 2, 0), tint: 0.55 },
      { geo: translated(new CylinderGeometry(2.3, 3.3, LH_TOWER, 10), 0, LH_PLINTH + LH_TOWER / 2, 0), tint: 1.0 },
      // Two contrast bands, slightly proud of the taper so they never z-fight.
      { geo: translated(new CylinderGeometry(3.02, 3.14, 2.6, 10), 0, LH_PLINTH + LH_TOWER * 0.22, 0), tint: 0.42 },
      { geo: translated(new CylinderGeometry(2.62, 2.74, 2.6, 10), 0, LH_PLINTH + LH_TOWER * 0.6, 0), tint: 0.42 },
      // Gallery deck, lantern room, roof cone.
      { geo: translated(new CylinderGeometry(3.4, 3.4, 1.0, 10), 0, galleryY + 0.5, 0), tint: 0.4 },
      { geo: translated(new CylinderGeometry(1.9, 1.9, 2.8, 8), 0, galleryY + 2.4, 0), tint: 1.1 },
      { geo: translated(new ConeGeometry(2.4, 2.6, 8), 0, galleryY + 5.1, 0), tint: 0.38 },
    ])
    // Whitewashed masonry, but in the day's light — off the shore band rather
    // than a literal white, so a dusky grade dims the tower with everything else.
    const bodyMat = new MeshLambertMaterial({
      vertexColors: true,
      color: rgbToHex(mix(pal.sand, WHITE, 0.55)),
    })
    patchAirFog(bodyMat)
    const bodyMesh = new Mesh(body, bodyMat)
    bodyMesh.castShadow = true
    g.add(bodyMesh)

    // The lamp itself: unlit material, so it stays bright inside the tower's own
    // shadow side. It is the one point of the structure meant to be seen first.
    const lampGeo = new IcosahedronGeometry(1.5, 0)
    const lampMat = new MeshBasicMaterial({ color: rgbToHex(mix(pal.sun, WHITE, 0.5)) })
    const lamp = new Mesh(lampGeo, lampMat)
    lamp.position.y = galleryY + 2.4
    g.add(lamp)

    // The sweep: two opposed blades of additive light. Additive and fog-exempt
    // for the same reason the thermal dust is — fog mixes *toward* its colour,
    // which brightens an additive surface instead of hiding it, so the beam
    // simply stays subtle enough to live without a fade.
    const beam = new Group()
    beam.position.y = galleryY + 2.4
    const beamGeo = new PlaneGeometry(BEAM_LEN, 2.2)
    const beamMat = new MeshBasicMaterial({
      color: rgbToHex(mix(pal.sun, WHITE, 0.6)),
      transparent: true,
      opacity: 0.14,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    })
    const blade = new Mesh(beamGeo, beamMat)
    blade.position.x = BEAM_LEN / 2 + 2
    const blade2 = new Mesh(beamGeo, beamMat)
    blade2.position.x = -(BEAM_LEN / 2 + 2)
    beam.add(blade, blade2)
    g.add(beam)

    return {
      group: g,
      beam,
      dispose: () => {
        body.dispose()
        bodyMat.dispose()
        lampGeo.dispose()
        lampMat.dispose()
        beamGeo.dispose()
        beamMat.dispose()
      },
    }
  }, [world])

  useEffect(() => dispose, [dispose])

  useFrame((_, dt) => {
    beam.rotation.y += Math.min(dt, 0.1) * LH_SWEEP
  })

  return <primitive object={group} />
}

/* -------------------------------------------------------------------- plume */

const PLUME_N = 160
/** Metres of column the smoke marks. The thermal above it goes on to 1200. */
const PLUME_SPAN = 480
/** Height-units per second: ~22 m/s of rise, brisk for air, right for a vent. */
const PLUME_RISE = 0.045

/**
 * The volcano's smoke — the one landmark that is weather rather than a building.
 * Same machinery as the thermal dust (parallel state arrays, recycled height,
 * soft procedural discs) with the blending flipped: smoke is matter, not light,
 * so it blends normally and fogs toward the fog colour with distance instead of
 * fading out. That keeps it legible from across the map, which is its job — it
 * is both the landmark and the day's wind sock, leaning downwind as it climbs.
 */
function VentPlume({ world }: { world: World }) {
  const ref = useRef<Points>(null)
  const viewportHeight = useThree((s) => s.size.height * s.viewport.dpr)

  const { geometry, material, state } = useMemo(() => {
    const lm = world.landmark!
    const rng = mulberry32(world.seed ^ 0x51a0)
    const pal = world.palette

    const positions = new Float32Array(PLUME_N * 3)
    const grow = new Float32Array(PLUME_N)
    const angle = new Float32Array(PLUME_N)
    const radius = new Float32Array(PLUME_N)
    const height = new Float32Array(PLUME_N)
    const spin = new Float32Array(PLUME_N)
    for (let i = 0; i < PLUME_N; i++) {
      angle[i] = rng() * Math.PI * 2
      radius[i] = 0.3 + Math.sqrt(rng()) * 0.7
      // Uniform, not base-weighted like the dust: a plume is a column of smoke
      // all the way up, and thinning it with height is the shader's job.
      height[i] = rng()
      spin[i] = 0.15 + rng() * 0.3
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3).setUsage(35048))
    geo.setAttribute('aGrow', new BufferAttribute(grow, 1).setUsage(35048))

    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        // Ash grey off the day's rock, pushed toward the fog so the column sits
        // in the same atmosphere as the terrain behind it.
        uColor: { value: new Color(rgbToHex(mix(scale(pal.rock, 0.75), pal.fog, 0.45))) },
        uSize: { value: 75 },
        uOpacity: { value: 0.42 },
        uViewportH: { value: 1000 },
        ...AIR_FOG_UNIFORMS,
      },
      vertexShader: /* glsl */ `
        uniform float uSize;
        uniform float uViewportH;
        attribute float aGrow;
        varying float vGrow;
        varying vec3 vAirWorld;

        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 0.001);
          // Puffs swell as they rise; the perspective term matches Thermals'.
          float size = uSize * mix(0.3, 1.6, aGrow);
          gl_PointSize = size * (uViewportH * projectionMatrix[1][1] * 0.5) / dist;
          gl_Position = projectionMatrix * mv;
          vGrow = aGrow;
          vAirWorld = position;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vGrow;
        varying vec3 vAirWorld;

        ${AIR_FOG_GLSL}

        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          float t = clamp(1.0 - d * 2.0, 0.0, 1.0);
          // Softer falloff than the dust — smoke has no core to mark.
          float a = t * t;
          // Dense at the vent, dissolving at the top, gone into the sky.
          float body = uOpacity * (1.0 - vGrow * vGrow * 0.85);
          if (a * body <= 0.004) discard;
          // The shared directional haze — the plume must match the terrain it
          // stands on, and the terrain's fog is warm toward the sun now.
          vec3 airRay = vAirWorld - cameraPosition;
          float airDist = length(airRay);
          vec3 col = mix(uColor, airFogColor(airRay / max(airDist, 1e-4)), airFogAmount(airDist, vAirWorld.y));
          gl_FragColor = vec4(col, a * body);
        }
      `,
    })

    return { geometry: geo, material: mat, state: { positions, grow, angle, radius, height, spin, lm } }
  }, [world])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  material.uniforms.uViewportH.value = viewportHeight

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.1)
    const { positions, grow, angle, radius, height, spin, lm } = state

    for (let i = 0; i < PLUME_N; i++) {
      height[i] += PLUME_RISE * d
      if (height[i] > 1) height[i] -= 1
      angle[i] += spin[i] * d

      // Narrow at the vent, broad at the top; the lean is the wind made visible.
      // 0.45 rather than the dust's 0.06 because this column is the day's wind
      // sock — at a 5 m/s wind the top hangs ~130 m downwind of the vent.
      const r = radius[i] * (26 + height[i] * 210)
      const drift = height[i] * PLUME_SPAN * 0.12
      positions[i * 3] = lm.x + Math.cos(angle[i]) * r + world.air.windX * drift * 0.45
      positions[i * 3 + 1] = lm.y + 6 + height[i] * PLUME_SPAN
      positions[i * 3 + 2] = lm.z + Math.sin(angle[i]) * r + world.air.windZ * drift * 0.45
      grow[i] = height[i]
    }

    if (ref.current) {
      ;(ref.current.geometry.attributes.position as BufferAttribute).needsUpdate = true
      ;(ref.current.geometry.attributes.aGrow as BufferAttribute).needsUpdate = true
    }
  })

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} />
}

/* -------------------------------------------------------- the static kinds */

/** One Lambert mesh from merged tinted parts — every static kind is this. */
function lambertGroup(parts: Array<{ geo: BufferGeometry; tint: number }>, color: number) {
  const geo = merge(parts)
  const mat = new MeshLambertMaterial({ vertexColors: true, color })
  patchAirFog(mat)
  const g = new Group()
  const m = new Mesh(geo, mat)
  m.castShadow = true
  g.add(m)
  return {
    group: g,
    dispose: () => {
      geo.dispose()
      mat.dispose()
    },
  }
}

/**
 * Alpine: a summit cross on a cairn. Deliberately the quietest of the seven —
 * it does not need to be seen from afar, because the summit it marks already
 * is. It is the prize for getting there: the highest point of the day's map,
 * exactly, same scan as the vent.
 */
function buildCross(world: World) {
  const lm = world.landmark
  const pal = world.palette
  // Oversized against a real summit cross (~3 m), because at this game's
  // flying distances a true-scale one would be sub-pixel from anywhere.
  const built = lambertGroup(
    [
      { geo: translated(scaled(new IcosahedronGeometry(2.6, 0), 1.25, 0.55, 1.25), 0, 0.9, 0), tint: 1.0 },
      { geo: translated(new BoxGeometry(0.6, 8.5, 0.6), 0, 5.4, 0), tint: 0.34 },
      { geo: translated(new BoxGeometry(4.2, 0.6, 0.6), 0, 7.9, 0), tint: 0.34 },
    ],
    // Cairn in the summit's own rock; the dark tint turns the cross to timber.
    rgbToHex(mix(pal.rock, pal.mineral, 0.35)),
  )
  built.group.position.set(lm.x, meshHeight(world.heightfield, lm.x, lm.z) - 1.0, lm.z)
  return built
}

/**
 * Mesa: a freestanding rock arch. The opening is ~11 m wide and ~13 m clear —
 * a paper plane fits through with room to be brave about it, which is the
 * point: this is the one landmark that is a stunt as much as a place.
 */
function buildArch(world: World) {
  const lm = world.landmark
  const pal = world.palette
  const built = lambertGroup(
    [
      // Tapered five-sided pillars leaning into each other — boxes read as a
      // built gate, and this is supposed to be something the wind made. The
      // lintel's own tilt keeps the top from reading as a machined beam.
      { geo: translated(rotatedZ(new CylinderGeometry(2.0, 3.6, 17, 5), -0.1), -8, 8.2, 0), tint: 1.0 },
      { geo: translated(rotatedZ(new CylinderGeometry(2.0, 3.6, 17, 5), 0.1), 8, 8.2, 0), tint: 0.94 },
      { geo: translated(rotatedZ(scaled(new IcosahedronGeometry(5.2, 0), 2.1, 0.5, 0.95), 0.05), 0, 16.4, 0), tint: 0.88 },
      // Rubble at the feet, so the arch grows out of the ground it stands on.
      { geo: translated(scaled(new IcosahedronGeometry(2.2, 0), 1.1, 0.7, 1.0), -9.5, 0.8, 1.2), tint: 0.9 },
      { geo: translated(scaled(new IcosahedronGeometry(1.7, 0), 1.0, 0.65, 1.2), 9.8, 0.6, -1.0), tint: 0.95 },
    ],
    // The mesa's own strata, pulled hard toward the sand band: the terrain's
    // rock colour alone proved near-black out here against sunlit ground.
    rgbToHex(mix(pal.rock, pal.sand, 0.55)),
  )
  built.group.position.set(lm.x, meshHeight(world.heightfield, lm.x, lm.z) - SINK, lm.z)
  built.group.rotation.y = lm.heading ?? 0
  return built
}

/** Deck length. Two terrain cells: enough to clear the widest drawn river. */
const BRIDGE_SPAN = 64

/**
 * Valley: a stone bridge over the day's river. The site and the yaw come from
 * the drainage tree (sim/landmark.ts); here the deck is set just above the
 * higher bank and the piers drop to whatever ground is actually under them.
 */
function buildBridge(world: World) {
  const lm = world.landmark
  const pal = world.palette
  const hf = world.heightfield
  const heading = lm.heading ?? 0
  // Local +X in world terms, for sampling the ground along the deck.
  const ux = Math.cos(heading)
  const uz = -Math.sin(heading)
  const groundAt = (px: number) => meshHeight(hf, lm.x + ux * px, lm.z + uz * px)
  const deckY = Math.max(groundAt(-BRIDGE_SPAN / 2), groundAt(BRIDGE_SPAN / 2), lm.y + 4) + 1.6

  const parts: Array<{ geo: BufferGeometry; tint: number }> = [
    // Deck runs a little past the span so the ends bury into the banks.
    { geo: translated(new BoxGeometry(BRIDGE_SPAN + 8, 1.8, 7), 0, -0.9, 0), tint: 1.0 },
    { geo: translated(new BoxGeometry(BRIDGE_SPAN + 8, 1.3, 0.9), 0, 0.65, 3.1), tint: 0.8 },
    { geo: translated(new BoxGeometry(BRIDGE_SPAN + 8, 1.3, 0.9), 0, 0.65, -3.1), tint: 0.8 },
  ]
  // Piers wherever they are needed, sized to the ground under each one — the
  // middle one usually stands in the river, which is what sells the bridge,
  // and the outermost pair carries the deck across whichever bank sits lower
  // than the other (the deck is level with the higher one, so without them
  // the low end floats).
  for (const px of [-28, -14, 0, 14, 28]) {
    const bottom = groundAt(px) - SINK - deckY
    // Never shorter than a stub: on a bank that bulges above the deck line the
    // pier just buries itself, which is invisible and correct.
    const h = Math.max(-bottom - 1.5, 2)
    parts.push({ geo: translated(new BoxGeometry(3.2, h, 5.4), px, -1.5 - h / 2, 0), tint: 0.68 })
  }

  // Pulled toward the sand band like the arch: the valley's raw rock colour
  // rendered as rusted iron, and this is supposed to be quarried stone.
  const built = lambertGroup(parts, rgbToHex(mix(pal.rock, pal.sand, 0.5)))
  built.group.position.set(lm.x, deckY, lm.z)
  built.group.rotation.y = heading
  return built
}

/**
 * Archipelago: a shipwreck run aground in the shallows, listing to one side,
 * deck just proud of the swell. Sited a couple of metres under the waterline
 * (sim/landmark.ts), so the hull sits *in* the sea rather than on a beach.
 */
function buildWreck(world: World) {
  const lm = world.landmark
  const pal = world.palette
  const hf = world.heightfield
  // The list: one roll for every hull part, applied before translation.
  const LIST = 0.24
  const built = lambertGroup(
    [
      { geo: translated(rotatedX(rotatedZ(new BoxGeometry(15, 3.2, 4.6), 0.05), LIST), 0, 0.7, 0), tint: 1.0 },
      { geo: translated(rotatedX(new BoxGeometry(3.6, 2.2, 4.2), LIST), -5.9, 2.4, 0.3), tint: 0.85 },
      // The mast leans with the list and then some — a wreck, not a mooring.
      { geo: translated(rotatedZ(new CylinderGeometry(0.2, 0.32, 11, 5), 0.4), 1.8, 5.2, 0.9), tint: 0.7 },
      { geo: translated(rotatedZ(new BoxGeometry(6, 0.45, 0.45), 0.4), 0.6, 6.6, 0.9), tint: 0.62 },
    ],
    // Weathered timber: driftwood grey, well below the palette's own bands.
    rgbToHex(scale(mix(pal.rock, pal.sand, 0.4), 0.55)),
  )
  // On the water, not on the seabed — but never floating over dry land if the
  // fallback ever strands the site ashore.
  const base = Math.min(hf.waterLevel - 0.6, meshHeight(hf, lm.x, lm.z) + 2.2)
  built.group.position.set(lm.x, base, lm.z)
  built.group.rotation.y = lm.heading ?? 0
  return built
}
