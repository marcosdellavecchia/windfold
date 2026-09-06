import { useEffect, useMemo } from 'react'
import { Color, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import type { World } from '../sim/world'
import { mulberry32 } from '../sim/rng'
import { HALF_WORLD, meshHeight, sampleGradient } from '../sim/terrain'
import { patchAirFog } from './atmosphere'

/** Part-buried rock shoulders add broken silhouettes to exposed ridges. */
export function Formations({ world }: { world: World }) {
  const mesh = useMemo(() => {
    const geo = new IcosahedronGeometry(1, 1)
    const pos = geo.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const weather = 0.9 + Math.sin(x * 8 + z * 4) * Math.cos(y * 7 - z * 3) * 0.12
      pos.setXYZ(i, x * weather, y * weather, z * weather)
    }
    geo.computeVertexNormals()
    const mat = new MeshStandardMaterial({ roughness: 0.94, flatShading: true })
    patchAirFog(mat)
    const m = new InstancedMesh(geo, mat, 384)
    const rng = mulberry32(world.seed ^ 0x765ab3)
    const matrix = new Matrix4(), p = new Vector3(), scale = new Vector3(), q = new Quaternion(), color = new Color()
    const grad = { x: 0, z: 0 }, up = new Vector3(0, 1, 0)
    let count = 0
    for (let i = 0; i < 2400 && count < 384; i++) {
      const x = (rng() - 0.5) * HALF_WORLD * 1.85, z = (rng() - 0.5) * HALF_WORLD * 1.85
      const h = meshHeight(world.heightfield, x, z)
      if (Math.hypot(x - world.launch.pos.x, z - world.launch.pos.z) < 220) continue
      if (world.heightfield.hasWater && h < world.heightfield.waterLevel + 10) continue
      sampleGradient(world.heightfield, x, z, grad)
      const slope = Math.hypot(grad.x, grad.z)
      if (slope < 0.38 || slope > 1.4) continue
      const heading = Math.atan2(grad.x, grad.z)
      const width = 10 + rng() * 18
      for (let j = 0; j < 3 && count < 384; j++) {
        const px = x + Math.cos(heading) * (j - 1) * width * 0.8
        const pz = z - Math.sin(heading) * (j - 1) * width * 0.8
        const height = 7 + rng() * 14
        p.set(px, meshHeight(world.heightfield, px, pz) - height * 0.32, pz)
        scale.set(width * (0.7 + rng() * 0.5), height, width * 0.58)
        q.setFromAxisAngle(up, heading + rng() * 0.35)
        matrix.compose(p, q, scale); m.setMatrixAt(count, matrix)
        color.setRGB(...world.palette.rock).lerp(new Color().setRGB(...world.palette.mineral), rng() * 0.18).multiplyScalar(0.75 + rng() * 0.28)
        m.setColorAt(count++, color)
      }
    }
    m.count = count; m.castShadow = true; m.receiveShadow = true
    m.computeBoundingSphere()
    return m
  }, [world])
  useEffect(() => () => { mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); mesh.dispose() }, [mesh])
  return <primitive object={mesh} />
}
