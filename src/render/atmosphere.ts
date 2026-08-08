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
