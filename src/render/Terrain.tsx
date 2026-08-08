import { useMemo } from 'react'
import { BufferAttribute, BufferGeometry } from 'three'
import type { World } from '../sim/world'
import { HALF_WORLD, clamp01, smoothstep } from '../sim/terrain'
import type { Rgb } from '../sim/palette'
import { FLORA, createForestMask, forestAmount, forestColour } from '../sim/flora'

/**
 * One vertex-coloured heightfield mesh built from the same Float32Array the
 * physics samples, so what you see is exactly what you can hit. No textures —
 * colour comes from altitude and slope, which is what keeps the download at zero
 * bytes of art.
 */
export function Terrain({ world }: { world: World }) {
  const geometry = useMemo(() => buildGeometry(world), [world])

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </mesh>
  )
}

function buildGeometry(world: World): BufferGeometry {
  const hf = world.heightfield
  const pal = world.palette
  const n = hf.seg + 1
  const count = n * n

  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const range = Math.max(hf.max - hf.min, 1)

  const c: Rgb = [0, 0, 0]
  const spec = FLORA[world.biome]
  const mask = createForestMask(world.seed)
  const canopy = forestColour(pal)

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix
      const x = -HALF_WORLD + ix * hf.cell
      const z = -HALF_WORLD + iz * hf.cell
      const h = hf.data[i]

      positions[i * 3] = x
      positions[i * 3 + 1] = h
      positions[i * 3 + 2] = z

      // Slope from neighbouring samples, clamped at the border.
      const hx = hf.data[iz * n + Math.min(ix + 1, n - 1)] - hf.data[iz * n + Math.max(ix - 1, 0)]
      const hz = hf.data[Math.min(iz + 1, n - 1) * n + ix] - hf.data[Math.max(iz - 1, 0) * n + ix]
      const slope = Math.sqrt(hx * hx + hz * hz) / (2 * hf.cell)

      const t = clamp01((h - hf.min) / range)

      lerp3(c, pal.low, pal.mid, smoothstep(0.14, 0.46, t))
      lerp3(c, c, pal.high, smoothstep(0.56, 0.92, t))
      lerp3(c, c, pal.rock, smoothstep(0.5, 1.35, slope))

      // Woodland, painted into the ground. See the note on forestAmount: the
      // instanced trees are near-field detail on top of this, not a substitute.
      const forest = forestAmount(mask, spec, hf, h, slope, x, z)
      if (forest > 0) lerp3(c, c, canopy, forest * 0.82)

      if (hf.hasWater) {
        // Shallows read as a beach, deeps darken toward the water colour.
        const below = (hf.waterLevel - h) / Math.max(range * 0.12, 1)
        if (below > 0) lerp3(c, c, pal.water, clamp01(below) * 0.85)
      }

      // A little deterministic grain so large flat faces are not dead colour.
      const grain = 1 + (hash2(ix, iz) - 0.5) * 0.07
      colors[i * 3] = clamp01(c[0] * grain)
      colors[i * 3 + 1] = clamp01(c[1] * grain)
      colors[i * 3 + 2] = clamp01(c[2] * grain)
    }
  }

  const indices = new Uint32Array(hf.seg * hf.seg * 6)
  let p = 0
  for (let iz = 0; iz < hf.seg; iz++) {
    for (let ix = 0; ix < hf.seg; ix++) {
      const a = iz * n + ix
      const b = a + 1
      const cIdx = a + n
      const d = cIdx + 1
      indices[p++] = a
      indices[p++] = cIdx
      indices[p++] = b
      indices[p++] = b
      indices[p++] = cIdx
      indices[p++] = d
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setAttribute('color', new BufferAttribute(colors, 3))
  geo.setIndex(new BufferAttribute(indices, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

function lerp3(out: Rgb, a: Rgb, b: Rgb, t: number) {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
}

function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
