import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three'
import type { World } from '../sim/world'
import { rgbToHex, type Rgb } from '../sim/palette'
import { forestDay } from '../sim/flora'
import { mulberry32 } from '../sim/rng'
import { TONEMAP_GLSL } from './grade'

const COUNT = 360
/** Half-extent of the box the motes live in, metres. */
const BOX = 110

/**
 * What the specks *are*, per day. One field of points serves every biome, but the
 * same white fluff hanging over a desert, a lava field and an orchard quietly told
 * the player these were the same place with different paint. The theme decides the
 * story the near air tells: dust rides the wind on a mesa day, embers hang and
 * pulse over the volcano, spray drifts along a coast — and on the rare blossom and
 * autumn days the woods already have, the air fills with petals or leaves, which
 * turns a palette event into weather you fly through.
 */
interface MoteTheme {
  color: Color
  /** Point size multiplier. Petals and leaves are things, dust is a haze. */
  size: number
  /** Sink rate, m/s. Only the falling kinds have one. */
  fall: number
  /** Horizontal sway amplitude, m/s — the flutter of a thing with surface area. */
  flutter: number
  /** How much of the day's wind the motes ride. Dust is mostly wind. */
  wind: number
  /** Peak alpha. Embers get to glow a little; haze has to stay under the scenery. */
  glow: number
}

function moteTheme(world: World): MoteTheme {
  const pal = world.palette
  const tint = (base: Rgb, toWhite: number) => new Color(rgbToHex(base)).lerp(new Color(0xffffff), toWhite)
  // Sunlit dust, pulled toward the counter-glow so the motes carry the day's
  // colour rather than being a layer of white on top of it. The default, and the
  // base the biomes below adjust from.
  const theme: MoteTheme = {
    color: tint(pal.sun, 0.5).lerp(new Color(rgbToHex(pal.glow)), 0.22),
    size: 1,
    fall: 0,
    flutter: 0,
    wind: 0.15,
    glow: 0.3,
  }

  switch (world.biome) {
    case 'mesa':
      // Dust. It belongs to the wind, not to itself — the strongest wind-follow
      // in the game, and slightly dimmer, because dust is a haze rather than a
      // collection of objects.
      theme.color = tint(pal.sand, 0.35).lerp(new Color(rgbToHex(pal.sun)), 0.3)
      theme.size = 0.9
      theme.wind = 0.5
      theme.glow = 0.26
      return theme
    case 'volcanic':
      // Embers and windborne ash. The ember colour is the palette's own `bloom`,
      // which on this biome is already cooling lava — brighter than anything else
      // here gets to be, since an ember is a light source and additive blending
      // finally works in its favour.
      theme.color = tint(pal.bloom, 0.2)
      theme.size = 1.1
      theme.fall = 0.2
      theme.glow = 0.42
      return theme
    case 'coastal':
      // Salt haze off the water: pale, cool, and carried along the shore.
      theme.color = tint(pal.skyHorizon, 0.55)
      theme.size = 0.85
      theme.wind = 0.35
      theme.glow = 0.24
      return theme
    case 'alpine':
      // Glacial flour and ice glitter — smaller and a touch brighter, so the
      // twinkle does the work.
      theme.size = 0.75
      theme.glow = 0.34
      return theme
    case 'valley':
      // Seed fluff over the meadows, barely sinking.
      theme.fall = 0.12
      theme.flutter = 0.35
      return theme
    default:
      return theme
  }
}

/**
 * The season override, on the biomes whose woods can carry one. `forestDay`
 * already turns the canopy toward blossom or gold a few days in seventeen; the
 * same roll fills the air. Not on mesa or volcanic days — a handful of scrub
 * does not shed a sky full of petals.
 */
function applySeason(theme: MoteTheme, world: World) {
  if (world.biome === 'mesa' || world.biome === 'volcanic') return
  const season = forestDay(world.seed).season
  if (!season) return
  const pal = world.palette
  const base = season === 'blossom' ? pal.bloom : pal.sun
  theme.color = new Color(rgbToHex(base)).lerp(new Color(0xffffff), season === 'blossom' ? 0.35 : 0.22)
  // Big enough to read as a thing rather than a speck, falling and swaying —
  // the flutter is what says "petal" instead of "snow".
  theme.size = 1.5
  theme.fall = season === 'blossom' ? 0.5 : 0.7
  theme.flutter = season === 'blossom' ? 1.2 : 1.5
  theme.glow = 0.34
}

/**
 * Pollen, seed fluff, dust — whatever it is, it is the thing hanging in the air in
 * front of you that nothing else in the scene provides.
 *
 * Everything else in the world is at least a hundred metres away: terrain, trees,
 * clouds, birds. With nothing close to the camera there is no motion parallax at
 * all, and at 21 m/s the frame reads as a slowly panning painting rather than as
 * flying. A few hundred specks a few metres off the wing fix that on their own, and
 * they are the one element that gets to be pure atmosphere with no job in the sim.
 *
 * They live in a box that wraps around the camera, so the same 420 points follow
 * the aircraft across all 12 km and are never placed, streamed or rebuilt.
 */
