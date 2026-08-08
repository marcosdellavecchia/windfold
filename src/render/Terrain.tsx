import { useMemo } from 'react'
import { BufferAttribute, BufferGeometry } from 'three'
import type { World } from '../sim/world'
import { HALF_WORLD, clamp01, smoothstep } from '../sim/terrain'
import { Noise2D, fbm } from '../sim/noise'
import { mulberry32 } from '../sim/rng'
import type { BiomeId, Rgb } from '../sim/palette'
import { FLORA, createForestMask, forestAmount, forestColour } from '../sim/flora'

/**
 * Where the permanent snow starts, as a fraction of the day's height range. At or
 * above 1 the biome never gets any. Kept here rather than in `flora.ts` because it
 * is purely how the ground is painted — nothing in the sim can tell.
 */
const SNOWLINE: Record<BiomeId, number> = {
  // Above the `high` band rather than into it: on an alpine palette `high` is
  // already a pale summit colour, and starting the snow underneath it whitened the
  // entire range down to the treeline.
  alpine: 0.82,
  coastal: 0.94,
  valley: 1,
  mesa: 1,
  // Ash and pumice on the upper cones, which behaves exactly like snow and is the
  // only pale thing in an otherwise very dark palette.
  volcanic: 0.78,
  field: 1,
  archipelago: 1,
}

/** Slow colour variation across the map — meadows, heath, mineral ground. */
const PATCH = { octaves: 3, frequency: 1 / 1500, lacunarity: 2.1, gain: 0.5 }
/** Faster, for the strata that break up a rock face. */
const VEIN = { octaves: 2, frequency: 1 / 620, lacunarity: 2.3, gain: 0.5 }

/**
 * One vertex-coloured heightfield mesh built from the same Float32Array the
 * physics samples, so what you see is exactly what you can hit. No textures —
 * colour comes from altitude and slope, which is what keeps the download at zero
 * bytes of art.
 *
 * Altitude and slope alone gave a hillside one colour per height, which from a
 * kilometre up reads as a contour map. Four fields are layered on top, all free
 * because this runs once at world build: mineral strata on the steep faces,
 * meadow patches on the gentle ones, a snowline that wanders instead of drawing a
 * ring round the peak, and a colour temperature that follows which way a slope
 * faces the sun.
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
  const patchNoise = new Noise2D(mulberry32(world.seed ^ 0x9a7c))
  const veinNoise = new Noise2D(mulberry32(world.seed ^ 0x51a7))
  const snowline = SNOWLINE[world.biome]
  // Snow is never white. It takes the sky, which is what keeps a summit inside the
  // day's palette instead of punching a hole in it.
  const snowColour: Rgb = [
    1 - (1 - pal.skyHorizon[0]) * 0.22,
    1 - (1 - pal.skyHorizon[1]) * 0.22,
    1 - (1 - pal.skyHorizon[2]) * 0.22,
  ]
  const sun = world.sunDir
  const warmTint = chroma(pal.sunLight)
  const coolTint = chroma(pal.ambient)

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

      const patch = fbm(patchNoise, x, z, PATCH)

      lerp3(c, pal.low, pal.mid, smoothstep(0.14, 0.46, t))
      lerp3(c, c, pal.high, smoothstep(0.56, 0.92, t))
      lerp3(c, c, pal.rock, smoothstep(0.5, 1.35, slope))

      // Strata. Banding on absolute altitude rather than on the surface is what
      // makes a cliff read as cut through something layered instead of painted:
      // the bands stay level while the rock face does not.
      const vein = fbm(veinNoise, x, z, VEIN)
      const strata = Math.sin(h * 0.045 + vein * 2.4) * 0.5 + 0.5
      lerp3(c, c, pal.mineral, smoothstep(0.42, 1.1, slope) * strata * 0.4)

      // Woodland, painted into the ground. See the note on forestAmount: the
      // instanced trees are near-field detail on top of this, not a substitute.
      const forest = forestAmount(mask, spec, hf, h, slope, x, z)
      if (forest > 0) lerp3(c, c, canopy, forest * 0.82)

      // Meadow, only where there is neither forest nor slope to hold it — the open
      // ground between the woods, which was the largest flat colour in the frame.
      const meadow =
        smoothstep(0.16, 0.62, patch) *
        (1 - forest) *
        (1 - smoothstep(0.18, 0.55, slope)) *
        (1 - smoothstep(0.5, 0.82, t))
      if (meadow > 0) lerp3(c, c, pal.bloom, meadow * 0.3)

      if (snowline < 1) {
        // The snowline wanders with the same field as everything else, so it is a
        // shoreline rather than a contour, and it will not hold on a steep face.
        const line = snowline + patch * 0.09
        const snow = smoothstep(line, line + 0.14, t) * (1 - smoothstep(0.55, 1.2, slope))
        if (snow > 0) lerp3(c, c, snowColour, snow * 0.8)
      }

      // Colour temperature by aspect. The directional light already sets how bright
      // a slope is; this sets what colour that light is, so the two sides of a ridge
      // read as sunlit and shaded rather than as the same green at two brightnesses.
      //
      // A multiply by a mean-1 tint, not a blend toward the light's own colour:
      // `sunLight` is a light, so it is nearly white by construction, and lerping
      // 13% of it into the ground desaturated every sunlit slope in the game to
      // grey. Multiplying moves the hue and leaves the brightness where the
      // Lambert term put it.
      const inv = 1 / Math.hypot(hx, 2 * hf.cell, hz)
      const facing = (-hx * sun.x + 2 * hf.cell * sun.y + -hz * sun.z) * inv
      const warm = clamp01(facing) * 0.3
      const cool = clamp01(-facing) * 0.24
      for (let k = 0; k < 3; k++) {
        c[k] *= 1 + (warmTint[k] - 1) * warm + (coolTint[k] - 1) * cool
      }

      if (hf.hasWater) {
        // The shore band above the waterline — sand, shingle, silt or ash by
        // palette. Width wanders with the patch field so the coast is a coast
        // rather than a contour ring, and steep faces stay rock: a cliff meets
        // the sea without a beach, which is what makes the ones that have one
        // read as places you could stand.
        const beach = range * 0.028 * (0.7 + (patch * 0.5 + 0.5) * 0.9)
        const above = (h - hf.waterLevel) / Math.max(beach, 1)
        if (above > 0 && above < 1) {
          lerp3(c, c, pal.sand, (1 - smoothstep(0.55, 1, above)) * (1 - smoothstep(0.3, 0.8, slope)) * 0.8)
        }
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

/**
 * A colour's hue and saturation with its brightness divided out — the channel
 * multipliers that tint a surface without lightening or darkening it.
 */
function chroma(c: Rgb): Rgb {
  const mean = (c[0] + c[1] + c[2]) / 3
  return mean < 1e-4 ? [1, 1, 1] : [c[0] / mean, c[1] / mean, c[2] / mean]
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
