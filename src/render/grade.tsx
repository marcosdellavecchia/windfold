import { useFrame, useThree } from '@react-three/fiber'
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  type ToneMapping,
} from 'three'

/**
 * The curve at the end of the frame.
 *
 * Everything here was authored with no curve at all: a colour computed in a
 * shader went to the screen as it was, and anything above 1.0 became white.
 * That is fine for a palette of pastels and fatal for the one thing in the
 * frame that is genuinely bright — the sun, which clipped to a flat white
 * coin with a hard edge, and the glare around it, which clipped to a flat
 * white field. A tone curve is the difference between a light source and a
 * hole in the image.
 *
 * Two things had to be true for this to be affordable here.
 *
 * The first is that it costs nothing: no render target, no post pass, none of
 * the machinery the art direction ruled out. Three already compiles a
 * `toneMapping()` function into every material when the renderer asks for one;
 * the built-in materials (terrain, trees, the plane) call it themselves, and
 * the hand-written shaders opt in with one include at the end. What the
 * renderer is set to, everything follows.
 *
 * The second is the horizon. Ground and sky converge on the same haze colour
 * at the draw distance, and that is what keeps the map edge from showing as a
 * line — so the fog colour has to come out of both paths identical. In a
 * hand-written shader the haze is mixed in before the curve and gets graded
 * with everything else; in a patched built-in material the haze is mixed in
 * *after* three's tone mapping step, so it has to be graded explicitly on the
 * way in. That is what `graded()` below is for, and forgetting it puts a seam
 * across the horizon that no amount of palette work will close.
 */
export type ToneMode = 'off' | 'neutral' | 'aces' | 'agx' | 'reinhard' | 'cineon'

export const TONE_MODES: ToneMode[] = ['off', 'neutral', 'aces', 'agx', 'reinhard', 'cineon']

const MAPPING: Record<ToneMode, ToneMapping> = {
  off: NoToneMapping,
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  reinhard: ReinhardToneMapping,
  cineon: CineonToneMapping,
}

/**
 * Khronos PBR Neutral, pushed a sixth of a stop.
 *
 * Chosen over ACES and AgX by looking at all six biomes side by side. Both
 * filmic curves answer the sun by restating the whole day: ACES lifts and
 * washes the sky around the sun until the palette's colour is gone from it,
 * and AgX desaturates hard enough that a violet coastal evening comes out
 * grey. Every palette here was authored against no curve at all, and neither
 * of those is a change to the sun — it is six biomes and six colour grades of
 * re-tuning, to fix something else.
 *
 * Neutral only touches the top: the sun stops being a flat white coin and
 * becomes a disc with an edge and a falloff, and the day underneath keeps its
 * colour. It is not quite free — it also subtracts a small black point, which
 * costs about a tenth of the frame's mean brightness and hands back a little
 * saturation. The exposure lift pays that back: at 1.16 four of the six
 * biomes land within 2.5% of the brightness they had, valley 5% under and
 * volcanic 8%, which on the darkest palette in the game reads as mood rather
 * than as error.
 */
const DEFAULT_MODE: ToneMode = 'neutral'
const DEFAULT_EXPOSURE = 1.16

/** Live, so the panel can drive it mid-flight. Same pattern as TUNING. */
export const GRADE: { mode: ToneMode; exposure: number } = {
  mode: DEFAULT_MODE,
  exposure: DEFAULT_EXPOSURE,
}

/** `?grade=agx&exposure=1.2` — for A/B without touching the panel. */
export function readGradeOverride() {
  const q = new URLSearchParams(window.location.search)
  const g = q.get('grade')
  if (g && (TONE_MODES as string[]).includes(g)) GRADE.mode = g as ToneMode
  const e = Number(q.get('exposure'))
  if (Number.isFinite(e) && e > 0) GRADE.exposure = e
}

export function resetGrade() {
  GRADE.mode = DEFAULT_MODE
  GRADE.exposure = DEFAULT_EXPOSURE
}

/**
 * Applies `GRADE` to the renderer. Changing `toneMapping` recompiles every
 * material three is holding, which is why this only writes on a real change —
 * dragging the exposure slider must not rebuild the world's shaders sixty
 * times a second, and exposure alone is a uniform, so it does not.
 */
export function ToneMapping() {
  const gl = useThree((s) => s.gl)
  useFrame(() => {
    const want = MAPPING[GRADE.mode]
    if (gl.toneMapping !== want) gl.toneMapping = want
    if (gl.toneMappingExposure !== GRADE.exposure) gl.toneMappingExposure = GRADE.exposure
  })
  return null
}

/**
 * The tail of a hand-written fragment shader: three's own curve, the same one
 * the built-in materials get, compiled in only when the renderer asks for it.
 */
export const TONEMAP_GLSL = /* glsl */ `
  #include <tonemapping_fragment>
`

/**
 * Grade a colour by hand. For the haze mixed into built-in materials after
 * three has already run its curve — see the horizon note above.
 */
export const GRADED_GLSL = /* glsl */ `
  vec3 graded(vec3 c) {
    #if defined( TONE_MAPPING )
      c = toneMapping(c);
    #endif
    return c;
  }
`
