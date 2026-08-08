import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { mulberry32 } from '../sim/rng'

const PER_COLUMN = 55
/** How far up the column the dust is drawn, in metres. See the note in useFrame. */
const VISIBLE_COLUMN = 260

/**
 * Dust lifted by the thermals — the close-range cue only. Cumulus marks where the
 * lift is from kilometres away, so dust no longer has to shout; its job is the last
 * few hundred metres, telling you the core is *here* rather than over there. It was
 * much brighter before the clouds existed, and at 48 columns that read as a field of
 * fireflies strewn across the ground. But not so
 * readable that it survives the fog. Scene fog cannot do that job here: three
 * mixes fogged fragments *toward* the fog colour, and under additive blending
 * that brightens rather than hides, which turns every distant column into a
 * field of stars hanging in the sky. So the fade is explicit, in the shader.
 */
export function Thermals({ world }: { world: World }) {
  const ref = useRef<Points>(null)
  const viewportHeight = useThree((s) => s.size.height * s.viewport.dpr)

  const { geometry, material, state } = useMemo(() => {
    const rng = mulberry32(world.seed ^ 0x5eed)
    const thermals = world.air.thermals
    const n = thermals.length * PER_COLUMN

    const positions = new Float32Array(n * 3)
    const angle = new Float32Array(n)
    const radius = new Float32Array(n)
    const height = new Float32Array(n)
    const spin = new Float32Array(n)
    const owner = new Int32Array(n)

    for (let t = 0; t < thermals.length; t++) {
      for (let k = 0; k < PER_COLUMN; k++) {
        const i = t * PER_COLUMN + k
        owner[i] = t
        angle[i] = rng() * Math.PI * 2
        radius[i] = Math.sqrt(rng()) * 0.68
        // Weighted toward the base: that is the part of the column an aircraft
        // actually flies into, and a column that is dense low down reads as a
        // column instead of as scattered specks.
        height[i] = Math.pow(rng(), 1.5)
        spin[i] = 0.25 + rng() * 0.5
      }
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3).setUsage(35048))

    const tint = new Color(rgbToHex(world.palette.sun)).lerp(new Color(0xffffff), 0.45)
    const mat = new ShaderMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uColor: { value: tint },
        uSize: { value: 5 },
        uOpacity: { value: 0.36 },
        uViewportH: { value: 1000 },
        uFadeNear: { value: 2100 },
        uFadeFar: { value: 3400 },
      },
      vertexShader: /* glsl */ `
        uniform float uSize;
        uniform float uViewportH;
        uniform float uFadeNear;
        uniform float uFadeFar;
        varying float vFade;

        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 0.001);
          // Exact perspective attenuation: projectionMatrix[1][1] is 1/tan(fov/2).
          gl_PointSize = uSize * (uViewportH * projectionMatrix[1][1] * 0.5) / dist;
          gl_Position = projectionMatrix * mv;
          vFade = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vFade;

        void main() {
          // Soft disc, computed rather than sampled — no texture to ship. The
          // cubic falloff matters: a hard-edged disc reads as a bright bead
          // rather than as a speck of lit dust.
          float d = length(gl_PointCoord - vec2(0.5));
          float t = clamp(1.0 - d * 2.0, 0.0, 1.0);
          float a = t * t * t;
          if (a <= 0.0 || vFade <= 0.0) discard;
          gl_FragColor = vec4(uColor, a * uOpacity * vFade);
        }
      `,
    })

    return { geometry: geo, material: mat, state: { positions, angle, radius, height, spin, owner } }
  }, [world])

  material.uniforms.uViewportH.value = viewportHeight

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.1)
    const thermals = world.air.thermals
    const { positions, angle, radius, height, spin, owner } = state

    for (let i = 0; i < owner.length; i++) {
      const t = thermals[owner[i]]
      // The lift reaches all the way to t.top, but the dust only marks the bottom
      // of it. A column drawn to full height wraps the sky when you fly near its
      // base and reads as a starfield; a low plume reads as a place on the ground
      // worth flying to, which is what the player actually needs from it.
      const span = Math.min(t.top - t.base, VISIBLE_COLUMN)

      height[i] += (t.strength / span) * 0.35 * d
      if (height[i] > 1) height[i] -= 1
      angle[i] += spin[i] * d

      // Columns lean downwind and widen as they rise.
      const widen = 0.35 + height[i] * 0.85
      const r = radius[i] * t.radius * widen
      const drift = height[i] * span * 0.12

      positions[i * 3] = t.x + Math.cos(angle[i]) * r + world.air.windX * drift * 0.06
      positions[i * 3 + 1] = t.base + height[i] * span
      positions[i * 3 + 2] = t.z + Math.sin(angle[i]) * r + world.air.windZ * drift * 0.06
    }

    if (ref.current) (ref.current.geometry.attributes.position as BufferAttribute).needsUpdate = true
  })

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} />
}
