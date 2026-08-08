import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'

/**
 * Gradient dome with a soft sun bloom. A shader rather than a texture keeps the
 * "ship no art files" rule and lets the day's palette drive it directly.
 */
export function Sky({ world }: { world: World }) {
  const material = useMemo(() => {
    return new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new Color(rgbToHex(world.palette.skyTop)) },
        uHorizon: { value: new Color(rgbToHex(world.palette.skyHorizon)) },
        uFog: { value: new Color(rgbToHex(world.palette.fog)) },
        uSun: { value: new Color(rgbToHex(world.palette.sun)) },
        uSunDir: { value: world.sunDir.clone() as Vector3 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uFog;
        uniform vec3 uSun;
        uniform vec3 uSunDir;
        varying vec3 vDir;

        void main() {
          vec3 d = normalize(vDir);
          float up = d.y;

          // Above the horizon: horizon colour lifting into the zenith.
          vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.55, up));
          // Settle into the fog colour across the horizon itself. Fogged terrain
          // and fogged water both converge on uFog at the draw distance, so the
          // sky has to arrive at exactly that colour or the map edge shows up as
          // a hard line against it.
          sky = mix(uFog, sky, smoothstep(-0.03, 0.28, up));

          // A low sun should be a warm presence, not a searchlight. With tone
          // mapping off, a wide bloom term clips straight to white and swallows a
          // third of the sky, so both exponents are tight and the gains are small.
          float cosSun = max(dot(d, normalize(uSunDir)), 0.0);
          sky += uSun * pow(cosSun, 3200.0) * 1.1;         // disc
          sky += uSun * pow(cosSun, 20.0) * 0.22;          // tight halo
          sky += uSun * pow(cosSun, 3.0) * 0.07;           // faint wash

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    })
  }, [world])

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[9000, 32, 16]} />
    </mesh>
  )
}
