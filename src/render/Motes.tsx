import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { mulberry32 } from '../sim/rng'

const COUNT = 360
/** Half-extent of the box the motes live in, metres. */
const BOX = 110

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

    const pal = world.palette
    const mat = new ShaderMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: {
        // Sunlit dust, pulled toward the counter-glow so the motes carry the day's
        // colour rather than being a layer of white on top of it.
        uColor: {
          value: new Color(rgbToHex(pal.sun))
            .lerp(new Color(0xffffff), 0.5)
            .lerp(new Color(rgbToHex(pal.glow)), 0.22),
        },
        uViewportH: { value: 1000 },
        uTime: { value: 0 },
        uBox: { value: BOX },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute float aPhase;
        uniform float uViewportH;
        uniform float uTime;
        uniform float uBox;
        varying float vAlpha;

        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 0.001);
          gl_PointSize = (0.5 + aSeed * 0.6) * (uViewportH * projectionMatrix[1][1] * 0.5) / dist;
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
        varying float vAlpha;

        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          float t = clamp(1.0 - d * 2.0, 0.0, 1.0);
          // Low enough to sit under the landscape rather than on top of it: motes
          // this size read as dirt on the lens long before they read as bright.
          float a = t * t * t * vAlpha * 0.3;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    })

    return { geometry: geo, material: mat, state: { positions, drift } }
  }, [world])

  material.uniforms.uViewportH.value = viewportHeight

  const ref = useRef<Points>(null)
  const clock = useRef(0)

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    clock.current += dt
    material.uniforms.uTime.value = clock.current

    const { positions, drift } = state
    const cam = camera.position
    const span = BOX * 2

    // Positions are world-space, so the wrap is a modulo against the camera rather
    // than a parented box — otherwise the motes would ride along with the aircraft
    // and there would be no parallax, which is the entire reason they exist.
    for (let i = 0; i < COUNT; i++) {
      const j = i * 3
      let x = positions[j] + drift[j] * dt + world.air.windX * dt * 0.15
      let y = positions[j + 1] + drift[j + 1] * dt
      let z = positions[j + 2] + drift[j + 2] * dt + world.air.windZ * dt * 0.15

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
