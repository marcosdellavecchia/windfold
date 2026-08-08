import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BackSide, Color, ShaderMaterial, Vector2, Vector3 } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'

/**
 * Gradient dome with a soft sun bloom. A shader rather than a texture keeps the
 * "ship no art files" rule and lets the day's palette drive it directly.
 *
 * Everything above the plain gradient is here because the sky is two-thirds of the
 * frame on a glider and a two-stop ramp is not enough to look at for ten minutes:
 * cirrus drawn out along the day's wind, the counter-glow band opposite the sun, a
 * moon, crepuscular rays, and a sun disc that is flattened by refraction and
 * shimmers slightly. None of it is correct physics. All of it is the kind of detail
 * you half-notice, which is what makes a place feel remembered rather than drawn.
 */
export function Sky({ world }: { world: World }) {
  const material = useMemo(() => {
    const pal = world.palette
    return new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new Color(rgbToHex(pal.skyTop)) },
        uHorizon: { value: new Color(rgbToHex(pal.skyHorizon)) },
        uFog: { value: new Color(rgbToHex(pal.fog)) },
        uSun: { value: new Color(rgbToHex(pal.sun)) },
        uGlow: { value: new Color(rgbToHex(pal.glow)) },
        uCirrus: { value: new Color(rgbToHex(pal.cirrus)) },
        uSunDir: { value: world.sunDir.clone() as Vector3 },
        uMoonDir: { value: world.moonDir.clone() as Vector3 },
        uMoonPhase: { value: world.moonPhase },
        uWind: { value: new Vector2(world.air.windX, world.air.windZ) },
        // Decorrelates the ray pattern between days so two skies with the same
        // sun angle are still not the same sky.
        uSeed: { value: ((world.seed >>> 7) % 1024) / 163.0 },
        uTime: { value: 0 },
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
        uniform vec3 uGlow;
        uniform vec3 uCirrus;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform float uMoonPhase;
        uniform vec2 uWind;
        uniform float uSeed;
        uniform float uTime;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm(vec2 p) {
          float s = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            s += vnoise(p) * a;
            p *= 2.03;
            a *= 0.5;
          }
          return s;
        }

        /**
         * Screen-space basis around a direction, so a disc in the sky can be
         * measured — and distorted — in two axes instead of one dot product.
         */
        void basis(vec3 dir, out vec3 right, out vec3 up) {
          right = normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
          up = cross(right, dir);
        }

        void main() {
          vec3 d = normalize(vDir);
          float up = d.y;
          vec3 sd = normalize(uSunDir);

          // Above the horizon: horizon colour lifting into the zenith.
          vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.55, up));
          // Settle into the fog colour across the horizon itself. Fogged terrain
          // and fogged water both converge on uFog at the draw distance, so the
          // sky has to arrive at exactly that colour or the map edge shows up as
          // a hard line against it.
          sky = mix(uFog, sky, smoothstep(-0.03, 0.28, up));

          // --- counter-glow -------------------------------------------------
          // The pink band low in the sky opposite the sun, sitting on the blue-grey
          // of the earth's own shadow. Real, and it turns the half of the sky the
          // player spends a downwind leg staring at into something worth looking at.
          vec2 dh = vec2(d.x, d.z);
          float dhl = length(dh);
          vec2 dhn = dhl > 1e-4 ? dh / dhl : vec2(1.0, 0.0);
          vec2 sunH = normalize(vec2(sd.x, sd.z) + vec2(1e-5));
          float anti = clamp(-dot(dhn, sunH), 0.0, 1.0);
          float band = smoothstep(0.0, 0.09, up) * (1.0 - smoothstep(0.05, 0.34, up));
          sky += uGlow * band * (0.06 + 0.30 * pow(anti, 1.6));

          // --- cirrus -------------------------------------------------------
          // A sheet at a notional altitude, so the streaks converge toward the
          // horizon the way a real overcast does instead of tiling flat overhead.
          // Squashed hard across the wind, which is the whole visual signature of
          // high cloud: drawn out into fibres by the jet it sits in.
          float cy = max(up, 0.05);
          vec2 wdir = normalize(uWind + vec2(1e-3, 0.0));
          mat2 align = mat2(wdir.x, -wdir.y, wdir.y, wdir.x);
          vec2 cp = align * (d.xz / cy) * 0.06 + wdir * uTime * 0.004;
          vec2 q = cp * vec2(0.28, 1.0);
          float c = fbm(q * 1.6 + fbm(q * 0.7 + uSeed) * 1.1);
          c = smoothstep(0.5, 0.86, c);
          // Hug the middle of the dome: none in the haze at the horizon, thinning
          // out at the zenith where a fibrous sheet would read as a stain.
          c *= smoothstep(0.03, 0.22, up) * (1.0 - smoothstep(0.6, 1.0, up));
          float sunNear = pow(max(dot(d, sd), 0.0), 6.0);
          sky = mix(sky, mix(uCirrus, uSun, 0.2 + 0.6 * sunNear), c * 0.5);

          // --- moon ---------------------------------------------------------
          vec3 mr, mu;
          vec3 md = normalize(uMoonDir);
          basis(md, mr, mu);
          vec2 mo = vec2(dot(d, mr), dot(d, mu));
          float mFront = step(0.0, dot(d, md));
          float mr2 = length(mo);
          float moon = (1.0 - smoothstep(0.016, 0.021, mr2)) * mFront;
          // Phase is a second disc subtracted off the first, offset sideways. Crude,
          // and indistinguishable from the real thing at this size.
          float dark = 1.0 - smoothstep(0.013, 0.020, length(mo - vec2(uMoonPhase * 0.026, 0.0)));
          moon *= 1.0 - dark * 0.9;
          vec3 moonCol = mix(vec3(1.0), uGlow, 0.3);
          sky = mix(sky, moonCol, moon * 0.7);
          sky += moonCol * exp(-mr2 * 42.0) * 0.04 * mFront;

          // --- sun ----------------------------------------------------------
          vec3 sr, su;
          basis(sd, sr, su);
          vec2 off = vec2(dot(d, sr), dot(d, su));
          float sFront = step(0.0, dot(d, sd));
          // Refraction flattens a low sun into an oval. Exaggerated past what the
          // atmosphere actually does, because a slightly wrong sun is the detail
          // that tells you where you are is not quite real.
          float squash = 1.0 + 1.8 * (1.0 - sd.y);
          vec2 so = vec2(off.x, off.y * squash);
          // And it never sits still — heat haze, breathing slowly.
          so *= 1.0 + 0.05 * sin(uTime * 0.7 + so.y * 90.0 + uSeed);
          float r = length(so);

          float disc = (1.0 - smoothstep(0.013, 0.023, r)) * sFront;
          // The mirage notch a low sun gets cut by over a horizon.
          float notch = 1.0 - smoothstep(0.0, 0.004, abs(so.y + 0.007));
          disc *= 1.0 - 0.4 * notch * (1.0 - sd.y);
          sky += uSun * disc * 1.2;

          // Halo. With tone mapping off a wide bloom clips straight to white and
          // swallows a third of the sky, so both falloffs are tight.
          sky += uSun * exp(-r * 26.0) * 0.20 * sFront;
          sky += uSun * exp(-r * 4.5) * 0.07 * sFront;

          // --- crepuscular rays ---------------------------------------------
          // Layered odd harmonics so the spokes are irregular rather than a gear.
          float ang = atan(off.y, off.x);
          float rays = 0.5 + 0.5 * sin(ang * 7.0 + uSeed * 3.1)
                     + 0.35 * sin(ang * 13.0 - uSeed * 1.7 + uTime * 0.05)
                     + 0.22 * sin(ang * 23.0 + uSeed * 0.9);
          rays = smoothstep(0.55, 1.25, rays);
          sky += uSun * rays * exp(-r * 2.4) * 0.055 * sFront * smoothstep(-0.02, 0.16, up);

          // A quarter-LSB of noise. Every gradient in here is a wide, shallow ramp
          // across a whole screen, which is exactly what banding shows up on.
          sky += (hash21(gl_FragCoord.xy) - 0.5) * 0.004;

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    })
  }, [world])

  const clock = useRef(0)
  useFrame((_, dt) => {
    clock.current += Math.min(dt, 0.1)
    material.uniforms.uTime.value = clock.current
  })

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[9000, 32, 16]} />
    </mesh>
  )
}
