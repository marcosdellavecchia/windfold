import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { mulberry32 } from '../sim/rng'

const COLUMNS = 8
const PER_COLUMN = 6
const MAX = COLUMNS * PER_COLUMN
/** Birds in the skein crossing overhead. See MIGRANT_SPAN. */
const MIGRANTS = 11
const TOTAL = MAX + MIGRANTS
/** Re-pick which columns have birds once the camera has moved this far. */
const REASSIGN_AT = 500
/**
 * The skein wraps on a torus this wide around the camera, so it is always
 * somewhere within a couple of kilometres without ever being placed or culled.
 */
const MIGRANT_SPAN = 5600

interface Orbit {
  thermal: number
  radius: number
  height: number
  speed: number
  phase: number
  flap: number
  size: number
}

/**
 * Birds circling in the nearest thermals.
 *
 * Mostly this is here because a landscape you are meant to enjoy looking at should
 * have something alive in it. It doubles as the close-range confirmation that a
 * column is working: dust says "lift somewhere here", a bird turning steadily says
 * "the core is exactly there".
 *
 * Plus one skein crossing high overhead, going somewhere, which is the only thing
 * in the world with anywhere to be. It shares the instanced mesh with the circling
 * birds and is deliberately not tied to a thermal — everything else in the sky
 * means something mechanically, and one element that means nothing is what keeps
 * the others from reading as instrumentation.
 */
export function Birds({ world }: { world: World }) {
  const camera = useThree((s) => s.camera)

  const { mesh, orbits } = useMemo(() => {
    const rng = mulberry32(world.seed ^ 0xb15d)
    const geo = birdGeometry()
    const mat = new MeshBasicMaterial({
      color: new Color(rgbToHex(world.palette.rock)).multiplyScalar(0.26),
      side: DoubleSide,
      fog: true,
    })
    const m = new InstancedMesh(geo, mat, TOTAL)
    m.frustumCulled = false
    // Fixed count: slots with no thermal are written at zero scale rather than
    // packed out, so the skein can keep the tail of the buffer to itself.
    m.count = TOTAL

    const list: Orbit[] = []
    for (let i = 0; i < MAX; i++) {
      list.push({
        thermal: -1,
        radius: 40 + rng() * 120,
        height: 60 + rng() * 380,
        // Mixed directions and rates, so a column reads as a flock rather than a gear.
        speed: (0.22 + rng() * 0.3) * (rng() < 0.5 ? -1 : 1),
        phase: rng() * Math.PI * 2,
        flap: 2.4 + rng() * 2.6,
        size: 3.6 + rng() * 2.4,
      })
    }
    return { mesh: m, orbits: list }
  }, [world])

  const last = useRef(new Vector3(1e9, 0, 1e9))
  const clock = useRef(0)
  const skein = useRef({ x: 0, z: 0 })

  // The skein flies the day's wind, so it is going the same way the player is.
  const { dirX, dirZ, heading } = useMemo(() => {
    const len = Math.hypot(world.air.windX, world.air.windZ) || 1
    const x = world.air.windX / len
    const z = world.air.windZ / len
    // Bird geometry has its nose at +Z, so yaw is measured from +Z.
    return { dirX: x, dirZ: z, heading: Math.atan2(x, z) }
  }, [world])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    clock.current += dt
    const cam = camera.position

    if (last.current.distanceTo(cam) > REASSIGN_AT) {
      last.current.copy(cam)
      const near = world.air.thermals
        .map((t, i) => ({ i, d: (t.x - cam.x) ** 2 + (t.z - cam.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, COLUMNS)
      for (let k = 0; k < MAX; k++) {
        const slot = near[Math.floor(k / PER_COLUMN)]
        orbits[k].thermal = slot ? slot.i : -1
      }
    }

    const t = clock.current
    for (let k = 0; k < MAX; k++) {
      const o = orbits[k]
      const th = world.air.thermals[o.thermal]
      if (!th) {
        SCALE.set(0, 0, 0)
        MATRIX.compose(POS, QUAT, SCALE)
        mesh.setMatrixAt(k, MATRIX)
        continue
      }

      const a = o.phase + t * o.speed
      const x = th.x + Math.cos(a) * o.radius
      const z = th.z + Math.sin(a) * o.radius
      const y = th.base + o.height + Math.sin(t * 0.3 + o.phase) * 12

      // Face along the tangent of the circle, banked into the turn.
      const heading = a + (o.speed > 0 ? Math.PI / 2 : -Math.PI / 2)
      const bank = o.speed > 0 ? 0.5 : -0.5

      POS.set(x, y, z)
      EULER.set(0, -heading, bank)
      QUAT.setFromEuler(EULER)
      // Squashing the span is enough to read as a wingbeat at this distance.
      const flap = 0.55 + 0.45 * Math.abs(Math.sin(t * o.flap + o.phase))
      SCALE.set(o.size, o.size * flap, o.size)
      MATRIX.compose(POS, QUAT, SCALE)
      mesh.setMatrixAt(k, MATRIX)
    }

    // --- the skein ----------------------------------------------------------
    skein.current.x += world.air.windX * 0.55 * dt + dirX * 11 * dt
    skein.current.z += world.air.windZ * 0.55 * dt + dirZ * 11 * dt
    const lead = wrapTo(skein.current.x, cam.x, MIGRANT_SPAN)
    const leadZ = wrapTo(skein.current.z, cam.z, MIGRANT_SPAN)
    const leadY = world.air.cloudBase + 180 + Math.sin(t * 0.11) * 40

    for (let k = 0; k < MIGRANTS; k++) {
      // Alternate out from the leader: 0, +1, -1, +2, -2 … which is a V.
      const rank = (k + 1) >> 1
      const side = k === 0 ? 0 : k % 2 === 1 ? 1 : -1
      // Ragged, because a perfect V reads as a logo.
      const wobble = Math.sin(t * 1.3 + k * 2.1) * 6
      const back = rank * 30 + wobble
      const across = side * rank * 24 + Math.sin(t * 0.9 + k) * 5

      POS.set(
        lead - dirX * back - dirZ * across,
        leadY + Math.sin(t * 0.8 + k * 1.7) * 7,
        leadZ - dirZ * back + dirX * across,
      )
      EULER.set(0, heading, 0)
      QUAT.setFromEuler(EULER)
      const flap = 0.5 + 0.5 * Math.abs(Math.sin(t * 3.1 + k * 0.8))
      SCALE.set(9, 9 * flap, 9)
      MATRIX.compose(POS, QUAT, SCALE)
      mesh.setMatrixAt(MAX + k, MATRIX)
    }

    mesh.instanceMatrix.needsUpdate = true
  })

  return <primitive object={mesh} />
}

/** Nearest image of `v` to `about` on a torus of the given period. */
const wrapTo = (v: number, about: number, period: number) =>
  v - period * Math.round((v - about) / period)

const MATRIX = new Matrix4()
const POS = new Vector3()
const QUAT = new Quaternion()
const EULER = new Euler()
const SCALE = new Vector3()

/** Two triangles in a shallow V — a bird at 300 m is a silhouette, nothing more. */
function birdGeometry(): BufferGeometry {
  const v = [
    // left wing
    0, 0, 0.18, -1, 0.34, -0.1, -0.32, 0.06, -0.2,
    // right wing
    0, 0, 0.18, 0.32, 0.06, -0.2, 1, 0.34, -0.1,
  ]
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(v), 3))
  geo.computeVertexNormals()
  return geo
}
