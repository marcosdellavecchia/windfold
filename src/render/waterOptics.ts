/**
 * The optics every water surface in the game shares.
 *
 * There are two of them — the lake plane in `Water.tsx` and the river ribbons in
 * `Streams.tsx` — and they were written a long way apart, so they disagreed
 * about what water does with light. The river carried a Fresnel *floor* of 0.38,
 * meaning it showed at least 38% sky no matter where it was seen from, while the
 * lake beside it, viewed from the same glider at the same angle, showed under
 * one percent. From the air that is not a subtle difference: the river read as
 * polished metal laid over the ground, and at the river's mouth the two of them
 * met along a line with a step in it.
 *
 * The floor was a fix for a real problem — an unlit ribbon of raw palette water
 * has none of the day's weather in it and stayed cold blue under an orange
 * sunset — but it was the wrong fix, because the lake solves the same problem
 * without it: the sky it reflects, the glint it returns and the facets that
 * shimmer are where a lake gets its warmth. Give the river the same three and it
 * gets warm the same way.
 *
 * So: one Fresnel curve, one reflection, one glitter, one mirror cap. What the
 * two surfaces are still allowed to differ on is what is *under* them — a lake
 * has depth and a bed too far down to see, a river is a hand's depth of water
 * over sand — because that difference is real.
 *
 * Expects `uSkyTop`, `uSkyHorizon`, `uFog` and `uSun` to be declared by whoever
 * includes it, along with the shared `AIR_FOG_GLSL` chunk it calls into.
 */
export const WATER_OPTICS_GLSL = /* glsl */ `
  /**
   * The sky's colour in a reflected direction — the same two steps Sky.tsx
   * paints with, so the reflection and the thing being reflected cannot drift
   * apart. The horizon half of the gradient takes the directional haze: the sky
   * is warm around the sun's azimuth, so water reflecting it glows on the same
   * side, which is most of what a lake at golden hour actually does.
   */
  vec3 skyTone(float up, vec2 az) {
    vec3 h = mix(uSkyHorizon, airFogColor(normalize(vec3(az.x, 0.12, az.y))), 0.55);
    vec3 s = mix(h, uSkyTop, smoothstep(0.0, 0.55, up));
    return mix(uFog, s, smoothstep(-0.03, 0.28, up));
  }

  /**
   * The image the surface returns: the sky in the direction the wave sends the
   * eye. Every crest and trough returns a different part of the dome, which is
   * the whole reason a water surface reads as reflective — the image moves when
   * the surface does.
   *
   * Biased upward rather than taken straight. A true grazing reflection returns
   * the horizon, and near a low sun the horizon is cream, which turns water into
   * desert. Keeping some of the zenith in the sample preserves the variation
   * without bringing the desert back.
   */
  vec3 waterReflection(vec3 nrm, vec3 viewDir) {
    vec3 refl = reflect(-viewDir, nrm);
    return skyTone(mix(max(refl.y, 0.0), 0.8, 0.45), refl.xz);
  }

  /**
   * How much of it shows. Looking straight down you see into the water; at a
   * grazing angle the surface turns into a mirror of the sky, and that flip is
   * most of what sells water seen from an aircraft.
   */
  float waterFresnel(vec3 nrm, vec3 viewDir) {
    return pow(1.0 - clamp(dot(nrm, viewDir), 0.0, 1.0), 4.0);
  }

  /**
   * The ceiling on it, which is well below 1: a physically full mirror at
   * grazing angles turns every lake and every river the same colour as the sky
   * and the landscape goes monochrome. Water keeps some of its own body colour
   * at every angle — though a calm day earns more mirror than a windy one.
   */
  float waterMirror(float windAmt) {
    return mix(0.55, 0.42, windAmt);
  }

  /**
   * Everything the bright sky and the sun add on top of the body colour.
   *
   * The facet term first: real water glitters in every direction, because every
   * facet mirrors *somewhere* bright. It is what keeps a calm dusk surface alive
   * when the sun is behind the camera and the sparkle has nothing to catch.
   * Then the sun's own tight sparkle, and the road it lies on — the broad ragged
   * path from the sun to the eye that all the sparkles sit in, which is probably
   * the single most recognisable thing about sunlit water. The road needs no
   * extra waves: the same normal, read with a much softer exponent.
   *
   * The near term fades the facet out with distance, where it would be sub-pixel
   * shimmer; the sun terms hold, because a glitter path is legible as far as the
   * water is.
   */
  vec3 waterGlitter(vec3 nrm, vec3 viewDir, vec3 sunDir, vec3 skyCol, float near) {
    vec3 up = normalize(vec3(0.0, 1.0, 0.0) + viewDir);
    vec3 h = normalize(normalize(sunDir) + viewDir);
    float d = max(dot(nrm, h), 0.0);
    return skyCol * pow(max(dot(nrm, up), 0.0), 60.0) * 0.22 * near
         + uSun * (pow(d, 220.0) * 0.8 + pow(d, 16.0) * 0.30);
  }
`
