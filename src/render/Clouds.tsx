import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
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
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS } from './atmosphere'

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
    // Decorrelates each puff's drift, so a cumulus churns instead of sliding.
    const phase = new Float32Array(count)

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
        phase[i] = rng() * Math.PI * 2
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
    geo.setAttribute('aPhase', new InstancedBufferAttribute(phase, 1))
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
        uSunDir: { value: world.sunDir.clone() as Vector3 },
        uTime: { value: 0 },
        ...AIR_FOG_UNIFORMS,
      },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute float aScale;
        attribute float aLift;
        attribute float aPhase;
        varying vec2 vUv;
        varying float vLift;
        varying vec3 vAirWorld;
        varying float vSun;
        uniform vec3 uSunDir;
        uniform float uTime;

        void main() {
          // Puffs wander a few metres and breathe a few percent, out of phase with
          // each other. A cumulus is a convecting thing and a frozen one looks like
          // a decal; the amplitudes are small enough that nobody sees it move and
          // large enough that the sky is never twice the same.
          vec3 wob = vec3(
            sin(uTime * 0.11 + aPhase) * 7.0,
            sin(uTime * 0.07 + aPhase * 1.7) * 3.5,
            cos(uTime * 0.09 + aPhase * 0.8) * 7.0
          );
          float breathe = aScale * (1.0 + 0.06 * sin(uTime * 0.13 + aPhase));

          // View-space billboard: place the centre, then offset in screen axes.
          vec4 centre = viewMatrix * vec4(aOffset + wob, 1.0);
          centre.xy += position.xy * breathe;
          gl_Position = projectionMatrix * centre;

          vUv = uv;
          vLift = aLift;
          // The puff's centre stands in for every fragment of it: a cloud is a
          // few hundred metres across against kilometres of haze.
          vAirWorld = aOffset + wob;

          // How much this puff faces the sun, for a warm rim on the sunward side.
          vec3 toSun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vSun = clamp(dot(normalize(vec3(position.xy, 0.6)), toSun) * 0.5 + 0.5, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLit;
        uniform vec3 uShade;
        varying vec2 vUv;
        varying float vLift;
        varying vec3 vAirWorld;
        varying float vSun;

        ${AIR_FOG_GLSL}

        float cdHash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          // Soft round puff. The falloff is wide and gentle so overlapping puffs
          // merge into one mass instead of showing their own outlines.
          float d = length(vUv - 0.5) * 2.0;
          float a = 1.0 - smoothstep(0.15, 1.0, d);
          a *= a;
          if (a < 0.004) discard;

          // The shared directional haze, so a cloud sinks into the same warm air
          // the ridge beneath it does — sunward cumulus dissolve into the glow.
          vec3 airRay = vAirWorld - cameraPosition;
          float airDist = length(airRay);
          float fogA = airFogAmount(airDist, vAirWorld.y);

          // Cumulus is lit on top and along the sunward face, shaded underneath.
          float up = clamp(vLift * 0.6 + (1.0 - vUv.y) * -0.4 + vUv.y * 0.7, 0.0, 1.0);
          vec3 col = mix(uShade, uLit, up);
          col = mix(col, uLit, vSun * 0.35);
          col = mix(col, airFogColor(airRay / max(airDist, 1e-4)), fogA);
          // A puff is one wide shallow radial ramp — the exact shape banding
          // loves. Same quarter-LSB the sky carries.
          col += (cdHash(gl_FragCoord.xy) - 0.5) * 0.004;

          gl_FragColor = vec4(col, a * 0.9 * (1.0 - fogA));
        }
      `,
    })

    const m = new Mesh(geo, material)
    m.frustumCulled = false
    m.renderOrder = 2
    return m
  }, [world])

  const clock = useRef(0)
  useFrame((_, dt) => {
    clock.current += Math.min(dt, 0.1)
    ;(mesh.material as ShaderMaterial).uniforms.uTime.value = clock.current
  })

  return <primitive object={mesh} />
}
