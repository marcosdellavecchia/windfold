import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, PlaneGeometry, ShaderMaterial, Mesh, Vector3 } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { HALF_WORLD } from '../sim/terrain'
import { FOG_DENSITY } from './atmosphere'

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

    const mat = new ShaderMaterial({
      transparent: true,
      side: DoubleSide,
      uniforms: {
        uDeep: { value: new Color(rgbToHex(pal.water)).multiplyScalar(0.5) },
        uShallow: { value: new Color(rgbToHex(pal.water)).multiplyScalar(1.45) },
        // Weighted toward the zenith, not the horizon. Reflecting the horizon colour
        // is closer to correct for a grazing view, but near a low sun that colour is
        // cream, and the sea came out looking like a desert. Biasing upward keeps
        // water reading as water at every angle the player actually flies at.
        uSky: { value: new Color(rgbToHex(pal.skyHorizon)).lerp(new Color(rgbToHex(pal.skyTop)), 0.55) },
        uSun: { value: new Color(rgbToHex(pal.sun)) },
        uFog: { value: new Color(rgbToHex(pal.fog)) },
        uSunDir: { value: world.sunDir.clone() as Vector3 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying float vFog;
        varying float vDist;
        void main() {
          vec4 world4 = modelMatrix * vec4(position, 1.0);
          vWorld = world4.xyz;
          vec4 mv = viewMatrix * world4;
          vDist = length(mv.xyz);
          float f = vDist * ${FOG_DENSITY.toFixed(6)};
          vFog = 1.0 - exp(-f * f);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uSky;
        uniform vec3 uSun;
        uniform vec3 uFog;
        uniform vec3 uSunDir;
        uniform float uTime;
        varying vec3 vWorld;
        varying float vFog;
        varying float vDist;

        // Cheap crossed-wave surface. Three scales of ripple is enough to read as
        // texture from 200 m up, and it costs no texture fetch.
        float waves(vec2 p, float t) {
          float w = sin(p.x * 0.021 + t * 0.9) * sin(p.y * 0.017 - t * 0.7);
          w += 0.6 * sin(p.x * 0.048 - t * 1.3) * sin(p.y * 0.055 + t * 1.1);
          w += 0.3 * sin((p.x + p.y) * 0.11 + t * 2.1);
          return w / 1.9;
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);

          // Perturb the surface normal by the wave slope.
          float e = 6.0;
          float w0 = waves(vWorld.xz, uTime);
          float wx = waves(vWorld.xz + vec2(e, 0.0), uTime) - w0;
          float wz = waves(vWorld.xz + vec2(0.0, e), uTime) - w0;
          // Flatten the ripple with distance. Per-pixel waves seen almost edge-on
          // alias into corduroy stripes across the whole sea; fading the slope out
          // past a few hundred metres removes them and costs nothing visually,
          // because that detail was never legible at range anyway.
          float ripple = 5.5 * (1.0 - smoothstep(500.0, 2600.0, vDist));
          vec3 n = normalize(vec3(-wx * ripple, 1.0, -wz * ripple));

          // Looking straight down you see into the water; at a grazing angle the
          // surface turns into a mirror of the sky. That flip is most of what sells
          // water seen from an aircraft.
          float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 4.0);

          vec3 body = mix(uDeep, uShallow, 0.35 + w0 * 0.15);
          // Capped well below 1: a physically full mirror at grazing angles turns every
          // lake and sea into the same colour as the sky, and the landscape goes
          // monochrome. Water keeps some of its own body colour at every angle.
          vec3 col = mix(body, uSky, clamp(fres, 0.0, 0.42));

          // Sun glitter: a tight specular on the wave slopes.
          vec3 h = normalize(normalize(uSunDir) + viewDir);
          float spec = pow(max(dot(n, h), 0.0), 220.0);
          col += uSun * spec * 1.6;

          col = mix(col, uFog, vFog);
          gl_FragColor = vec4(col, mix(0.86, 0.97, fres));
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
