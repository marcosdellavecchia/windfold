import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BackSide, Color, ShaderMaterial, Vector2, Vector3 } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS } from './atmosphere'

/**
 * Gradient dome with a soft sun bloom. A shader rather than a texture keeps the
 * "ship no art files" rule and lets the day's palette drive it directly.
 *
 * Everything above the plain gradient is here because the sky is two-thirds of the
 * frame on a glider and a two-stop ramp is not enough to look at for ten minutes:
 * cirrus drawn out along the day's wind, the counter-glow band opposite the sun, a
 * moon with maria and earthshine, crepuscular rays, an ice-halo ring, stars that
 * hang in the daylight, a falling star every minute or so, and a sun disc that is
 * flattened by refraction and shimmers slightly. None of it is correct physics.
 * All of it is the kind of detail you half-notice, which is what makes a place
 * feel remembered rather than drawn.
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
        uSun: { value: new Color(rgbToHex(pal.sun)) },
        ...AIR_FOG_UNIFORMS,
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

        ${AIR_FOG_GLSL}

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
          // and fogged water both converge on the shared haze at the draw
          // distance, so the sky has to arrive at exactly that colour or the map
          // edge shows up as a hard line against it. Directional now — the same
          // airFogColor everything on the ground converges to, warm around the
          // sun's azimuth and cool opposite — which is what makes the whole
          // horizon read as one atmosphere rather than one ring of one colour.
          sky = mix(airFogColor(d), sky, smoothstep(-0.03, 0.28, up));

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

          // --- stars, in daylight ---------------------------------------------
          // Wrong the way the daytime moon is wrong, and there on purpose: a few
          // stars hang in the deep blue of the upper dome, where the day is
          // darkest. They keep clear of the sun, dim under the cirrus, and each
          // one breathes on its own period. Some days the sky holds more of them
          // than others; that is the seed's business.
          vec2 pp = d.xz / (d.y + 0.55);
          vec2 sp = pp * 13.0;
          vec2 scell = floor(sp);
          vec2 sfrac = fract(sp);
          float sh = hash21(scell + floor(uSeed * 91.0));
          vec2 spos = vec2(hash21(scell + 7.1), hash21(scell + 3.7)) * 0.8 + 0.1;
          float sdist = length(sfrac - spos);
          float density = 0.72 + 0.28 * fract(uSeed * 13.7);
          float gate = step(1.0 - 0.16 * density, sh);
          float tw = 0.55 + 0.45 * sin(uTime * (0.6 + sh * 2.2) + sh * 41.0);
          float star = gate * exp(-sdist * sdist * 240.0) * tw * (0.4 + sh * 0.8);
          float starZone = smoothstep(0.30, 0.62, up);
          starZone *= 1.0 - smoothstep(0.35, 0.75, max(dot(d, sd), 0.0));
          starZone *= 1.0 - c * 0.85;
          sky += mix(vec3(1.0), uCirrus, 0.35) * star * 0.55 * starZone;

          // --- a falling star --------------------------------------------------
          // Every so often one comes down across the high sky, gone in a second.
          // Each cycle draws its own start point and heading; many fall outside
          // the dome entirely, which is what makes catching one feel like luck
          // rather than a scheduled effect.
          float mper = 41.0;
          float mcyc = floor(uTime / mper);
          float mt = uTime - mcyc * mper;
          float mlife = 1.1;
          float mprog = clamp(mt / mlife, 0.0, 1.0);
          vec2 m0 = vec2(hash21(vec2(mcyc, uSeed)), hash21(vec2(uSeed, mcyc))) * 3.0 - 1.5;
          float mang = hash21(vec2(mcyc + 3.3, uSeed)) * 6.283;
          vec2 mdir2 = vec2(cos(mang), sin(mang));
          vec2 mhead = m0 + mdir2 * mprog * 1.4;
          vec2 mtail = -mdir2 * 0.30;
          vec2 mw = pp - mhead;
          float mproj = clamp(dot(mw, mtail) / dot(mtail, mtail), 0.0, 1.0);
          float mdist = length(mw - mtail * mproj);
          float alive = step(mt, mlife) * (1.0 - mprog);
          float streak = exp(-mdist * mdist * 2600.0) * (1.0 - mproj * 0.85) * alive;
          streak += exp(-dot(mw, mw) * 800.0) * alive * 0.7;
          sky += mix(vec3(1.0), uSun, 0.25) * streak * 0.5 * smoothstep(0.25, 0.5, up);

          // --- moon ---------------------------------------------------------
          vec3 mr, mu;
          vec3 md = normalize(uMoonDir);
          basis(md, mr, mu);
          vec2 mo = vec2(dot(d, mr), dot(d, mu));
          float mFront = step(0.0, dot(d, md));
          float mr2 = length(mo);
          float MOON_R = 0.017;
          float moon = (1.0 - smoothstep(MOON_R * 0.93, MOON_R, mr2)) * mFront;
          // The phase used to be a second disc subtracted off the first, offset
          // horizontally — which put a circular bite in the limb with a
          // terminator that never pointed anywhere. A moon is a sphere: build
          // the surface normal at each pixel and light it, with the light
          // tipped around the disc by the day's phase and *aimed at the actual
          // sun* — the lit limb of a real moon always faces the sun in the sky,
          // and the eye knows it even when it has never been told.
          float nz = sqrt(max(1.0 - (mr2 * mr2) / (MOON_R * MOON_R), 0.0));
          vec3 mnrm = vec3(mo / MOON_R, nz);
          vec2 sunProj = normalize(vec2(dot(sd, mr), dot(sd, mu)) + vec2(1e-5));
          // 0 is full; the sign says which limb carries the light. 2.4 rad at
          // the extreme is a deep crescent without ever going fully new — a
          // new moon is an invisible moon, which is a wasted draw.
          float phi = uMoonPhase * 2.4;
          vec3 mlight = normalize(vec3(sunProj * sin(phi), cos(phi)));
          float mdot = dot(mnrm, mlight);
          // Terminator softness: real lunar shadow has a soft edge at this
          // scale from the terrain along it.
          float litMask = smoothstep(-0.03, 0.14, mdot);
          // Maria: the same value noise as everything else, twice, which is all a
          // disc a degree wide can carry — but a blank moon reads as a hole punch
          // and a mottled one reads as the moon.
          float mare = vnoise(mo * 260.0 + uSeed * 9.0) * 0.6 + vnoise(mo * 560.0 - uSeed * 4.0) * 0.4;
          vec3 moonCol = mix(vec3(1.0), uGlow, 0.3) * (1.0 - mare * 0.22);
          // Limb darkening, so the disc has a far side.
          moonCol *= 1.0 - smoothstep(MOON_R * 0.65, MOON_R, mr2) * 0.28;
          // Flattened lambert: regolith is retroreflective, so the fall toward
          // the terminator is late and steep rather than a smooth gradient.
          float mshade = 0.62 + 0.38 * pow(clamp(mdot, 0.0, 1.0), 0.45);
          sky = mix(sky, moonCol * mshade, moon * litMask * 0.8);
          // Earthshine: the dark side is never black, it is the ghost of the disc
          // lit by somewhere else entirely. Cool, because the shadow of a world
          // should not be warm.
          sky = mix(sky, mix(uTop, vec3(1.0), 0.3), moon * (1.0 - litMask) * 0.13);
          // The glow scales with how much of the disc is actually lit — a
          // crescent does not flood the sky the way a full moon does.
          float litFrac = cos(phi) * 0.5 + 0.5;
          sky += moonCol * exp(-mr2 * 46.0) * 0.05 * mFront * (0.25 + 0.75 * litFrac);
          // Lunar corona: one tight iridescent ring hugging the disc, faint.
          float mringT = (mr2 - 0.031) * 95.0;
          sky += mix(uGlow, uCirrus, 0.55) * exp(-mringT * mringT) * 0.032 * mFront * (0.25 + 0.75 * litFrac);

          // --- sun ----------------------------------------------------------
          vec3 sr, su;
          basis(sd, sr, su);
          vec2 off = vec2(dot(d, sr), dot(d, su));
          float sFront = step(0.0, dot(d, sd));
          // Refraction flattens a low sun into an oval — kept at roughly what
          // the atmosphere actually does. The old exaggeration (and the mirage
          // notch that went with it) made the disc a *shape*, and a sun you can
          // see the shape of is a sticker; a real one is a hole burned in the
          // frame that the eye cannot hold.
          float squash = 1.0 + 0.3 * (1.0 - sd.y);
          vec2 so = vec2(off.x, off.y * squash);
          // Heat shimmer, barely: enough that it is not frozen, never enough
          // to wobble visibly.
          so *= 1.0 + 0.018 * sin(uTime * 0.7 + so.y * 90.0 + uSeed);
          float r = length(so);

          // Overexposed: a camera pointed at the sun clips, so the core is
          // white by definition — the day's colour lives in the glare around
          // it, not in the disc. Three falloff scales stand in for the bloom a
          // real lens would produce; the widest is faint enough not to swallow
          // the sky, which with tone mapping off it happily would.
          float disc = (1.0 - smoothstep(0.009, 0.015, r)) * sFront;
          sky += mix(vec3(1.0), uSun, 0.1) * disc * 1.6;
          sky += mix(uSun, vec3(1.0), 0.45) * exp(-r * 55.0) * 0.55 * sFront;
          sky += uSun * exp(-r * 18.0) * 0.22 * sFront;
          sky += uSun * exp(-r * 4.5) * 0.07 * sFront;

          // The ice halo: the 22-degree ring, shrunk to fit the frame and tinted
          // the way the real one is — warm on the inner edge, cold outside. It
          // breathes a little, because nothing in this sky is allowed to be a
          // fixed diagram. The one openly lysergic thing here, kept faint enough
          // to be half-noticed rather than seen.
          float theta = acos(clamp(dot(d, sd), -1.0, 1.0));
          float ringR = 0.155 + 0.006 * sin(uTime * 0.21 + uSeed);
          float ringT = (theta - ringR) / 0.045;
          float ring = exp(-ringT * ringT * 2.0);
          vec3 ringCol = mix(uSun, mix(uTop, uCirrus, 0.5), clamp(ringT * 0.55 + 0.5, 0.0, 1.0));
          sky += ringCol * ring * 0.085 * smoothstep(-0.02, 0.14, up);

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
