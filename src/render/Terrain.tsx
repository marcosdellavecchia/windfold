import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, MeshLambertMaterial, Vector2 } from 'three'
import type { World } from '../sim/world'
import { HALF_WORLD, clamp01, smoothstep } from '../sim/terrain'
import { Noise2D, fbm } from '../sim/noise'
import { mulberry32 } from '../sim/rng'
import type { BiomeId, Rgb } from '../sim/palette'
import { FLORA, createForestMask, createRockMask, forestAmount, forestColour, rockAmount } from '../sim/flora'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS, CLOUD_SHADOW_GLSL, cloudShadowSeed } from './atmosphere'
import { GRADED_GLSL } from './grade'

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
  archipelago: 1,
}

/** Slow colour variation across the map — meadows, heath, mineral ground. */
const PATCH = { octaves: 3, frequency: 1 / 1500, lacunarity: 2.1, gain: 0.5 }
/** Faster, for the strata that break up a rock face. */
const VEIN = { octaves: 2, frequency: 1 / 620, lacunarity: 2.3, gain: 0.5 }

/**
 * The signature paint each biome runs that the others do not.
 *
 * The shared fields — forest, rock, meadow, snow, wet — are what every landscape
 * has in common, and a biome painted with only what landscapes have in common
 * reads as generic. These dials are what a mesa has that a valley does not:
 * banded cliffs, varnish streaks, an alkali pan. All of it is build-time vertex
 * colour, so a dial nobody sets costs nothing.
 */
interface GroundPaint {
  /** Slope where the mineral strata start to bite. The default 0.42 is a cliff. */
  strataEdge: number
  strataAmount: number
  /** Desert varnish: dark streaks down the faces. 0 = none. */
  varnish: number
  /** Alkali pan on the lowest flats — mesa's basin floor. */
  playa: boolean
  /** Pale coral shelf in the shallows. 0 = none. */
  reef: number
  /** Field patchwork with hedgerow borders on flat open ground. */
  fields: boolean
}

const PAINT: Record<BiomeId, GroundPaint> = {
  alpine: { strataEdge: 0.42, strataAmount: 0.4, varnish: 0, playa: false, reef: 0, fields: false },
  // The mesa's whole character is in its rock, so the strata gate drops far
  // below cliff-slope: terrace risers at 32 m cells rarely reach 0.42, which is
  // why the one biome that is *about* banding was showing almost none of it.
  mesa: { strataEdge: 0.18, strataAmount: 0.62, varnish: 0.5, playa: true, reef: 0, fields: false },
  coastal: { strataEdge: 0.42, strataAmount: 0.4, varnish: 0, playa: false, reef: 0.45, fields: false },
  valley: { strataEdge: 0.42, strataAmount: 0.4, varnish: 0, playa: false, reef: 0, fields: true },
  volcanic: { strataEdge: 0.42, strataAmount: 0.4, varnish: 0, playa: false, reef: 0, fields: false },
  archipelago: { strataEdge: 0.42, strataAmount: 0.4, varnish: 0, playa: false, reef: 1, fields: false },
}

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
  const material = useMemo(() => makeMaterial(world), [world])

  // Increment the material's own clock rather than a persistent one: water and
  // the plane restart their shadow clocks at every world switch, and the shade
  // only lines up across the shoreline if all three agree on the time.
  useFrame((_, dt) => {
    material.userData.uCloudTime.value += Math.min(dt, 0.1)
  })

  // The terrain casts as well as receives, and not for its own ridge shadows
  // (the aspect tint already paints those): it is the light's occluder. With
  // the ground absent from the shadow map, a tree standing behind a ridge
  // threw its shadow *through the hill* onto the slope facing the player — a
  // floating shadow with no owner, reported twice before the cause was found.
  // The acne this risks at grazing sun is bought off with normal bias on the
  // light, which 32 m cells tolerate better than fine geometry would.
  return <mesh geometry={geometry} material={material} castShadow receiveShadow frustumCulled={false} />
}

/**
 * Lambert with the cloud-shadow field injected. The multiply happens before the
 * fog include on purpose: shade applied after fog would survive into the haze,
 * and the horizon would mottle where everything is supposed to converge on one
 * colour. Trees deliberately do not get the shadow — at their size the
 * mismatch is unreadable, and it saves patching a second material.
 */
