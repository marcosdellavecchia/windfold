import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  PlaneGeometry,
  RGFormat,
  ShaderMaterial,
  Mesh,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { HALF_WORLD } from '../sim/terrain'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS, CLOUD_SHADOW_GLSL, cloudShadowSeed } from './atmosphere'

/**
 * Lakes and sea. One plane at the day's water level; wherever the terrain is below
 * it, there is water.
 *
 * A flat Lambert plane read as coloured cardboard, which is a waste of the biggest
 * single surface in the scene. This adds the three things that actually make water
 * look like water from the air: it goes from transparent-ish overhead to sky-coloured
 * at grazing angles, it carries a moving sun glitter, and the shallows lighten toward
 * the shore. All from the day's palette, no reflection pass, no render target.
 */
export function Water({ world }: { world: World }) {
  const hf = world.heightfield
  const ref = useRef<Mesh>(null)

  const { geometry, material } = useMemo(() => {
    const pal = world.palette
    // Far wider than the map. A flat plane ends at its own edge rather than at the
    // true horizon, and if that edge lands inside the fog's reach it shows up as a
    // faint straight line under the sky. Two triangles cost nothing, so overshoot.
    const geo = new PlaneGeometry(HALF_WORLD * 12, HALF_WORLD * 12)
    geo.rotateX(-Math.PI / 2)

    // The heightfield, packed into a small texture so the fragment shader knows
    // how deep the water is at every pixel. This exists to fix the shaking
    // coastline: the waterline used to be the raw depth intersection of two
    // surfaces, which MSAA cannot antialias, so it drew as a hard stair-stepped
    // edge that flickered pixel by pixel as the camera moved. With depth in
    // hand, the water fades itself out over the last couple of metres instead —
    // a soft shore has no intersection line left to alias or z-fight.
    //
    // 16 bits, packed into RG8 rather than a float texture: filtering float
    // textures needs an extension that mobile does not reliably have, and the
    // decode is linear, so bilinear filtering of the two packed bytes still
    // reconstructs the exact filtered height.
    const n = hf.seg + 1
    const range = Math.max(hf.max - hf.min, 1)
    const packed = new Uint8Array(n * n * 2)
    for (let i = 0; i < n * n; i++) {
      const v = Math.round(((hf.data[i] - hf.min) / range) * 65535)
      packed[i * 2] = v >> 8
      packed[i * 2 + 1] = v & 255
    }
    const heightTex = new DataTexture(packed, n, n, RGFormat, UnsignedByteType)
    heightTex.magFilter = LinearFilter
    heightTex.minFilter = LinearFilter
    heightTex.needsUpdate = true

    // World xz -> texel-centre UV. Grid point ix sits at x = -HALF + ix*cell and
    // must sample texel centre (ix + 0.5)/n, so u = (x/cell + HALF/cell + 0.5)/n.
    const uvScale = 1 / (hf.cell * n)
    const uvOffset = (HALF_WORLD / hf.cell + 0.5) / n

    const mat = new ShaderMaterial({
      transparent: true,
      side: DoubleSide,
      uniforms: {
        uDeep: { value: new Color(rgbToHex(pal.water)).multiplyScalar(0.5) },
        uShallow: { value: new Color(rgbToHex(pal.water)).multiplyScalar(1.45) },
        // The sky's own two colours rather than one blend of them, so the surface
        // can reflect the gradient instead of a single flat tone. What made the
        // water read as cardboard was not the absence of ripples — those were
        // already here — but that every pixel of it reflected the same colour,
        // and a mirror whose image never changes is not read as a mirror.
        uSkyTop: { value: new Color(rgbToHex(pal.skyTop)) },
        uSkyHorizon: { value: new Color(rgbToHex(pal.skyHorizon)) },
        uSun: { value: new Color(rgbToHex(pal.sun)) },
        uFog: { value: new Color(rgbToHex(pal.fog)) },
        uSunDir: { value: world.sunDir.clone() as Vector3 },
        uTime: { value: 0 },
        uHeight: { value: heightTex },
        uHeightMin: { value: hf.min },
        uHeightRange: { value: range },
        uWaterLevel: { value: hf.waterLevel },
        uHeightUv: { value: new Vector2(uvScale, uvOffset) },
        // Cloud shadows share the terrain's exact field — same seed, same wind,
        // same clock — so a patch of shade crosses the shoreline in one piece.
        uCloudWind: { value: new Vector2(world.air.windX, world.air.windZ) },
        uCloudSeed: { value: cloudShadowSeed(world.seed) },
        // Swell runs along the day's wind; how much sea-state the day earns.
        uSwell: {
          value: new Vector2(world.air.windX, world.air.windZ).normalize(),
        },
        uWindAmt: { value: Math.min(world.air.windSpeed / 5.5, 1) },
        // Surf belongs to the sea. Lakes get a gentle lap of the same code.
        uFoam: { value: world.biome === 'coastal' || world.biome === 'archipelago' ? 1.0 : 0.35 },
        ...AIR_FOG_UNIFORMS,
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying float vDist;
        void main() {
          vec4 world4 = modelMatrix * vec4(position, 1.0);
          vWorld = world4.xyz;
          vec4 mv = viewMatrix * world4;
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSun;
        uniform vec3 uFog;
        uniform vec3 uSunDir;
        uniform float uTime;
        uniform sampler2D uHeight;
        uniform float uHeightMin;
        uniform float uHeightRange;
        uniform float uWaterLevel;
        uniform vec2 uHeightUv;
        uniform vec2 uCloudWind;
        uniform float uCloudSeed;
        uniform vec2 uSwell;
        uniform float uWindAmt;
        uniform float uFoam;
        varying vec3 vWorld;
        varying float vDist;

        ${CLOUD_SHADOW_GLSL}
        ${AIR_FOG_GLSL}

        /** One texel, decoded. The 16 bits arrive split across two bytes. */
        float texelH(vec2 texel) {
          vec2 hg = texture2D(uHeight, texel * ${(1 / n).toFixed(8)}).rg;
          return (hg.r * 65280.0 + hg.g * 255.0) / 65535.0 * uHeightRange + uHeightMin;
        }

        /**
         * The terrain height under a world position, reconstructed the way the
         * terrain mesh actually interpolates it.
         *
         * Reading this texture with hardware filtering gives the bilinear surface,
         * and the mesh is not bilinear — it is two triangles per quad, split on the
         * diagonal from (ix, iz+1) to (ix+1, iz). Those two surfaces meet at the
         * corners and disagree everywhere between, by the quad's twist,
         * |h00 + h11 - h10 - h01| / 4. Measured along the waterline that is a
         * couple of metres on most maps and up to twelve on an archipelago, where
         * 42% of shoreline quads disagreed by more than the entire shore fade.
         *
         * That is the shaking coast. Wherever the disagreement outruns the fade,
         * the shader believes there is water over ground the mesh has placed above
         * the waterline, draws it at full opacity, and the depth test then decides
         * per pixel and per frame which of the two is in front. The height texture
         * was added to stop the waterline being a raw intersection of two surfaces;
         * it did, but it left the shader reading a third surface that was neither.
         *
         * So: fetch the four corners at their texel centres and run the same
         * split-triangle interpolation the mesh does. Four fetches rather than one,
         * all inside a cache line, and the two surfaces are now the same surface.
         */
        float terrainAt(vec2 xz) {
          vec2 g = (xz * uHeightUv.x + uHeightUv.y) * ${n}.0 - 0.5;
          vec2 gi = floor(g);
          vec2 t = g - gi;
          float h00 = texelH(gi + vec2(0.5, 0.5));
          float h10 = texelH(gi + vec2(1.5, 0.5));
          float h01 = texelH(gi + vec2(0.5, 1.5));
          float h11 = texelH(gi + vec2(1.5, 1.5));
          // Lower-left triangle holds t.x + t.y < 1; the upper-right holds the rest.
          return t.x + t.y < 1.0
            ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y
            : h11 + (h10 - h11) * (1.0 - t.y) + (h01 - h11) * (1.0 - t.x);
        }

        /**
         * The sky's colour at a given height up the dome — the same two steps
         * Sky.tsx paints with, so the reflection and the thing being reflected
         * cannot drift apart. Only the vertical component is needed: the sun is
         * handled by the speculars below, and everything else up there is a
         * gradient in one axis.
         */
        vec3 skyTone(float up) {
          vec3 s = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.55, up));
          return mix(uFog, s, smoothstep(-0.03, 0.28, up));
        }

        // The sea's long waves: one swell train along the wind plus a weaker
        // harmonic, ~310 m crest to crest, marching at swell speed. Long enough
        // to stay legible far beyond where the chop has to fade out.
        float swellAt(vec2 p, float t) {
          float u = dot(p, uSwell);
          return sin(u * 0.0203 - t * 0.185) + 0.35 * sin(u * 0.041 - t * 0.31 + 1.7);
        }

        // Cheap crossed-wave surface. Three scales of ripple is enough to read as
        // texture from 200 m up, and it costs no texture fetch.
        //
        // The wavelengths matter more than they look. The first version used 300 m
        // features sliding at 43 m/s, because the phase rate was picked to feel
        // right without checking it against the spatial frequency it divides into.
        // On a lake 300 m across that is the entire surface pulsing at once, which
        // reads as a rendering fault rather than as water. These are 20-80 m waves
        // moving at 3-7 m/s, which is roughly what wind waves actually do, and at
        // that scale the motion is texture instead of the lake itself moving.
        float waves(vec2 p, float t) {
          float w = sin(p.x * 0.08 + t * 0.55) * sin(p.y * 0.071 - t * 0.42);
          w += 0.55 * sin(p.x * 0.17 - t * 0.7) * sin(p.y * 0.19 + t * 0.6);
          w += 0.3 * sin((p.x + p.y) * 0.33 + t * 0.9);
          return w / 1.85;
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);

          // How much water is under this pixel. Beyond the map the texture
          // clamps to the border heights, which the border mask keeps low, so
          // the open sea stays deep all the way to the fog.
          float depth = uWaterLevel - terrainAt(vWorld.xz);

          // Beyond the map the height texture clamps to its border row, which
          // extrudes the last coastline outward as streaks of phantom shallows
          // and shore fade running to the horizon. Past the border is open
          // ocean; call it deep and be done.
          float inMap = (1.0 - smoothstep(${(HALF_WORLD * 0.93).toFixed(1)}, ${(HALF_WORLD * 0.985).toFixed(1)}, abs(vWorld.x)))
                      * (1.0 - smoothstep(${(HALF_WORLD * 0.93).toFixed(1)}, ${(HALF_WORLD * 0.985).toFixed(1)}, abs(vWorld.z)));
          depth = mix(1000.0, depth, inMap);

          // Perturb the surface normal by the wave slope.
          float e = 6.0;
          float w0 = waves(vWorld.xz, uTime);
          float wx = waves(vWorld.xz + vec2(e, 0.0), uTime) - w0;
          float wz = waves(vWorld.xz + vec2(0.0, e), uTime) - w0;
          // Flatten the ripple with distance. Per-pixel waves seen almost edge-on
          // alias into corduroy stripes across the whole sea; fading the slope out
          // past a few hundred metres removes them and costs nothing visually,
          // because that detail was never legible at range anyway. Shorter waves
          // alias sooner, so this fades sooner than it used to.
          float ripple = 4.0 * (1.0 - smoothstep(260.0, 1400.0, vDist));

          // The swell tilts the same normal the chop perturbs, but being ~15x
          // longer it stays legible far past where the chop must fade — long
          // parallel bands marching downwind is most of what makes open water
          // read as sea instead of resin.
          float s0 = swellAt(vWorld.xz, uTime);
          float sx = swellAt(vWorld.xz + vec2(e, 0.0), uTime) - s0;
          float sz = swellAt(vWorld.xz + vec2(0.0, e), uTime) - s0;
          float swellAmp = 3.6 * (1.0 - smoothstep(500.0, 3000.0, vDist)) * (0.3 + 0.7 * uFoam);
          vec3 n = normalize(vec3(-wx * ripple - sx * swellAmp, 1.0, -wz * ripple - sz * swellAmp));

          // Looking straight down you see into the water; at a grazing angle the
          // surface turns into a mirror of the sky. That flip is most of what sells
          // water seen from an aircraft.
          float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 4.0);

          // Body colour varies with *position only*, never with the wave phase.
          // Modulating it by w0 put a 300 m brightness field on the surface that
          // slid across it at speed, and that — not the ripple, not the glitter —
          // was the thing that made a lake look like it was moving under the map.
          // Water this size does not change colour as a wave passes; it changes
          // colour where it is deeper or shallower, and that does not move at all.
          float mottle = sin(vWorld.x * 0.0009) * sin(vWorld.z * 0.0011);
          vec3 body = mix(uDeep, uShallow, 0.36 + mottle * 0.16);
          // Swell you can actually see: the long bands brighten and darken the
          // surface a few percent as they pass. The lake-pulse lesson still
          // holds — that bug was a basin breathing in place; these are bands
          // travelling at swell speed, scaled to the sea and nearly absent on
          // lakes, and they die well before the horizon's corduroy zone.
          body *= 1.0 + s0 * 0.05 * uFoam * (1.0 - smoothstep(1800.0, 4200.0, vDist));
          // True shallows off the height texture, layered over the mottle: the
          // last dozen metres of depth lighten toward the shore, which is what
          // makes a coast read as shelving instead of cut with a knife.
          body = mix(uShallow, body, smoothstep(0.0, 12.0, depth));
          // What the surface actually reflects, per pixel: the sky in the
          // direction the wave sends the eye. Every crest and trough now returns
          // a different part of the dome, which is the whole reason a real water
          // surface reads as reflective — the image moves when the surface does.
          //
          // Biased upward rather than taken straight. A true grazing reflection
          // returns the horizon, and near a low sun the horizon is cream, which
          // turned the sea into a desert — the reason this used to be one flat
          // zenith-weighted colour. Keeping some of the zenith in the sample
          // preserves the variation without bringing the desert back.
          vec3 refl = reflect(-viewDir, n);
          vec3 skyCol = skyTone(mix(max(refl.y, 0.0), 0.8, 0.45));

          // Capped well below 1: a physically full mirror at grazing angles turns every
          // lake and sea into the same colour as the sky, and the landscape goes
          // monochrome. Water keeps some of its own body colour at every angle.
          vec3 col = mix(body, skyCol, clamp(fres, 0.0, 0.42));

          // Sun glitter: a tight specular on the wave slopes.
          vec3 h = normalize(normalize(uSunDir) + viewDir);
          float spec = pow(max(dot(n, h), 0.0), 220.0);
          col += uSun * spec * 1.6;
          // And the road it lies on. The tight lobe above is one sparkle; this is
          // the broad ragged path from the sun to the eye that all the sparkles
          // sit in, and it is probably the single most recognisable thing about a
          // sunlit stretch of water. It needs no extra waves — the same normal,
          // read with a much softer exponent, is what spreads it out.
          float road = pow(max(dot(n, h), 0.0), 16.0);
          col += uSun * road * 0.26;

          // Whitecaps where chop and swell crest together — kept close, where
          // individual caps are readable, and only as much wind as the day has.
          float crest = smoothstep(0.62, 1.15, w0 + s0 * 0.45) * (1.0 - smoothstep(200.0, 800.0, vDist));
          col += mix(skyCol, vec3(1.0), 0.4) * crest * uWindAmt * 0.12;

          // Surf. Two regimes, split by distance, because the failure modes
          // differ. Near: a breathing band over the last metres of depth, its
          // pulse riding the swell phase so the edge crawls along the beach.
          // Far: the band widens with distance so it never thins below a few
          // pixels, and the animation freezes entirely — a distant surf line
          // reads as a pale static rim from a glider, and an animated
          // sub-pixel band is exactly the shaking-coast bug reborn.
          float bandW = 4.5 + vDist * 0.012;
          float foamBand = pow(1.0 - smoothstep(0.3, bandW, depth), 1.5);
          float breathe = mix(
            0.55 + 0.45 * sin(uTime * 1.1 + s0 * 2.2 + depth * 1.6),
            0.6,
            smoothstep(350.0, 1000.0, vDist)
          );
          float foam = foamBand * breathe * uFoam * (1.0 - smoothstep(1600.0, 3400.0, vDist));
          col = mix(col, mix(uShallow, vec3(1.0), 0.55), foam * 0.45);

          col *= cloudShadow(vWorld.xz, uCloudWind, uTime, uCloudSeed);

          // Haze over water is not the haze over land. It carries some of the
          // water's own colour and it is darker, because there is no lit ground
          // beneath it throwing light back up into it.
          //
          // This is the difference between having a horizon and not having one.
          // Fogging the sea to exactly the colour the sky fogs to is what the
          // shared fog source was for, and at the shoreline it is right — that
          // is the seam the single source exists to hide. But carried all the
          // way out it means the far sea and the low sky arrive at identical
          // values and the line between them stops existing, so open water reads
          // as more sky. A few percent is enough: the eye needs a step, not a
          // stripe. Directional now, like everything else's: the sea hazes warm
          // toward the sun, and the step below the sky survives on both sides.
          //
          // Water takes almost none of the mist — see airFogAmountW. The mist
          // floor is the waterline, so at full weight every lake sat at maximum
          // mist density and washed out to a pale patch. And it takes the
          // directional colour at less than half strength, pulled further into
          // the deep tone: measured on an alpine day, hazing the lakes toward
          // the full sun-warm colour cost them a third of their blue-to-red
          // separation and they stopped reading as water at all. The air over
          // land belongs to the sun; the air's colour over water is half the
          // water's own, which is also simply what the sea looks like.
          vec3 seaHaze = mix(mix(uFogBase, airFogColor(-viewDir), 0.25), uDeep, 0.3) * 0.93;
          col = mix(col, seaHaze, airFogAmountW(vDist, vWorld.y, 0.12));
          // A third of an LSB of noise: the haze ramp over open water is the
          // widest, shallowest gradient in the frame after the sky, and the sky
          // already carries its own dither for exactly this reason.
          col += (csHash(gl_FragCoord.xy) - 0.5) * 0.0026;
          // The soft shore itself: water thins to nothing over its last two
          // metres of depth, so the waterline is a gradient the width of a
          // beach's wet edge rather than an aliased intersection line.
          float shore = smoothstep(0.0, 2.2, depth);
          gl_FragColor = vec4(col, mix(0.86, 0.97, fres) * shore);
        }
      `,
    })
    return { geometry: geo, material: mat }
  }, [world])

  useFrame((_, dt) => {
    material.uniforms.uTime.value += Math.min(dt, 0.1)
  })

  if (!hf.hasWater) return null

  return (
    <mesh
      ref={ref}
      geometry={geometry}
      material={material}
      position={[0, hf.waterLevel, 0]}
      renderOrder={1}
    />
  )
}
