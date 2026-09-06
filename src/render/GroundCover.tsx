import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, IcosahedronGeometry, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three'
import type { World } from '../sim/world'
import { mulberry32 } from '../sim/rng'
import { HALF_WORLD, meshHeight, sampleGradient, sampleHeight, sampleWet } from '../sim/terrain'
import { getSettings } from '../game/settings'
import { patchAirFog } from './atmosphere'

const CELL = 18
const GROUND_COUNT = 11000
const GROUND_RADIUS = 180
const UP = new Vector3(0, 1, 0)

function grassGeometry() {
  const positions: number[] = [], colors: number[] = []
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI / 3
    const x = Math.cos(a) * 0.12, z = Math.sin(a) * 0.12
    const pts = [[-x, 0, -z], [x, 0, z], [x * 0.4, 0.65, z * 0.4], [-x, 0, -z], [x * 0.4, 0.65, z * 0.4], [-x * 0.6, 0.85 + i * 0.09, z * 1.5]]
    for (const p of pts) { positions.push(...p); const c = 0.48 + p[1] * 0.5; colors.push(c, c, c) }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geo.computeVertexNormals()
  return geo
}

/** Stream stable world-space patches; fade every blade before recycling its cell. */
export function GroundCover({ world }: { world: World }) {
  const camera = useThree((s) => s.camera)
  const built = useMemo(() => {
    const uGroundTime = { value: 0 }, uGroundRadius = { value: GROUND_RADIUS }
    const make = (geo: BufferGeometry, count: number, living: boolean) => {
      const mat = new MeshLambertMaterial({ vertexColors: living, side: DoubleSide })
      patchAirFog(mat)
      const fog = mat.onBeforeCompile
      mat.onBeforeCompile = (shader, renderer) => {
        fog.call(mat, shader, renderer)
        shader.uniforms.uGroundTime = uGroundTime
        shader.uniforms.uGroundRadius = uGroundRadius
        shader.uniforms.uGroundBend = { value: living ? 1 : 0 }
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
            uniform float uGroundTime;
            uniform float uGroundRadius;
            uniform float uGroundBend;
          `)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float fade = 1.0 - smoothstep(uGroundRadius * 0.58, uGroundRadius - 25.0, distance(root.xz, cameraPosition.xz));
              float phase = dot(root.xz, vec2(0.15, 0.21));
              transformed.x += sin(uGroundTime * 1.9 + phase) * position.y * position.y * 0.18 * uGroundBend;
              transformed *= fade;
            #endif
          `)
      }
      mat.customProgramCacheKey = () => 'windfold-ground-cover-v1'
      const mesh = new InstancedMesh(geo, mat, count)
      mesh.count = 0; mesh.frustumCulled = false
      return mesh
    }
    const grass = make(grassGeometry(), GROUND_COUNT, true)
    const stones = make(new IcosahedronGeometry(0.5, 0).translate(0, 0.3, 0), Math.ceil(GROUND_COUNT / 5), false)
    const flowers = make(new IcosahedronGeometry(0.16, 0).scale(1, 0.35, 1).translate(0, 0.7, 0), Math.ceil(GROUND_COUNT / 10), false)
    return { grass, stones, flowers, uGroundTime, last: new Vector3(Infinity, 0, Infinity) }
  }, [world])
  useEffect(() => () => {
    for (const mesh of [built.grass, built.stones, built.flowers]) {
      mesh.geometry.dispose(); (mesh.material as MeshLambertMaterial).dispose(); mesh.dispose()
    }
  }, [built])
  const scratch = useMemo(() => ({ pos: new Vector3(), scale: new Vector3(), rot: new Quaternion(), matrix: new Matrix4(), color: new Color(), grad: { x: 0, z: 0 } }), [])
  useFrame((_, dt) => {
    if (!getSettings().reducedMotion) built.uGroundTime.value += Math.min(dt, 0.1)
    const p = camera.position
    const low = p.y - sampleHeight(world.heightfield, p.x, p.z) < 240
    for (const mesh of [built.grass, built.stones, built.flowers]) mesh.visible = low
    if (!low || Math.hypot(p.x - built.last.x, p.z - built.last.z) < CELL) return
    built.last.copy(p)
    const counts = [0, 0, 0]
    const meshes = [built.grass, built.stones, built.flowers]
    const cellX = Math.floor(p.x / CELL), cellZ = Math.floor(p.z / CELL)
    const reach = Math.ceil(GROUND_RADIUS / CELL)
    const perCell = 18
    const hf = world.heightfield, pal = world.palette
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const cx = cellX + dx, cz = cellZ + dz
      const rng = mulberry32(world.seed ^ Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263))
      const patch = rng()
      for (let i = 0; i < perCell; i++) {
        const x = (cx + rng()) * CELL, z = (cz + rng()) * CELL
        const kindRoll = rng(), scaleRoll = rng(), angle = rng() * Math.PI * 2, tint = rng()
        if (Math.hypot(x - p.x, z - p.z) > GROUND_RADIUS || Math.abs(x) > HALF_WORLD || Math.abs(z) > HALF_WORLD) continue
        const h = meshHeight(hf, x, z)
        if (hf.hasWater && h < hf.waterLevel + 0.4) continue
        if (sampleWet(hf, x, z) > 0.5) continue
        sampleGradient(hf, x, z, scratch.grad)
        const slope = Math.hypot(scratch.grad.x, scratch.grad.z)
        if (slope > 0.8) continue
        const shore = hf.hasWater && h < hf.waterLevel + 8
        const arid = world.biome === 'mesa' || world.biome === 'volcanic'
        const alpineTop = world.biome === 'alpine' && h > hf.min + (hf.max - hf.min) * 0.65
        const stone = shore || arid || alpineTop || slope > 0.42 || kindRoll < 0.17
        if (!stone && patch < 0.17) continue
        const kind = stone ? 1 : kindRoll > 0.92 && patch > 0.5 ? 2 : 0
        const mesh = meshes[kind]
        if (counts[kind] >= mesh.instanceMatrix.count) continue
        const size = kind === 1 ? 0.28 + scaleRoll * 1.1 : 0.6 + scaleRoll * 1.0
        scratch.pos.set(x, h - 0.04, z)
        scratch.rot.setFromAxisAngle(UP, angle)
        scratch.scale.set(size, size * (kind === 1 ? 0.5 : 1), size)
        // Some shoreline stones become long, bleached pieces of driftwood.
        if (shore && kindRoll > 0.78) scratch.scale.set(size * 2.6, size * 0.22, size * 0.3)
        scratch.matrix.compose(scratch.pos, scratch.rot, scratch.scale)
        mesh.setMatrixAt(counts[kind], scratch.matrix)
        const color = kind === 2 ? pal.bloom : kind === 1 ? (shore ? pal.sand : pal.rock) : pal.mid
        scratch.color.setRGB(color[0], color[1], color[2]).multiplyScalar(0.65 + tint * 0.4)
        mesh.setColorAt(counts[kind]++, scratch.color)
      }
    }
    meshes.forEach((mesh, i) => { mesh.count = counts[i]; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true })
  })
  return <group><primitive object={built.grass} /><primitive object={built.stones} /><primitive object={built.flowers} /></group>
}