function makeMaterial(world: World): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true })
  const uCloudTime = { value: 0 }
  const uCloudWind = { value: new Vector2(world.air.windX, world.air.windZ) }
  const uCloudSeed = { value: cloudShadowSeed(world.seed) }
  mat.userData.uCloudTime = uCloudTime
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudTime = uCloudTime
    shader.uniforms.uCloudWind = uCloudWind
    shader.uniforms.uCloudSeed = uCloudSeed
    Object.assign(shader.uniforms, AIR_FOG_UNIFORMS)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vCloudXZ;\nvarying float vAirY;\nvarying float vEyeDist;\nvarying vec3 vWorldNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvCloudXZ = (modelMatrix * vec4(position, 1.0)).xz;\n' +
          'vAirY = (modelMatrix * vec4(position, 1.0)).y;\n' +
          // The relief below bends the normal in world space, because the field it
          // bends by is a function of world xz. Lighting wants view space, so the
          // world normal has to travel down as its own varying — `vNormal` has
          // already been through the normal matrix by the time the fragment sees it.
          'vWorldNormal = mat3(modelMatrix) * objectNormal;',
      )
      .replace('#include <project_vertex>', '#include <project_vertex>\nvEyeDist = -mvPosition.z;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vCloudXZ;
        varying float vAirY;
        varying float vEyeDist;
        varying vec3 vWorldNormal;
        uniform float uCloudTime;
        uniform vec2 uCloudWind;
        uniform float uCloudSeed;
        ${CLOUD_SHADOW_GLSL}
        ${AIR_FOG_GLSL}
        ${GRADED_GLSL}

        /**
         * Value noise with a quintic fade, for anything that gets differentiated.
         *
         * csNoise fades cubically, which is C1: the value is continuous across a
         * lattice line but the *slope* of the fade is not. That is invisible while
         * the noise only decides how bright a pixel is, and it is glaring the
         * moment the field is differenced to bend a normal — the discontinuity
         * lands directly in the shading normal and lights up as a grid of squares
         * at the lattice spacing. Up close that read as the ground being
         * pixelated, because it was: those were the 4 m noise cells.
         *
         * The quintic is C2, so the gradient crosses a lattice line smoothly and
         * the grid disappears. It is the same fade sim/noise.ts has always used,
         * and for exactly this reason. csNoise keeps the cheaper one: cloud
         * shadows and water only ever shade with it.
         */
        float trNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
          return mix(
            mix(csHash(i), csHash(i + vec2(1.0, 0.0)), f.x),
            mix(csHash(i + vec2(0.0, 1.0)), csHash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        /**
         * Ground relief in metres. Metres rather than a unitless strength because
         * the normal is bent by amplitude over wavelength — writing every scale
         * down in the same unit is the only way they stay comparable.
         *
         * Three octaves, each on its own rotated lattice. The rotation matters as
         * much as the fade did: a value-noise lattice is axis-aligned, so stacking
         * octaves straight puts every octave's cell corners on the same world
         * lines and the squares reinforce instead of hiding each other. Turned by
         * 31 and 73 degrees they never agree, and none of them agrees with the
         * world axes either.
         *
         * Each scale carries its own distance weight, so a grain is gone long
         * before a fragment grows wider than one of its bumps. Bending the normal
         * by a feature smaller than a pixel is how a surface starts to crawl, and
         * the sea already taught that lesson twice.
         */
        float terrainRelief(vec2 xz, float w1, float w2, float w3) {
          return trNoise(xz * (1.0 / 42.0) + 7.3) * (3.0 * w1)
               + trNoise(mat2(0.857, 0.515, -0.515, 0.857) * xz * (1.0 / 4.3) + 2.1) * (0.5 * w2)
               + trNoise(mat2(0.292, 0.956, -0.956, 0.292) * xz * (1.0 / 1.5) + 11.7) * (0.11 * w3);
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // The ground is a smooth surface with a picture painted on it: vertices
          // sit 32 m apart, so every slope is lit as though it were polished, and
          // the noise below only ever changed how *bright* the paint was. Bending
          // the shading normal is what turns painted detail into detail that
          // catches the light — the same bump goes bright on the side facing the
          // sun and dark on the side away from it, and the eye reads that as
          // surface rather than as a texture. Free in geometry; the mesh is
          // untouched and the physics still samples exactly what it always did.
          float w1 = 1.0 - smoothstep(500.0, 1700.0, vEyeDist);
          float w2 = 1.0 - smoothstep(150.0, 700.0, vEyeDist);
          // The finest octave exists for the near field only — it is what stops a
          // close pass reading as a few big soft cells, which no amount of fixing
          // the lattice would have solved on its own. Gone by 260 m, long before
          // a 1.5 m bump could approach a pixel.
          float w3 = 1.0 - smoothstep(60.0, 260.0, vEyeDist);
          // Coherent across a triangle, so the branch is nearly free — and past
          // 1700 m it skips the noise entirely on ground that is mostly haze.
          if (w1 > 0.0) {
            // Short enough to resolve the finest octave: differencing over 0.9 m
            // on a 1.5 m feature would return the average of a bump and its far
            // side, which is close to nothing.
            float e = 0.35;
            float h0 = terrainRelief(vCloudXZ, w1, w2, w3);
            float hx = terrainRelief(vCloudXZ + vec2(e, 0.0), w1, w2, w3);
            float hz = terrainRelief(vCloudXZ + vec2(0.0, e), w1, w2, w3);
            // A surface rising toward +x leans its normal toward -x, hence the
            // subtraction. Valid while the face is not far from horizontal, which
            // on a heightfield it never is for long.
            vec3 wn = normalize(vWorldNormal) - vec3(hx - h0, 0.0, hz - h0) / e;
            normal = normalize((viewMatrix * vec4(normalize(wn), 0.0)).xyz);
          }
        }`,
      )
      .replace(
        '#include <fog_fragment>',
        `{
          // Ground detail: the vertex colours live 32 m apart, so up close the
          // terrain reads as airbrushed gradients. Two static noise scales — a
          // ~40 m mottle and a ~4 m grain — break that up for a few percent of
          // brightness each. Both fade out with eye distance before their
          // features go sub-pixel; the sea shook twice to teach that lesson,
          // and this field never animates at all, so what remains is texture,
          // not shimmer.
          //
          // The same two lattices the relief above bends the normal on, sampled
          // the same way. They used to be plain csNoise, which put a cubic-faded
          // axis-aligned grid of brightness on top of a quintic-faded rotated one
          // of shading — two grids disagreeing about where the cells were.
          float gd1 = trNoise(vCloudXZ * (1.0 / 42.0) + 7.3);
          float gd2 = trNoise(mat2(0.857, 0.515, -0.515, 0.857) * vCloudXZ * (1.0 / 4.3) + 2.1);
          float f1 = 1.0 - smoothstep(500.0, 1700.0, vEyeDist);
          float f2 = 1.0 - smoothstep(150.0, 700.0, vEyeDist);
          gl_FragColor.rgb *= 1.0 + (gd1 - 0.5) * 0.11 * f1 + (gd2 - 0.5) * 0.07 * f2;
        }
        gl_FragColor.rgb *= cloudShadow(vCloudXZ, uCloudWind, uCloudTime, uCloudSeed);
        {
          // Directional haze in place of the stock flat fog — see atmosphere.ts.
          // Graded on the way in: this runs after three's tone mapping step,
          // and the sky's copy of the same haze has already been through the
          // curve. Ungraded here, the horizon they share becomes a line.
          vec3 airRay = vec3(vCloudXZ.x, vAirY, vCloudXZ.y) - cameraPosition;
          float airDist = length(airRay);
          gl_FragColor.rgb = mix(
            gl_FragColor.rgb,
            graded(airFogColor(airRay / max(airDist, 1e-4))),
            airFogAmount(airDist, vAirY)
          );
        }`,
      )
  }
  return mat
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
  const rockMask = createRockMask(world.seed)
  const canopy = forestColour(pal, world.seed)
  const patchNoise = new Noise2D(mulberry32(world.seed ^ 0x9a7c))
  const veinNoise = new Noise2D(mulberry32(world.seed ^ 0x51a7))
  const snowline = SNOWLINE[world.biome]
  const paint = PAINT[world.biome]
  // The coral shelf: the water's own colour pulled well toward the sand and
  // lightened — what a reef flat is, seen through a metre of clear sea.
  const reefCol: Rgb = [
    (pal.water[0] * 0.45 + pal.sand[0] * 0.55) * 1.18,
    (pal.water[1] * 0.45 + pal.sand[1] * 0.55) * 1.18,
    (pal.water[2] * 0.45 + pal.sand[2] * 0.55) * 1.18,
  ]
  /** Field parcel size, metres. Big enough that a parcel holds many vertices. */
  const FIELD = 260
  const FIELD_HALF = FIELD / 2
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

  // The sea biomes earn real beaches; lakes keep their thin margins.
  const beachScale =
    world.biome === 'coastal' || world.biome === 'archipelago' ? 1.7 : world.biome === 'mesa' ? 1.2 : 0.8
  // Wet sand: darker than the dry apron and leaning toward the water — the
  // strip the surf keeps damp, sitting exactly under the foam band.
  const wetSand: Rgb = [
    pal.sand[0] * 0.62 + pal.water[0] * 0.16,
    pal.sand[1] * 0.62 + pal.water[1] * 0.16,
    pal.sand[2] * 0.62 + pal.water[2] * 0.16,
  ]

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
      lerp3(c, c, pal.mineral, smoothstep(paint.strataEdge, 1.1, slope) * strata * paint.strataAmount)

      // Rock first, because the forest reads it: bare stone holds no wood, and
      // this pass is the one place that would otherwise evaluate the field twice
      // for every vertex.
      const rocky = rockAmount(rockMask, spec, hf, h, x, z)

      // Woodland, painted into the ground. See the note on forestAmount: the
      // instanced trees are near-field detail on top of this, not a substitute.
      const forest = forestAmount(mask, rockMask, spec, hf, h, slope, x, z, rocky)
      if (forest > 0) lerp3(c, c, canopy, forest * 0.82)

      // Meadow, only where there is neither forest nor slope to hold it — the open
      // ground between the woods, which was the largest flat colour in the frame.
      const meadow =
        smoothstep(0.16, 0.62, patch) *
        (1 - forest) *
        (1 - smoothstep(0.18, 0.55, slope)) *
        (1 - smoothstep(0.5, 0.82, t))
      if (meadow > 0) lerp3(c, c, pal.bloom, meadow * 0.3)

      // Field patchwork: flat open lowland divided into parcels, each leaning
      // its own way — toward hay-gold or a deeper green — with a darker seam
      // along the parcel borders. The one biome that is *tended* country rather
      // than wilderness gets to look tended from the air, which is most of what
      // "cozy" means at altitude. The grid is warped by the same patch and vein
      // fields everything else uses, so the parcels are crooked the way old
      // enclosure is, not a checkerboard.
      if (paint.fields) {
        // Enclosure climbs the lower hillsides — a slope gate tuned for true
        // flats never fired on billow terrain, whose valley floors still roll.
        const strength =
          (1 - smoothstep(0.14, 0.32, slope)) * (1 - smoothstep(0.38, 0.58, t)) * (1 - smoothstep(0.1, 0.3, forest))
        if (strength > 0.02) {
          const wx = x + patch * 110
          const wz = z + vein * 110
          const gx = Math.floor(wx / FIELD)
          const gz = Math.floor(wz / FIELD)
          const tone = hash2(gx, gz)
          if (tone > 0.55) lerp3(c, c, pal.bloom, strength * (tone - 0.55) * 0.8)
          else lerp3(c, c, canopy, strength * (0.55 - tone) * 0.5)
          // The hedgerow seam. At 32 m vertices this is one to two vertices
          // wide, which drawn in canopy-dark reads as exactly what it is: a
          // line of trees between two fields.
          const ex = FIELD_HALF - Math.abs(wx - gx * FIELD - FIELD_HALF)
          const ez = FIELD_HALF - Math.abs(wz - gz * FIELD - FIELD_HALF)
          const border = 1 - smoothstep(16, 44, Math.min(ex, ez))
          if (border > 0) lerp3(c, c, canopy, border * strength * 0.65)
        }
      }

      // Rocky ground, and the only route to stone that does not go through slope.
      // Painted after the forest and the meadow so it wins over both: this is
      // ground with nothing on it, which is the entire point of it. The strata
      // field comes along so a scree sector is not one flat grey — the same bands
      // that cut the cliffs run through the flat stone, level, as they should.
      if (rocky > 0) {
        lerp3(c, c, pal.rock, rocky * 0.72)
        lerp3(c, c, pal.mineral, rocky * strata * 0.26)
      }

      // Desert varnish: the dark streaks weather leaves running down exposed
      // faces. Painted after the rock so it darkens whatever stone is there,
      // and slightly blue-shifted — varnish is manganese, not shadow, and
      // darkening all three channels equally just reads as dirt on the render.
      if (paint.varnish > 0) {
        const streak = fbm(veinNoise, x * 2.3, z * 2.3, VEIN)
        const v = smoothstep(0.28, 0.75, slope) * smoothstep(0.2, 0.7, streak) * paint.varnish
        if (v > 0) {
          c[0] *= 1 - v * 0.34
          c[1] *= 1 - v * 0.3
          c[2] *= 1 - v * 0.22
        }
      }

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

      // Watercourses — as damp ground, not as water.
      //
      // Painting the drainage in water colour was the obvious thing and it was
      // wrong twice over. A vertex here is 32 m apart, so the narrowest mark this
      // field can make is already wider than most rivers, and a 32 m ribbon of
      // flat blue laid over a hillside reads as a road rather than a stream. And
      // the colour had nothing to keep it honest: the water *surface* arrives at
      // its colour through Fresnel, a sky reflection and its own deep and shallow
      // tones, so a lake and a painted stream on the same map disagreed about
      // what water looks like.
      //
      // What a watercourse this size actually looks like from a glider is a
      // darker, greener seam. The ground along it stays damp and the vegetation
      // follows it, and that reads as a river valley at every altitude without
      // ever claiming to be a water surface. Anything genuinely wide enough to
      // show water is below the waterline already, where the water plane draws it.
      // Only the core of a thread, not its whole falloff. Vertex colours are 32 m
      // apart and interpolate across the triangles between, so the narrowest
      // possible mark is already ~64 m wide before any of this is applied — take
      // the drainage field at face value and a channel spreads to a couple of
      // hundred metres of soft wash, which is a smear across a hillside rather
      // than a line down it.
      const wet = smoothstep(0.3, 0.85, hf.wet[i])
      if (wet > 0) {
        // Steepness thins it: a torrent down a mountainside is a metre wide and
        // mostly white, so the seam belongs on the ground that can hold a valley.
        const damp = wet * (1 - smoothstep(0.5, 1.1, slope) * 0.6)
        lerp3(c, c, canopy, damp * 0.5)
        const shade = 1 - damp * 0.16
        c[0] *= shade
        c[1] *= shade
        c[2] *= shade
      }

      // The alkali pan: the lowest flats crusted pale, whether or not the day's
      // water roll left anything standing in them. The existing shore band only
      // ever ringed the waterline, so on a dry-basin day the playa — the flattest,
      // most distinctive ground on the map — was painted like any hillside.
      if (paint.playa) {
        const pan =
          (1 - smoothstep(0.03, 0.1, t)) * (1 - smoothstep(0.08, 0.2, slope)) * smoothstep(-0.4, 0.3, patch)
        if (pan > 0) lerp3(c, c, pal.sand, pan * 0.55)
      }

      if (hf.hasWater) {
        // The shore band above the waterline — sand, shingle, silt or ash by
        // palette. Width wanders with the patch field so the coast is a coast
        // rather than a contour ring, widens where the ground shelves gently —
        // a flat shore becomes a strand, a cliff still meets the sea bare —
        // and splits into two tones: pale dry sand above, and the darker wet
        // strip the surf keeps damp right at the waterline.
        const shelf = 0.6 + 1.8 * (1 - smoothstep(0.08, 0.35, slope))
        const beach = range * 0.028 * (0.7 + (patch * 0.5 + 0.5) * 0.9) * beachScale * shelf
        const above = (h - hf.waterLevel) / Math.max(beach, 1)
        if (above > 0 && above < 1) {
          const sandMask = (1 - smoothstep(0.55, 1, above)) * (1 - smoothstep(0.3, 0.8, slope))
          lerp3(c, c, pal.sand, sandMask * 0.8)
          // Braided damp channels through the wide flats. On a coastal map the
          // shore band can run tens of metres of elevation over near-level
          // ground, and painted as one unbroken pale sheet it read as *water* —
          // a dead, textureless sea filling half the frame, which no amount of
          // work on the actual water could fix, because it was sand. Tidal
          // flats are braided, and the braid is what says "wet land" instead.
          const braid = smoothstep(0.12, 0.55, fbm(veinNoise, x * 1.7, z * 1.7, VEIN))
          const flatness = 1 - smoothstep(0.08, 0.22, slope)
          lerp3(c, c, wetSand, sandMask * braid * flatness * (1 - above * 0.55) * 0.55)
          lerp3(c, c, wetSand, sandMask * (1 - smoothstep(0.08, 0.24, above)) * 0.7)
        }
        // Shallows read as a beach, deeps darken toward the water colour.
        const below = (hf.waterLevel - h) / Math.max(range * 0.12, 1)
        if (below > 0) {
          lerp3(c, c, pal.water, clamp01(below) * 0.85)
          // The reef: a pale shelf at snorkelling depth, standing out of the
          // darker blue on the seaward side. Painted on the seabed rather than
          // the surface, which is how a real reef arrives in an aerial view —
          // through the water, not on it. Broken up by the patch field so it is
          // a scatter of flats and passes rather than a contour ring around
          // every island, which is the trap every depth-keyed band walks into.
          if (paint.reef > 0) {
            const ring = smoothstep(0.1, 0.28, below) * (1 - smoothstep(0.42, 0.72, below))
            const broken = smoothstep(-0.25, 0.45, patch)
            if (ring > 0) lerp3(c, c, reefCol, ring * broken * 0.55 * paint.reef)
          }
        }
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
