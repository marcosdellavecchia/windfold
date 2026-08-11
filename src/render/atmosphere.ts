import { Color, Vector3, type Material } from 'three'
import type { World } from '../sim/world'

/**
 * Single source of truth for the fog. Three separate shaders reproduce the scene's
 * FogExp2 by hand — water, clouds, and anything else that needs to blend into the
 * same haze — and if any of them disagrees with the renderer the seam shows up as a
 * hard line along the horizon.
 *
 * Tuned to the 12 km map: the original 0.00055 was set for a 6 km world and buried
 * everything past two kilometres, which is most of the landscape the player is
 * supposed to be enjoying.
 */
export const FOG_DENSITY = 0.00034

/** Distance at which fog is essentially total — useful for sizing scenery radii. */
export const FOG_LIMIT = 5200

/**
 * Cloud shadows, drifting with the day's wind. The single cheapest thing that
 * makes the landscape read as alive from the air: the ground is constantly
 * mottled by shade sliding across it, the way it actually is under a cumulus
 * sky. Shared here because terrain and water each apply it in their own shader,
 * and the patches have to line up across every shoreline — same field, same
 * seed, same clock, or the coast shows a seam in the shade.
 *
 * Function names are prefixed so they can be pasted into any shader without
 * colliding with its own hash or noise helpers.
 */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
  float csHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float csNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(csHash(i), csHash(i + vec2(1.0, 0.0)), f.x),
      mix(csHash(i + vec2(0.0, 1.0)), csHash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }
  float cloudShadow(vec2 xz, vec2 wind, float t, float seed) {
    // Two octaves at cumulus scale. The field drifts downwind a touch faster
    // than the air so the motion is perceptible from a moving aircraft.
    vec2 p = (xz - wind * (t * 1.6)) * (1.0 / 950.0) + seed;
    float n = csNoise(p) * 0.65 + csNoise(p * 2.7 + 13.1) * 0.35;
    return 1.0 - smoothstep(0.52, 0.8, n) * 0.16;
  }