export function Motes({ world }: { world: World }) {
  const camera = useThree((s) => s.camera)
  const viewportHeight = useThree((s) => s.size.height * s.viewport.dpr)

  const { geometry, material, state } = useMemo(() => {
    const rng = mulberry32(world.seed ^ 0x3f0a7)
    const theme = moteTheme(world)
    applySeason(theme, world)
    const positions = new Float32Array(COUNT * 3)
    const phase = new Float32Array(COUNT)
    const drift = new Float32Array(COUNT * 3)
    const seed = new Float32Array(COUNT)

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (rng() * 2 - 1) * BOX
      positions[i * 3 + 1] = (rng() * 2 - 1) * BOX
      positions[i * 3 + 2] = (rng() * 2 - 1) * BOX
      phase[i] = rng() * Math.PI * 2
      // Barely moving. These are meant to hang, not to fly past under their own
      // power — all the speed in the shot should come from the aircraft.
      drift[i * 3] = (rng() - 0.5) * 0.5
      drift[i * 3 + 1] = (rng() - 0.5) * 0.28
      drift[i * 3 + 2] = (rng() - 0.5) * 0.5
      seed[i] = 0.6 + rng() * 1.6
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3).setUsage(35048))
    geo.setAttribute('aSeed', new BufferAttribute(seed, 1))
    geo.setAttribute('aPhase', new BufferAttribute(phase, 1))

    const mat = new ShaderMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uColor: { value: theme.color },
        uViewportH: { value: 1000 },
        uTime: { value: 0 },
        uBox: { value: BOX },
        uSize: { value: theme.size },
        uGlow: { value: theme.glow },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute float aPhase;
        uniform float uViewportH;
        uniform float uTime;
        uniform float uBox;
        uniform float uSize;
        varying float vAlpha;

        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 0.001);
          gl_PointSize = uSize * (0.5 + aSeed * 0.6) * (uViewportH * projectionMatrix[1][1] * 0.5) / dist;
          gl_Position = projectionMatrix * mv;

          // Fade out well inside the box, because its faces are where a mote gets
          // teleported to the far side, and a speck winking in mid-frame is the one
          // thing that would give the trick away. A mote is already invisible at
          // uBox * 0.95, and cannot wrap until it is further out than uBox.
          float edge = 1.0 - smoothstep(uBox * 0.5, uBox * 0.95, dist);
          // Nothing catching the light stays the same brightness for long. The
          // twinkle is most of what stops these reading as a fixed screen overlay.
          float twinkle = 0.45 + 0.55 * sin(uTime * aSeed * 1.7 + aPhase);
          // And hold them off the very near plane, where a mote is a bright disc
          // across a tenth of the screen.
          vAlpha = edge * twinkle * smoothstep(1.5, 7.0, dist);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uGlow;
        varying float vAlpha;

        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          float t = clamp(1.0 - d * 2.0, 0.0, 1.0);
          // Low enough to sit under the landscape rather than on top of it: motes
          // this size read as dirt on the lens long before they read as bright.
          // uGlow is the theme's one licence to break that — embers are lights.
          float a = t * t * t * vAlpha * uGlow;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor, a);
          ${TONEMAP_GLSL}
        }
      `,
    })

    return { geometry: geo, material: mat, state: { positions, drift, phase, theme } }
  }, [world])

  material.uniforms.uViewportH.value = viewportHeight

  const ref = useRef<Points>(null)
  const clock = useRef(0)

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    clock.current += dt
    material.uniforms.uTime.value = clock.current

    const { positions, drift, phase, theme } = state
    const cam = camera.position
    const span = BOX * 2
    const t = clock.current

    // Positions are world-space, so the wrap is a modulo against the camera rather
    // than a parented box — otherwise the motes would ride along with the aircraft
    // and there would be no parallax, which is the entire reason they exist.
    for (let i = 0; i < COUNT; i++) {
      const j = i * 3
      // The flutter is a slow figure the mote traces around its drift, phased per
      // mote — what makes a petal a petal instead of a sinking dot. Zero on the
      // themes that are haze.
      const sway = theme.flutter > 0 ? Math.sin(t * 1.3 + phase[i]) * theme.flutter : 0
      const swayZ = theme.flutter > 0 ? Math.cos(t * 1.1 + phase[i] * 1.7) * theme.flutter : 0
      let x = positions[j] + (drift[j] + sway) * dt + world.air.windX * dt * theme.wind
      let y = positions[j + 1] + (drift[j + 1] - theme.fall) * dt
      let z = positions[j + 2] + (drift[j + 2] + swayZ) * dt + world.air.windZ * dt * theme.wind

      x -= span * Math.round((x - cam.x) / span)
      y -= span * Math.round((y - cam.y) / span)
      z -= span * Math.round((z - cam.z) / span)

      positions[j] = x
      positions[j + 1] = y
      positions[j + 2] = z
    }

    if (ref.current) (ref.current.geometry.attributes.position as BufferAttribute).needsUpdate = true
  })

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />
}
