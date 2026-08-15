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
import type { MinorLandmark } from '../sim/landmark'
import { rgbToHex, type Rgb } from '../sim/palette'
import { meshHeight } from '../sim/terrain'
import { mulberry32 } from '../sim/rng'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS, patchAirFog } from './atmosphere'
import { merge, translated, rotatedX, rotatedZ, scaled, mix, scale } from './Trees'
import { TONEMAP_GLSL } from './grade'

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
  return (
    <>
      <TheLandmark world={world} />
      <MinorLandmarks world={world} />
    </>
  )
}

function TheLandmark({ world }: { world: World }) {
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

/**
 * Monument scale, not building scale. The first tower was 26 m — believable,
 * and exactly the height of the trees beside it, which made the day's one
 * landmark another item in the scatter. Everything oversized in this game is
 * oversized for the same reason (the reeds say it best: true scale vanishes
 * from a glider), and the landmark is the thing the whole map gets named by.
 */
const LH_TOWER = 52
const LH_PLINTH = 7
/** Sweep rate, rad/s. A full pass every ~11 s — patient, like the real thing. */
const LH_SWEEP = 0.55
const BEAM_LEN = 420

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
      { geo: translated(new CylinderGeometry(9.5, 11, LH_PLINTH, 8), 0, LH_PLINTH / 2, 0), tint: 0.55 },
      { geo: translated(new CylinderGeometry(4.2, 6.4, LH_TOWER, 10), 0, LH_PLINTH + LH_TOWER / 2, 0), tint: 1.0 },
      // Two contrast bands, slightly proud of the taper so they never z-fight.
      { geo: translated(new CylinderGeometry(6.06, 6.3, 4.8, 10), 0, LH_PLINTH + LH_TOWER * 0.22, 0), tint: 0.42 },
      { geo: translated(new CylinderGeometry(5.22, 5.46, 4.8, 10), 0, LH_PLINTH + LH_TOWER * 0.6, 0), tint: 0.42 },
      // Gallery deck, lantern room, roof cone.
      { geo: translated(new CylinderGeometry(6.6, 6.6, 1.8, 10), 0, galleryY + 0.9, 0), tint: 0.4 },
      { geo: translated(new CylinderGeometry(3.6, 3.6, 5.2, 8), 0, galleryY + 4.4, 0), tint: 1.1 },
      { geo: translated(new ConeGeometry(4.6, 5.0, 8), 0, galleryY + 9.4, 0), tint: 0.38 },
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
    const lampGeo = new IcosahedronGeometry(2.9, 0)
    const lampMat = new MeshBasicMaterial({ color: rgbToHex(mix(pal.sun, WHITE, 0.5)) })
    const lamp = new Mesh(lampGeo, lampMat)
    lamp.position.y = galleryY + 4.4
    g.add(lamp)

    // The sweep: two opposed blades of additive light. Additive and fog-exempt
    // for the same reason the thermal dust is — fog mixes *toward* its colour,
    // which brightens an additive surface instead of hiding it, so the beam
    // simply stays subtle enough to live without a fade.
    const beam = new Group()
    beam.position.y = galleryY + 4.4
    const beamGeo = new PlaneGeometry(BEAM_LEN, 4.0)
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
          ${TONEMAP_GLSL}
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
export function buildCross(world: World) {
  const lm = world.landmark
  const pal = world.palette
  // Far past a real summit cross (~3 m): at this game's flying distances a
  // true-scale one is sub-pixel from anywhere, and after the size pass this is
  // a monument you plan a leg around — more Aconcagua's cross by way of Rio.
  const built = lambertGroup(
    [
      { geo: translated(scaled(new IcosahedronGeometry(5.4, 0), 1.25, 0.55, 1.25), 0, 1.9, 0), tint: 1.0 },
      { geo: translated(new BoxGeometry(1.3, 19, 1.3), 0, 11.5, 0), tint: 0.34 },
      { geo: translated(new BoxGeometry(9.4, 1.3, 1.3), 0, 17.2, 0), tint: 0.34 },
    ],
    // Cairn in the summit's own rock; the dark tint turns the cross to timber.
    rgbToHex(mix(pal.rock, pal.mineral, 0.35)),
  )
  built.group.position.set(lm.x, meshHeight(world.heightfield, lm.x, lm.z) - 1.0, lm.z)
  return built
}

/**
 * Mesa: a freestanding rock arch. The opening is ~25 m wide and ~28 m clear —
 * a paper plane fits through with room to be brave about it, which is the
 * point: this is the one landmark that is a stunt as much as a place, and at
 * monument scale the stunt is visible from the launch ridge.
 */
export function buildArch(world: World) {
  const lm = world.landmark
  const pal = world.palette
  const built = lambertGroup(
    [
      // Tapered five-sided pillars leaning into each other — boxes read as a
      // built gate, and this is supposed to be something the wind made. The
      // lintel's own tilt keeps the top from reading as a machined beam.
      { geo: translated(rotatedZ(new CylinderGeometry(4.4, 8.0, 37, 5), -0.1), -17.5, 18, 0), tint: 1.0 },
      { geo: translated(rotatedZ(new CylinderGeometry(4.4, 8.0, 37, 5), 0.1), 17.5, 18, 0), tint: 0.94 },
      { geo: translated(rotatedZ(scaled(new IcosahedronGeometry(11.4, 0), 2.1, 0.5, 0.95), 0.05), 0, 36, 0), tint: 0.88 },
      // Rubble at the feet, so the arch grows out of the ground it stands on.
      { geo: translated(scaled(new IcosahedronGeometry(4.8, 0), 1.1, 0.7, 1.0), -21, 1.7, 2.6), tint: 0.9 },
      { geo: translated(scaled(new IcosahedronGeometry(3.7, 0), 1.0, 0.65, 1.2), 21.5, 1.3, -2.2), tint: 0.95 },
    ],
    // The mesa's own strata, pulled hard toward the sand band: the terrain's
    // rock colour alone proved near-black out here against sunlit ground.
    rgbToHex(mix(pal.rock, pal.sand, 0.55)),
  )
  built.group.position.set(lm.x, meshHeight(world.heightfield, lm.x, lm.z) - SINK - 1.5, lm.z)
  built.group.rotation.y = lm.heading ?? 0
  return built
}

/** Deck length. Three terrain cells: a viaduct, not a footbridge. */
const BRIDGE_SPAN = 96

/**
 * Valley: a stone viaduct over the day's river. The site and the yaw come from
 * the drainage tree (sim/landmark.ts); here the deck rides well above the
 * higher bank and the piers drop to whatever ground is actually under them —
 * the height is the grandeur, and it costs nothing, because the piers already
 * size themselves to reach the ground.
 */
export function buildBridge(world: World) {
  const lm = world.landmark
  const pal = world.palette
  const hf = world.heightfield
  const heading = lm.heading ?? 0
  // Local +X in world terms, for sampling the ground along the deck.
  const ux = Math.cos(heading)
  const uz = -Math.sin(heading)
  const groundAt = (px: number) => meshHeight(hf, lm.x + ux * px, lm.z + uz * px)
  const deckY = Math.max(groundAt(-BRIDGE_SPAN / 2), groundAt(BRIDGE_SPAN / 2), lm.y + 4) + 10

  const parts: Array<{ geo: BufferGeometry; tint: number }> = [
    // Deck runs a little past the span so the ends bury into the banks.
    { geo: translated(new BoxGeometry(BRIDGE_SPAN + 12, 2.6, 9), 0, -1.3, 0), tint: 1.0 },
    { geo: translated(new BoxGeometry(BRIDGE_SPAN + 12, 2.0, 1.2), 0, 1.0, 4.0), tint: 0.8 },
    { geo: translated(new BoxGeometry(BRIDGE_SPAN + 12, 2.0, 1.2), 0, 1.0, -4.0), tint: 0.8 },
  ]
  // Piers wherever they are needed, sized to the ground under each one — the
  // middle one usually stands in the river, which is what sells the bridge.
  // Seven of them, out to the very ends: the old low deck could bury its ends
  // in the banks, but a deck riding ten metres above them cannot, and a
  // viaduct with floating approaches is a bug with masonry on it. The evenly
  // spaced legs are also simply what a viaduct looks like.
  for (const px of [-50, -33.3, -16.7, 0, 16.7, 33.3, 50]) {
    const bottom = groundAt(px) - SINK - deckY
    // Never shorter than a stub: on a bank that bulges above the deck line the
    // pier just buries itself, which is invisible and correct.
    const h = Math.max(-bottom - 1.5, 2)
    parts.push({ geo: translated(new BoxGeometry(4.4, h, 7), px, -2.6 - h / 2, 0), tint: 0.68 })
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
export function buildWreck(world: World) {
  const lm = world.landmark
  const pal = world.palette
  const hf = world.heightfield
  // The list: one roll for every hull part, applied before translation.
  const LIST = 0.24
  const built = lambertGroup(
    [
      { geo: translated(rotatedX(rotatedZ(new BoxGeometry(36, 7, 10.5), 0.05), LIST), 0, 1.6, 0), tint: 1.0 },
      { geo: translated(rotatedX(new BoxGeometry(8.6, 5.2, 9.6), LIST), -14, 5.6, 0.7), tint: 0.85 },
      // The mast leans with the list and then some — a wreck, not a mooring.
      { geo: translated(rotatedZ(new CylinderGeometry(0.5, 0.8, 26, 5), 0.4), 4.3, 12.4, 2.1), tint: 0.7 },
      { geo: translated(rotatedZ(new BoxGeometry(14, 1.0, 1.0), 0.4), 1.4, 15.6, 2.1), tint: 0.62 },
    ],
    // Weathered timber: driftwood grey, well below the palette's own bands.
    rgbToHex(scale(mix(pal.rock, pal.sand, 0.4), 0.55)),
  )
  // On the water, not on the seabed — but never floating over dry land if the
  // fallback ever strands the site ashore. A hull this size sits deeper.
  const base = Math.min(hf.waterLevel - 1.6, meshHeight(hf, lm.x, lm.z) + 2.2)
  built.group.position.set(lm.x, base, lm.z)
  built.group.rotation.y = lm.heading ?? 0
  return built
}

/* ------------------------------------------------------------- the minor tier */

/**
 * The small unnamed things: cairns, standing stones, a fumarole, a buoy, a hot
 * spring. Placement and count are decided in sim/landmark.ts; this file only
 * knows what each one looks like.
 *
 * Two rules separate these from the day's landmark, and both are deliberate.
 * They are *small* — ten metres and change against the landmark's fifty — so
 * that coming across one is a reward for flying low rather than a thing you
 * navigate by. And they are built into one merged geometry per material, with
 * their world positions baked in, so the whole tier costs two or three draw
 * calls and no per-frame work at all. Only the fumarole animates, because a
 * fumarole that does not smoke is a rock with a hole in it.
 */
export function MinorLandmarks({ world }: { world: World }) {
  const { group, dispose } = useMemo(() => buildMinor(world), [world])
  useEffect(() => dispose, [dispose])
  const vents = useMemo(() => world.minor.filter((m) => m.kind === 'fumarole'), [world])
  return (
    <>
      <primitive object={group} />
      {vents.length > 0 && <FumaroleSteam world={world} vents={vents} />}
    </>
  )
}

/** Yaw for a geometry, to sit alongside Trees' rotatedX/rotatedZ. */
const rotatedY = (g: BufferGeometry, a: number) => g.rotateY(a)

/**
 * One pass over the day's minor landmarks, sorting their parts into buckets by
 * what colour they need. Anything stone shares a bucket; the pool and the buoy
 * each need a colour of their own, and neither appears on a map that has the
 * other, so in practice this is one or two meshes.
 */
export function buildMinor(world: World) {
  const pal = world.palette
  const hf = world.heightfield
  const stone: Array<{ geo: BufferGeometry; tint: number }> = []
  const pool: Array<{ geo: BufferGeometry; tint: number }> = []
  const water: Array<{ geo: BufferGeometry; tint: number }> = []
  const vent: Array<{ geo: BufferGeometry; tint: number }> = []
  const paint: Array<{ geo: BufferGeometry; tint: number }> = []

  for (const m of world.minor) {
    // Ground height at the drawn surface, like every other structure, and sunk
    // a little: these sit on slopes small enough to lift a base off the hill.
    const y = meshHeight(hf, m.x, m.z) - 1.2
    switch (m.kind) {
      case 'cairn':
        buildCairn(m, stone, y)
        break
      case 'stones':
        buildStones(m, stone, y)
        break
      case 'fumarole':
        buildFumarole(m, vent, y)
        break
      case 'spring':
        buildSpring(m, pool, water, y)
        break
      case 'buoy':
        buildBuoy(m, paint, hf.waterLevel)
        break
    }
  }

  const g = new Group()
  const dispose: Array<() => void> = []
  const add = (parts: Array<{ geo: BufferGeometry; tint: number }>, color: number) => {
    if (parts.length === 0) return
    const geo = merge(parts)
    const mat = new MeshLambertMaterial({ vertexColors: true, color })
    patchAirFog(mat)
    const mesh = new Mesh(geo, mat)
    mesh.castShadow = true
    // Positions are baked in world space, so the mesh's own box is the whole
    // map and frustum culling on it would be a lie.
    mesh.frustumCulled = false
    g.add(mesh)
    dispose.push(() => {
      geo.dispose()
      mat.dispose()
    })
  }

  // Pulled toward the sand band exactly like the arch and the bridge: raw rock
  // out in the open light renders near-black on most of these palettes.
  add(stone, rgbToHex(mix(pal.rock, pal.sand, 0.55)))
  // Sinter and mineral crust — a hot spring's giveaway from the air is the pale
  // ring around it, not the water.
  add(pool, rgbToHex(mix(pal.sand, WHITE, 0.4)))
  // The pool itself, in the day's own water colour — a spring is the same
  // water as the lakes, just somewhere unlikely.
  add(water, rgbToHex(scale(pal.water, 0.85)))
  // Sulphur crust. Its own colour and not a bright tint on the stone, because
  // the fumarole only ever stands on the volcanic palette, whose rock is so
  // close to black that no multiplier rescues it — at 1.25 tint the cone still
  // rendered as a hole in the hillside. A vent's rim is caked pale anyway.
  add(vent, rgbToHex(mix(mix(pal.rock, pal.sand, 0.5), mix(pal.sun, WHITE, 0.45), 0.62)))
  // The one painted object in the landscape. Buoys are painted to be found.
  add(paint, rgbToHex(mix(pal.sun, WHITE, 0.25)))

  return { group: g, dispose: () => dispose.forEach((d) => d()) }
}

/** A stack of rounded stones, biggest at the bottom, leaning as it goes up. */
function buildCairn(m: MinorLandmark, out: Array<{ geo: BufferGeometry; tint: number }>, y: number) {
  const s = m.scale
  const sizes = [3.4, 2.7, 2.1, 1.5]
  // Start half a stone below ground: the base has to be bedded in the hill, not
  // resting on it, or the whole stack reads as dropped there.
  let h = -sizes[0] * s * 0.25
  sizes.forEach((r, i) => {
    const rr = r * s
    // Stones overlap rather than touch — a stack of tangent spheres is a
    // string of beads, and the first cut of this looked like exactly that.
    h += rr * 0.5
    // Each stone a little off the axis, but only a little: a cairn is stacked
    // by hand, and the first pass leaned so far it read as a rockfall.
    const lean = i * 0.22 * s
    const a = m.heading + i * 1.9
    out.push({
      geo: translated(
        scaled(new IcosahedronGeometry(rr, 0), 1.15, 0.72, 1.05),
        m.x + Math.cos(a) * lean,
        y + h,
        m.z + Math.sin(a) * lean,
      ),
      tint: 1.0 - i * 0.07,
    })
    h += rr * 0.42
  })
}

/** A ring of standing slabs, one fallen. */
function buildStones(m: MinorLandmark, out: Array<{ geo: BufferGeometry; tint: number }>, y: number) {
  const s = m.scale
  const r = 13 * s
  const n = 6
  for (let i = 0; i < n; i++) {
    const a = m.heading + (i / n) * Math.PI * 2
    const x = m.x + Math.cos(a) * r
    const z = m.z + Math.sin(a) * r
    if (i === 2) {
      // The fallen one. A complete ring reads as built yesterday; a gap in it
      // reads as old, which is the whole idea of the thing.
      out.push({
        geo: translated(rotatedY(rotatedZ(new BoxGeometry(9 * s, 3.4 * s, 2.4 * s), 0.08), -a), x, y + 1.4 * s, z),
        tint: 0.82,
      })
      continue
    }
    const h = (8.5 + ((i * 37) % 5)) * s
    out.push({
      // Tilted a few degrees each, alternating, so the ring is weathered
      // rather than machined.
      geo: translated(
        rotatedY(rotatedZ(new BoxGeometry(3.6 * s, h, 1.7 * s), (i % 2 ? 1 : -1) * 0.05), -a),
        x,
        y + h / 2,
        z,
      ),
      tint: 0.95 - (i % 3) * 0.06,
    })
  }
}

/** A low spatter cone with a dark throat. The steam is a separate system. */
function buildFumarole(m: MinorLandmark, out: Array<{ geo: BufferGeometry; tint: number }>, y: number) {
  const s = m.scale
  out.push({
    geo: translated(new CylinderGeometry(5.2 * s, 11 * s, 7 * s, 9), m.x, y + 3.5 * s, m.z),
    tint: 1.0,
  })
  // The throat, dark against the crust, and proud of the cone's lip so the two
  // never z-fight.
  out.push({
    geo: translated(new CylinderGeometry(3.1 * s, 4.4 * s, 2.2 * s, 9), m.x, y + 7.3 * s, m.z),
    tint: 0.22,
  })
}

/**
 * A steaming pool: a sunk disc of water inside a raised sinter rim. The rim
 * and the water go into different buckets because they are different colours —
 * as a dark tint on the sinter the water came out brown, which is a mud
 * puddle. The pale ring around dark water is the whole signature of the thing
 * from the air.
 */
function buildSpring(
  m: MinorLandmark,
  rim: Array<{ geo: BufferGeometry; tint: number }>,
  water: Array<{ geo: BufferGeometry; tint: number }>,
  y: number,
) {
  const s = m.scale
  rim.push({ geo: translated(new CylinderGeometry(15 * s, 17 * s, 1.6 * s, 16), m.x, y + 0.8 * s, m.z), tint: 1.0 })
  water.push({ geo: translated(new CylinderGeometry(12 * s, 12 * s, 1.2 * s, 16), m.x, y + 1.3 * s, m.z), tint: 1.0 })
}

/** A channel buoy: float, mast, topmark. Sits on the waterline, not the bed. */
function buildBuoy(m: MinorLandmark, out: Array<{ geo: BufferGeometry; tint: number }>, waterLevel: number) {
  const s = m.scale
  const y = waterLevel - 1.2
  out.push({ geo: translated(new CylinderGeometry(2.6 * s, 3.4 * s, 5.2 * s, 8), m.x, y + 2.6 * s, m.z), tint: 1.0 })
  out.push({ geo: translated(new ConeGeometry(2.6 * s, 3 * s, 8), m.x, y + 6.7 * s, m.z), tint: 0.72 })
  out.push({ geo: translated(new CylinderGeometry(0.35 * s, 0.35 * s, 7 * s, 5), m.x, y + 11 * s, m.z), tint: 0.5 })
  out.push({ geo: translated(new IcosahedronGeometry(1.5 * s, 0), m.x, y + 14.6 * s, m.z), tint: 0.9 })
}

/** Puffs per fumarole. A wisp, not the vent's column. */
const STEAM_N = 30
/** How high a wisp climbs before it is recycled at the throat, metres. */
const STEAM_SPAN = 46
const STEAM_RISE = 0.19

/**
 * Steam off every fumarole on the map, in one buffer and one draw call.
 *
 * The day's vent gets a 200-metre column that doubles as a wind sock; this is
 * the opposite — a thin curl that has usually dissolved by the time it is as
 * tall as the cone it comes out of. It leans downwind for the same reason the
 * vent does, but weakly: near the ground the wisp is still mostly buoyant.
 */
function FumaroleSteam({ world, vents }: { world: World; vents: MinorLandmark[] }) {
  const ref = useRef<Points>(null)
  const viewportHeight = useThree((s) => s.size.height * s.viewport.dpr)

  const { geometry, material, state } = useMemo(() => {
    const rng = mulberry32(world.seed ^ 0x7c31)
    const pal = world.palette
    const n = vents.length * STEAM_N
    const positions = new Float32Array(n * 3)
    const grow = new Float32Array(n)
    const angle = new Float32Array(n)
    const radius = new Float32Array(n)
    const height = new Float32Array(n)
    const spin = new Float32Array(n)
    const src = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      src[i] = Math.floor(i / STEAM_N)
      angle[i] = rng() * Math.PI * 2
      radius[i] = 0.25 + Math.sqrt(rng()) * 0.75
      height[i] = rng()
      spin[i] = 0.2 + rng() * 0.5
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3).setUsage(35048))
    geo.setAttribute('aGrow', new BufferAttribute(grow, 1).setUsage(35048))

    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        // Paler than the vent's ash: this is water vapour, so it takes the
        // day's light rather than the day's rock.
        uColor: { value: new Color(rgbToHex(mix(pal.fog, WHITE, 0.45))) },
        uSize: { value: 34 },
        uOpacity: { value: 0.3 },
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
          float size = uSize * mix(0.35, 1.5, aGrow);
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
          float a = t * t;
          // Gone well before the top of its arc — steam, not smoke.
          float body = uOpacity * (1.0 - vGrow) * (1.0 - vGrow);
          if (a * body <= 0.004) discard;
          vec3 airRay = vAirWorld - cameraPosition;
          float airDist = length(airRay);
          vec3 col = mix(uColor, airFogColor(airRay / max(airDist, 1e-4)), airFogAmount(airDist, vAirWorld.y));
          gl_FragColor = vec4(col, a * body);
          ${TONEMAP_GLSL}
        }
      `,
    })

    return { geometry: geo, material: mat, state: { positions, grow, angle, radius, height, spin, src } }
  }, [world, vents])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame((_, dt) => {
    material.uniforms.uViewportH.value = viewportHeight
    const d = Math.min(dt, 0.1)
    const { positions, grow, angle, radius, height, spin, src } = state
    for (let i = 0; i < src.length; i++) {
      height[i] += STEAM_RISE * d
      if (height[i] > 1) height[i] -= 1
      angle[i] += spin[i] * d
      const v = vents[src[i]]
      const r = radius[i] * (3 + height[i] * 26) * v.scale
      const drift = height[i] * STEAM_SPAN * 0.1
      positions[i * 3] = v.x + Math.cos(angle[i]) * r + world.air.windX * drift * 0.3
      positions[i * 3 + 1] = v.y + 7 * v.scale + height[i] * STEAM_SPAN
      positions[i * 3 + 2] = v.z + Math.sin(angle[i]) * r + world.air.windZ * drift * 0.3
      grow[i] = height[i]
    }
    if (ref.current) {
      ;(ref.current.geometry.attributes.position as BufferAttribute).needsUpdate = true
      ;(ref.current.geometry.attributes.aGrow as BufferAttribute).needsUpdate = true
    }
  })

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} />
}