`

/** Seed offset for the shadow field — one value per day, shared by every user. */
export const cloudShadowSeed = (seed: number) => ((seed >>> 3) % 4096) / 151

/* ------------------------------------------------------ directional haze ---- */

/**
 * The atmosphere's second dimension: which way you are looking.
 *
 * FogExp2 is one colour in every direction, and real haze is not — it scatters
 * the sun forward, so the air is warm looking sunward and cool looking away.
 * That asymmetry is most of why a golden-hour photograph looks lit while a flat
 * fog looks laminated, and this game's sun is *always* low. The functions below
 * replace the flat mix everywhere the haze is wide enough to read: terrain,
 * water, streams, clouds, the sky's own horizon band. They must all agree or
 * the seams come back, which is why this lives here with the cloud shadows.
 *
 * The mist term is the same idea vertically: air is thicker near the valley
 * floor, so distant low ground hazes over before distant peaks do, and on a
 * hazy or gloaming day the basins fill. It is added on top of the distance fog
 * rather than woven into it — the exp2 curve every shader already matches is
 * left exactly alone, and mist can only ever add haze, never remove it.
 *
 * One set of uniform objects, shared by reference across every material that
 * pastes the GLSL, so `updateAirFog` at world build re-points the whole scene
 * at once — the same single-source rule as FOG_DENSITY, for the same reason.
 */
export const AIR_FOG_UNIFORMS = {
  uFogBase: { value: new Color(1, 1, 1) },
  uFogWarm: { value: new Color(1, 1, 1) },
  uFogCool: { value: new Color(1, 1, 1) },
  uFogSunDir: { value: new Vector3(0, 1, 0) },
  /** x: mist amount, y: 1 / mist height scale (1/m), z: mist floor altitude (m). */
  uFogMist: { value: new Vector3(0, 0.02, 0) },
}

/**
 * How much mist each grade earns. The name finally does something mechanical.
 *
 * A third lower across the board than the first cut, which looked wonderful on
 * the mesa and quietly erased every alpine lake: a small dark lake is exactly
 * the thing a pale wash over its basin has the contrast to destroy, and even a
 * `deep` day was burying them.
 */
const MIST_BY_MOOD: Record<string, number> = {
  clear: 0.08,
  daybreak: 0.14,
  gloaming: 0.22,
  hazy: 0.34,
  reverie: 0.12,
  deep: 0.16,
}

export function updateAirFog(world: World) {
  const pal = world.palette
  const hf = world.heightfield
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  AIR_FOG_UNIFORMS.uFogBase.value.setRGB(pal.fog[0], pal.fog[1], pal.fog[2])
  // Warm toward the sun's own colour, cool toward the zenith — both anchored on
  // the day's fog so a palette that is already violet stays violet, just lit.
  AIR_FOG_UNIFORMS.uFogWarm.value.setRGB(
    mix(pal.fog[0], pal.sun[0], 0.45),
    mix(pal.fog[1], pal.sun[1], 0.45),
    mix(pal.fog[2], pal.sun[2], 0.45),
  )
  AIR_FOG_UNIFORMS.uFogCool.value.setRGB(
    mix(pal.fog[0], pal.skyTop[0], 0.3),
    mix(pal.fog[1], pal.skyTop[1], 0.3),
    mix(pal.fog[2], pal.skyTop[2], 0.3),
  )
  AIR_FOG_UNIFORMS.uFogSunDir.value.copy(world.sunDir)
  const range = Math.max(hf.max - hf.min, 1)
  // Mist pools from the waterline (or the lowest basin on a dry map) and is
  // gone within well under a tenth of the relief — it should sit *in* the
  // valley floors, not wash the basins that hold them.
  AIR_FOG_UNIFORMS.uFogMist.value.set(
    MIST_BY_MOOD[pal.mood] ?? 0.14,
    1 / Math.min(Math.max(range * 0.07, 35), 65),
    hf.hasWater ? hf.waterLevel : hf.min,
  )
}

/**
 * Pasted into every shader that fogs by hand. `rd` is the view ray, camera to
 * fragment, normalised. `airFogAmount` is the scene's exact exp2 fog plus the
 * mist term; anything using it converges on `airFogColor` at the same distance
 * everything else does, which is the invariant that keeps the horizon seamless.
 */
export const AIR_FOG_GLSL = /* glsl */ `
  uniform vec3 uFogBase;
  uniform vec3 uFogWarm;
  uniform vec3 uFogCool;
  uniform vec3 uFogSunDir;
  uniform vec3 uFogMist;

  vec3 airFogColor(vec3 rd) {
    float s = dot(rd, uFogSunDir);
    // A tight-ish forward lobe: the warmth belongs to the third of the sky
    // around the sun, not to a whole hemisphere. The cool side is broader and
    // gentler — the shadow half of the air, not a second light.
    float warm = pow(clamp(s, 0.0, 1.0), 3.0) * 0.85;
    float cool = clamp(-s, 0.0, 1.0) * 0.3;
    return mix(mix(uFogBase, uFogCool, cool), uFogWarm, warm);
  }

  // mistW scales the mist term only — the distance fog is not negotiable, or
  // the horizon seams come back. It exists for the water: the mist floor IS the
  // waterline, so a lake surface sits at maximum mist density by construction,
  // and at full weight every lake on the map washed out to a pale patch that no
  // longer read as water. The haze belongs to the valley around the lake; the
  // lake itself keeps most of its colour.
  float airFogAmountW(float dist, float fragY, float mistW) {
    float f = dist * ${FOG_DENSITY.toFixed(6)};
    float base = 1.0 - exp(-f * f);
    // Mist: exponential in the fragment's height above the mist floor, ramping
    // in over ~600 m of distance so the ground at your feet stays clear. It
    // scales the *remaining* transparency, so the total can approach but never
    // pass 1 and the exp2 the rest of the scene matches is untouched.
    float mist = mistW * uFogMist.x * exp(-max(fragY - uFogMist.z, 0.0) * uFogMist.y)
               * (1.0 - exp(-dist * 0.0016));
    return min(base + mist * (1.0 - base), 1.0);
  }

  float airFogAmount(float dist, float fragY) {
    return airFogAmountW(dist, fragY, 1.0);
  }
`

/**
 * Route a built-in material's fog through the directional haze. Replaces the
 * stock fog chunk, so the scene's FogExp2 still drives every material that is
 * *not* patched (birds, ghost lines, the trail) — those are thin or near
 * elements where a flat approximation can't show a seam against the ground.
 * Handles instancing, because most of what wears this is an InstancedMesh.
 */
export function patchAirFog(mat: Material) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AIR_FOG_UNIFORMS)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAirWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 airWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            airWorld = instanceMatrix * airWorld;
          #endif
          vAirWorld = (modelMatrix * airWorld).xyz;
        }`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAirWorld;\n${AIR_FOG_GLSL}`)
      .replace(
        '#include <fog_fragment>',
        `{
          vec3 airRay = vAirWorld - cameraPosition;
          float airDist = length(airRay);
          gl_FragColor.rgb = mix(
            gl_FragColor.rgb,
            airFogColor(airRay / max(airDist, 1e-4)),
            airFogAmount(airDist, vAirWorld.y)
          );
        }`,
      )
  }
}
