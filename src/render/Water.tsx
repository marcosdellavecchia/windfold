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
import { WATER_OPTICS_GLSL } from './waterOptics'
import { TONEMAP_GLSL } from './grade'

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

    const isSea = world.biome === 'coastal' || world.biome === 'archipelago'
    const mat = new ShaderMaterial({
      transparent: true,
      side: DoubleSide,
      uniforms: {
        // The sea biomes take a deeper deep. Every band, shelf and foam line
        // is a contrast *against* this colour, and at 0.5 the whole system
        // measured as invisible — the ocean was too pale for anything painted
        // on it to register. Lakes keep the lighter body they always had.
        uDeep: { value: new Color(rgbToHex(pal.water)).multiplyScalar(isSea ? 0.38 : 0.5) },
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
        // What a bank reflection is made of: the day's low ground and rock,
        // darkened the way a reflection of unlit shore actually is.
        uBank: {
          value: new Color(rgbToHex(pal.low)).lerp(new Color(rgbToHex(pal.rock)), 0.45).multiplyScalar(0.5),
        },
        ...AIR_FOG_UNIFORMS,
      },
      // Only the world position travels from the vertex shader. The distance to
      // the camera is a fragment-shader job here, and getting that wrong was the
      // longest-standing bug in this file — see `vDist` in main().
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world4 = modelMatrix * vec4(position, 1.0);
          vWorld = world4.xyz;
          gl_Position = projectionMatrix * viewMatrix * world4;
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
        uniform vec3 uBank;
        varying vec3 vWorld;

        ${CLOUD_SHADOW_GLSL}
        ${AIR_FOG_GLSL}
        ${WATER_OPTICS_GLSL}

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
        /**
         * One hardware-filtered fetch — the bilinear surface, for questions
         * like "is there a hill along this ray", where the exact mesh split
         * that terrainAt reconstructs is four fetches of irrelevance.
         */
        float terrainFast(vec2 xz) {
          vec2 hg = texture2D(uHeight, xz * uHeightUv.x + uHeightUv.y).rg;
          return (hg.r * 65280.0 + hg.g * 255.0) / 65535.0 * uHeightRange + uHeightMin;
        }

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

        // The sea's long waves: one swell train along the wind plus a weaker
        // harmonic, ~310 m crest to crest, marching at swell speed. Long enough
        // to stay legible far beyond where the chop has to fade out.
        float swellAt(vec2 p, float t) {
          float u = dot(p, uSwell);
          return sin(u * 0.0203 - t * 0.185) + 0.35 * sin(u * 0.041 - t * 0.31 + 1.7);
        }

        /**
         * Quintic-fade value noise, for the wave field that gets differentiated
         * into a normal. The cubic-fade csNoise is C1: differencing it puts the
         * lattice straight into the shading as a grid of squares — the same
         * lesson the terrain relief learned, for the same reason.
         */
        float wNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
          return mix(
            mix(csHash(i), csHash(i + vec2(1.0, 0.0)), f.x),
            mix(csHash(i + vec2(0.0, 1.0)), csHash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        // The chop. This used to be three multiplied sines, and multiplied
        // sines are a plaid: the same diamond repeating to the horizon, which
        // from altitude is exactly what the sea looked like. Two octaves of
        // noise on rotated lattices have no repeat to find. Wavelengths of
        // ~28 m and ~11 m sliding downwind at a few m/s — wind-wave numbers;
        // the swell handles everything longer.
        float waves(vec2 p, float t) {
          vec2 q = p - uSwell * (t * 2.6);
          float w = wNoise(q * (1.0 / 28.0)) * 0.65
                  + wNoise(mat2(0.857, 0.515, -0.515, 0.857) * q * (1.0 / 11.0) + 4.7) * 0.35;
          return w * 2.0 - 1.0;
        }

        void main() {
          // Per fragment, and it has to be.
          //
          // This was a varying, interpolated across a plane with four vertices
          // 73 km apart, so every pixel of water reported a distance of
          // kilometres — a lake two hundred metres away measured at six. It had
          // been that way since the first commit, and it quietly switched off
          // every distance-faded term below: the wave normals (260-1600 m), the
          // caustics (under 900 m), the surf animation (350-1100 m) and the
          // whitecaps had never once been drawn. What was left was body colour
          // under a fixed sheet of haze, which is why the sea used to read as
          // pale cardboard at every range, and why a river ribbon — which gets
          // its distance right, over a mesh with vertices every eleven metres —
          // could never be made to match the lake it ran into.
          //
          // Exact, not merely better: vWorld interpolates perspective-
          // correctly, so this is the true distance to the fragment.
          vec3 toEye = cameraPosition - vWorld;
          float vDist = length(toEye);
          vec3 viewDir = toEye / max(vDist, 1e-4);

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
          // alias sooner, so this fades sooner than it used to. And a windless
          // day flattens it too — a calm lake is closer to a mirror than to a
          // texture, and the mirror is the better look.
          float ripple = 0.5 * mix(0.65, 1.0, uWindAmt) * (1.0 - smoothstep(260.0, 1600.0, vDist));

          // The swell tilts the same normal the chop perturbs, but being ~15x
          // longer it stays legible far past where the chop must fade — long
          // parallel bands marching downwind is most of what makes open water
          // read as sea instead of resin.
          float s0 = swellAt(vWorld.xz, uTime);
          float sx = swellAt(vWorld.xz + vec2(e, 0.0), uTime) - s0;
          float sz = swellAt(vWorld.xz + vec2(0.0, e), uTime) - s0;
          float swellAmp = 0.6 * (1.0 - smoothstep(500.0, 3000.0, vDist)) * (0.3 + 0.7 * uFoam);
          vec3 n = normalize(vec3(-wx * ripple - sx * swellAmp, 1.0, -wz * ripple - sz * swellAmp));

          float fres = waterFresnel(n, viewDir);

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
          body *= 1.0 + s0 * 0.07 * uFoam * (1.0 - smoothstep(1800.0, 4200.0, vDist));
          // The chop, visible from above. Seen from overhead the fresnel term
          // is tiny and the speculars need the sun in front of you, so the
          // wave field the normals carry contributed *nothing* to a top-down
          // view — which is most of why the sea read as a flat sheet from
          // exactly the altitude the game is played at. The height field
          // itself, as light and shade, drifting downwind. Zero-mean, so the
          // fades never shift the sea's overall value.
          // Brightness, not normals — so unlike the ripple above it, this is
          // safe at range and *has* to reach it: the water this game actually
          // looks at is one to six kilometres away, and a texture that fades
          // by two was, measurably, invisible from anywhere a player ever is.
          body *= 1.0 + w0 * 0.13 * mix(0.6, 1.0, uWindAmt)
                * (1.0 - smoothstep(600.0, 3800.0, vDist));
          // True shallows off the height texture, in three stops now: glassy
          // sand-tinted water over the first couple of metres, a turquoise
          // shelf, then the deep body arriving by ~20 m. The old single 12 m
          // ramp is most of why every island wore a halo — pale sand under
          // pale water under a pale surf band, three tones of the same cream.
          // Pulling real colour in by the third stop is what gives the coast
          // its line back.
          vec3 shelf = mix(uShallow, uDeep, 0.4);
          body = mix(shelf, body, smoothstep(7.0, 22.0, depth));
          body = mix(uShallow, body, smoothstep(0.5, 7.0, depth));
          // What the surface actually reflects, per pixel.
          vec3 refl = reflect(-viewDir, n);
          vec3 skyCol = waterReflection(n, viewDir);

          // What the mirror shows when it is not showing sky: the bank. The
          // heightfield already lives in this shader as a texture, so the
          // reflected ray can simply ask it — three cheap filtered samples
          // marching out from the surface, darkening the reflection wherever
          // rising ground stands in the way. It is a rough mirror, but from a
          // glider a rough mirror of the right hillside in the right place is
          // indistinguishable from a real one, and it is the whole difference
          // between a lake and a blue-grey sheet. Chop dissolves it, as chop
          // does.
          float bankHit = 0.0;
          for (int bi = 1; bi <= 3; bi++) {
            float bt = float(bi * bi) * 30.0;
            vec3 rp = vec3(vWorld.x, uWaterLevel, vWorld.z) + refl * bt;
            float g = terrainFast(rp.xz);
            bankHit = max(bankHit, smoothstep(3.0, 18.0, g - rp.y) * (1.0 - bt / 340.0));
          }
          skyCol = mix(skyCol, uBank, bankHit * mix(0.7, 0.3, uWindAmt) * (1.0 - smoothstep(900.0, 2200.0, vDist)));

          vec3 col = mix(body, skyCol, clamp(fres, 0.0, waterMirror(uWindAmt)));

          // The far texture: ~900 m weather bands, wobbled off straight, in
          // brightness only — brightness survives at ranges where normal
          // detail is corduroy. Applied to the *final* colour rather than the
          // body: at distance the pixel is mostly fresnel sky, and a band
          // modulating only the body arrived at the screen at a third of its
          // size, which is to say invisibly.
          float s2 = sin(dot(vWorld.xz, uSwell) * 0.007 - uTime * 0.1 + csNoise(vWorld.xz * 0.0016) * 2.6);
          col *= 1.0 + s2 * 0.09 * (0.35 + 0.65 * uFoam);

          // Foam flecks: sparse threads of blown foam, stretched hard along
          // the wind — the crisp element the soft fields above cannot supply,
          // and from a few hundred metres up the clearest sign the sea is a
          // surface with weather on it rather than a material.
          vec2 fq = vec2(dot(vWorld.xz, uSwell), dot(vWorld.xz, vec2(-uSwell.y, uSwell.x)));
          // Twenty metres long rather than fifty. Stretched 6:1 and held close,
          // these stopped being blown foam and became scratches drawn across the
          // water directly below the aircraft — the one place the eye can see
          // that a streak has hard ends.
          float fleck = smoothstep(0.80, 0.99, csNoise(vec2(fq.x * 0.05 - uTime * 0.5, fq.y * 0.12)));
          // Half what it was, and it fades in rather than starting at full
          // strength under the aircraft. The lattice is stretched fifty metres
          // downwind against four across, which at close range stopped being
          // blown foam and became scratches on the surface.
          col = mix(col, vec3(1.0), fleck * uWindAmt * 0.09
            * smoothstep(400.0, 1000.0, vDist) * (1.0 - smoothstep(1800.0, 3200.0, vDist)));

          // Facet shimmer, sun glitter and the road it lies on — the river
          // ribbons get the identical three from the same chunk.
          col += waterGlitter(n, viewDir, uSunDir, skyCol, 1.0 - smoothstep(500.0, 2600.0, vDist));

          // Whitecaps where chop and swell crest together — kept close, where
          // individual caps are readable, and only as much wind as the day has.
          float crest = smoothstep(0.62, 1.15, w0 + s0 * 0.45) * (1.0 - smoothstep(200.0, 800.0, vDist));
          col += mix(skyCol, vec3(1.0), 0.4) * crest * uWindAmt * 0.12;
          // And past them, cap *patches*: fields of broken water riding the
          // wind, in brightness only, out to where the fog takes over. The sea
          // between 800 m and 3 km used to have literally nothing happening on
          // it — this is the something.
          //
          // The patches are 77 m across, so they belong to the middle distance
          // and nowhere nearer: held in at 150 m they came out as a field of
          // pale lozenges lying on the water directly under the aircraft, each
          // one bigger than the wing. They start where a 77 m patch is a
          // brushstroke rather than a shape.
          float capN = csNoise(vWorld.xz * 0.013 - uSwell * (uTime * 1.4) + 5.0);
          float caps = smoothstep(0.72, 0.92, capN + s0 * 0.12) * uWindAmt
                     * smoothstep(700.0, 1500.0, vDist) * (1.0 - smoothstep(2400.0, 4200.0, vDist));
          col = mix(col, vec3(1.0), caps * 0.14);

          // --- surf ----------------------------------------------------------
          // How far out the animation is allowed to run. Distant animated
          // bands are the shaking-coast bug reborn, so motion fades to a
          // static rim past a kilometre.
          float farAnim = smoothstep(350.0, 1100.0, vDist);
          // Foam is bubbles, not paint: a fast dapple that eats holes in
          // every band below, which is most of what separates surf from a
          // white contour line.
          //
          // A 3 m lattice, so it has to fade to flat before it goes sub-pixel:
          // with the distance finally correct this term is legible for the first
          // time, and past a few hundred metres it was arriving as shimmer on
          // every foam line at once.
          float bubbles = mix(
            0.55 + 0.45 * csNoise(vWorld.xz * 0.3 + uSwell * (uTime * mix(1.2, 0.0, farAnim))),
            1.0,
            smoothstep(250.0, 800.0, vDist)
          );

          // The lip: a thin bright line hard against the waterline. Its
          // narrowness is the point — this is what makes the coast read as a
          // *line* again instead of the wide breathing band that smeared
          // every island into a halo.
          float lip = (1.0 - smoothstep(0.25, 2.2, depth)) * smoothstep(0.02, 0.3, depth);

          // Breakers: foam lines keyed to the depth itself, so every line is
          // parallel to its own beach and wraps around every headland for
          // free. The phase marches shoreward; the swell pulses it; a slow
          // along-shore noise breaks the lines so they arrive as surf rather
          // than as bathymetry.
          //
          // One cycle per eleven metres of depth, not per four. Keying the phase
          // to depth means the *shelf* sets how many lines there are, and on a
          // gently shelving coast the old rate drew five and six of them at once
          // — concentric rings following the bathymetry, which read as a contour
          // map rather than as surf. Two lines is what a beach has. The band is
          // shallower for the same reason: breakers happen where the bottom is
          // close, and 24 m is not close.
          float bph = depth * 0.55 - uTime * mix(0.8, 0.0, farAnim) + s0 * 0.6;
          float bline = smoothstep(0.55, 0.95, sin(bph) * 0.5 + 0.5);
          float bmask = (1.0 - smoothstep(3.0, 13.0, depth)) * smoothstep(0.5, 1.6, depth);
          float alongShore = 0.55 + 0.45 * csNoise(vWorld.xz * 0.016 + 11.0);
          float breakers = bline * bmask * alongShore;

          float surf = (lip * 1.2 + breakers * 1.1) * bubbles * uFoam;
          // Far coasts keep a rim, never a halo — but the rim holds to the
          // fog, because a coastline is exactly the thing the eye traces at
          // distance.
          surf *= 1.0 - smoothstep(3000.0, 5000.0, vDist) * 0.85;
          // Foam is white. The first tint leaned on uShallow and every rim
          // came out the colour of the water it was breaking on.
          col = mix(col, mix(vec3(1.0), uShallow, 0.3), clamp(surf, 0.0, 1.0) * 0.6);

          // Caustics: the light web on a shallow bed, two ridged noise fields
          // folded against each other, drifting out of phase. Gated to
          // snorkelling depth and the near field — from further away it is
          // sub-pixel shimmer, which the sea has taught this file about twice.
          float cr1 = 1.0 - abs(2.0 * csNoise(vWorld.xz * 0.11 + vec2(uTime * 0.045, 0.0)) - 1.0);
          float cr2 = 1.0 - abs(2.0 * csNoise(vWorld.xz * 0.13 + vec2(4.7, -uTime * 0.05)) - 1.0);
          float caust = pow(min(cr1, cr2), 3.0);
          float cmask = smoothstep(0.4, 1.8, depth) * (1.0 - smoothstep(3.5, 9.0, depth))
                      * (1.0 - smoothstep(200.0, 650.0, vDist));
          // A third of the strength it was written at, and much less of the
          // sun's own colour in it. Both for the same reason: this is the first
          // build in which caustics have ever been drawn, and at full weight a
          // shallow shelf came out as a swimming pool — on a red evening, as a
          // field of orange sparks. What a caustic web should be from a glider
          // is a suggestion of texture on a sandbar, not the brightest thing in
          // the frame.
          col += mix(vec3(1.0), uSun, 0.22) * caust * cmask * 0.11;

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
          ${TONEMAP_GLSL}
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
