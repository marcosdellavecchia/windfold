import { useMemo } from 'react'
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { mulberry32 } from '../sim/rng'
import { FOG_DENSITY } from './atmosphere'

/** Soft puffs per cumulus. Enough to read as a lump rather than a disc. */
const PUFFS = 13

/**
 * A cumulus over every thermal, all at the day's condensation level.
 *
 * This is the one piece of scenery that is also a game mechanic. On a 12 km map the
 * dust columns only carry to about 2 km, which is roughly one glide — fine for
 * choosing the next hop, useless for planning a route. Clouds are visible to the
 * fog limit, so the sky becomes a map of where the lift is, and "head for the next
 * cloud" is a rule players teach themselves on the first flight.
 *
 * Drawn as camera-facing billboards from a single instanced quad: one draw call, no
 * sorting, no volumetrics. Depth writes are off and they render after the terrain.
 */
export function Clouds({ world }: { world: World }) {
  const mesh = useMemo(() => {
    const rng = mulberry32(world.seed ^ 0xc10d)
    const thermals = world.air.thermals
    const count = thermals.length * PUFFS

    const offset = new Float32Array(count * 3)
    const scale = new Float32Array(count)
    // 0 at the puff's base, 1 at its top — drives the lit/shaded gradient.
    const lift = new Float32Array(count)

    for (let t = 0; t < thermals.length; t++) {
      const th = thermals[t]
      // Cumulus is wider than the column that feeds it, and taller than it is deep.
      const spread = th.radius * 0.78
      const base = world.air.cloudBase + (rng() - 0.5) * 90
      const bigness = 0.8 + rng() * 0.7

      for (let k = 0; k < PUFFS; k++) {
        const i = t * PUFFS + k
        // First puff is the core; the rest cluster around and above it.
        const core = k === 0
        const a = rng() * Math.PI * 2
        const r = core ? 0 : Math.sqrt(rng()) * spread
        const up = core ? 0 : rng() * spread * 0.55

        offset[i * 3] = th.x + Math.cos(a) * r
        offset[i * 3 + 1] = base + up
        offset[i * 3 + 2] = th.z + Math.sin(a) * r
        scale[i] = (core ? spread * 1.15 : spread * (0.5 + rng() * 0.6)) * bigness
        lift[i] = core ? 0.45 : up / (spread * 0.55)
      }
    }

    const source = new PlaneGeometry(2, 2)
    const geo = new InstancedBufferGeometry()
    geo.index = source.index
    geo.attributes.position = source.attributes.position
    geo.attributes.uv = source.attributes.uv
    geo.setAttribute('aOffset', new InstancedBufferAttribute(offset, 3))
    geo.setAttribute('aScale', new InstancedBufferAttribute(scale, 1))
    geo.setAttribute('aLift', new InstancedBufferAttribute(lift, 1))
    geo.instanceCount = count
    // Billboards have no meaningful bounds; the sky is always potentially on screen.
    geo.boundingSphere = null

    const pal = world.palette
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uLit: { value: new Color(0xffffff).lerp(new Color(rgbToHex(pal.sun)), 0.28) },
        uShade: { value: new Color(rgbToHex(pal.skyHorizon)).lerp(new Color(0xffffff), 0.55) },
        uFog: { value: new Color(rgbToHex(pal.fog)) },
        uSunDir: { value: world.sunDir.clone() as Vector3 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute float aScale;
        attribute float aLift;
        varying vec2 vUv;
        varying float vLift;
        varying float vFog;
        varying float vSun;
        uniform vec3 uSunDir;

        void main() {
          // View-space billboard: place the centre, then offset in screen axes.
          vec4 centre = viewMatrix * vec4(aOffset, 1.0);
          centre.xy += position.xy * aScale;
          gl_Position = projectionMatrix * centre;

          vUv = uv;
          vLift = aLift;

          float dist = length(centre.xyz);
          // Matches the scene's FogExp2 so clouds vanish with everything else.
          float f = dist * ${FOG_DENSITY.toFixed(6)};
          vFog = 1.0 - exp(-f * f);

          // How much this puff faces the sun, for a warm rim on the sunward side.
          vec3 toSun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vSun = clamp(dot(normalize(vec3(position.xy, 0.6)), toSun) * 0.5 + 0.5, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLit;
        uniform vec3 uShade;
        uniform vec3 uFog;
        varying vec2 vUv;
        varying float vLift;
        varying float vFog;
        varying float vSun;

        void main() {
          // Soft round puff. The falloff is wide and gentle so overlapping puffs
          // merge into one mass instead of showing their own outlines.
          float d = length(vUv - 0.5) * 2.0;
          float a = 1.0 - smoothstep(0.15, 1.0, d);
          a *= a;
          if (a < 0.004) discard;

          // Cumulus is lit on top and along the sunward face, shaded underneath.
          float up = clamp(vLift * 0.6 + (1.0 - vUv.y) * -0.4 + vUv.y * 0.7, 0.0, 1.0);
          vec3 col = mix(uShade, uLit, up);
          col = mix(col, uLit, vSun * 0.35);
          col = mix(col, uFog, vFog);

          gl_FragColor = vec4(col, a * 0.9 * (1.0 - vFog));
        }
      `,
    })

    const m = new Mesh(geo, material)
    m.frustumCulled = false
    m.renderOrder = 2
    return m
  }, [world])

  return <primitive object={mesh} />
}
