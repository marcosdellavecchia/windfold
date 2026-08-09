import { useEffect, useMemo } from 'react'
import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Euler,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import type { RestPoint } from '../game/net'
import { mulberry32 } from '../sim/rng'
import { sampleGradient, sampleHeight, surfaceHeight } from '../sim/terrain'
import { buildDart } from './PaperPlane'

/**
 * Where other players' flights ended, as paper on the ground.
 *
 * This is the whole presence idea in one image: a beach below a popular
 * thermal run drifted with pale darts, an untouched far ridge still pristine —
 * the world reads where humanity flew the way snow reads footprints. Landed
 * planes sit upright, as if set down; crashed ones lie crumpled, part-buried.
 * No names, no motion, no interaction: just consequences, accumulating.
 *
 * One instanced draw call, capped. Planes that came to rest on water are
 * skipped — paper does not float for two weeks.
 */
const MAX = 400

export function RestingPlanes({ world, rests }: { world: World; rests: RestPoint[] | null }) {
  const mesh = useMemo(() => {
    const m = new InstancedMesh(
      buildDart(),
      new MeshLambertMaterial({ vertexColors: true, side: 2 }),
      MAX,
    )
    m.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
    m.frustumCulled = false
    m.count = 0
    return m
  }, [])

  useEffect(
    () => () => {
      mesh.geometry.dispose()
      ;(mesh.material as MeshLambertMaterial).dispose()
    },
    [mesh],
  )

  useEffect(() => {
    const hf = world.heightfield
    const pal = world.palette
    // Deterministic per world, so everyone sees the same drift of paper.
    const rng = mulberry32(world.seed ^ 0x9e57)
    const pos = new Vector3()
    const quat = new Quaternion()
    const scl = new Vector3()
    const mtx = new Matrix4()
    const eul = new Euler()
    const color = new Color()
    const grad = { x: 0, z: 0 }

    let n = 0
    for (const r of rests ?? []) {
      if (n >= MAX) break
      const ground = sampleHeight(hf, r.x, r.z)
      // Skip water arrivals; the sea keeps what it catches.
      if (hf.hasWater && ground < hf.waterLevel + 0.5) continue

      const yaw = rng() * Math.PI * 2
      if (r.landed) {
        // Set down on the slope, wings level with the ground it stopped on.
        sampleGradient(hf, r.x, r.z, grad)
        eul.set(Math.atan2(grad.z, 1) * 0.6, yaw, -Math.atan2(grad.x, 1) * 0.6)
        pos.set(r.x, surfaceHeight(hf, r.x, r.z) + 0.25, r.z)
      } else {
        // Crumpled: nosed in at some angle, one wing high, slightly buried.
        eul.set(-0.5 - rng() * 0.7, yaw, (rng() - 0.5) * 2.2)
        pos.set(r.x, surfaceHeight(hf, r.x, r.z) + 0.05, r.z)
      }
      quat.setFromEuler(eul)
      const s = 0.8 + rng() * 0.25
      scl.set(s, s, s)
      mtx.compose(pos, quat, scl)
      mesh.setMatrixAt(n, mtx)

      // Weathered paper: white sun-bleached toward the day's ground colour, a
      // little more faded the longer it has notionally lain there.
      const fade = 0.55 + rng() * 0.35
      color.setRGB(
        0.92 * fade + pal.low[0] * (1 - fade) * 0.9,
        0.92 * fade + pal.low[1] * (1 - fade) * 0.9,
        0.9 * fade + pal.low[2] * (1 - fade) * 0.9,
      )
      mesh.setColorAt(n, color)
      n++
    }

    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [mesh, world, rests])

  return <primitive object={mesh} />
}
