import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'
import { surfaceHeight } from '../sim/terrain'
import { TONEMAP_GLSL } from './grade'

/**
 * The camera admitting it is a camera.
 *
 * Everything else in the frame pretends to be a window; this is the one effect
 * that says "lens" — the row of ghost discs marching through the frame centre
 * when you fly toward the sun, the veil of glare, the streak. It is a cliché
 * because it works: the flare is what makes turning sunward *cost* something
 * visually, the way it does in a real cockpit, and it moves with the camera in
 * a way nothing painted on the sky dome can.
 *
 * One fullscreen triangle, additive, drawn after everything. All the geometry
 * of the effect is classic and cheap: every ghost sits on the line from the
 * sun's screen position through the frame centre, because that is literally
 * where inter-element reflections land in a real lens.
 *
 * The whole thing lives or dies by its fades, so intensity is eased, never
 * stepped: it rises as the sun comes toward frame centre, dies toward the
 * edges, and goes out when a ridge stands in front of the sun — checked by
 * marching the heightfield toward the sun, which the CPU can afford because
 * the sun is always at least nine degrees up and the ray outclimbs the terrain
 * inside a few kilometres.
 */

/** How far toward frame centre the flare reaches full strength. */
const FACING_ON = 0.45
const FACING_OFF = 0.2

export function LensFlare({ world }: { world: World }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const meshRef = useRef<Mesh>(null)

  const { mesh, uniforms } = useMemo(() => {
    const pal = world.palette
    const uniforms = {
      uSun: { value: new Vector2(0, 0) },
      uAspect: { value: 1.78 },
      uIntensity: { value: 0 },
      // The day's sun, lifted toward white the way an overexposed source is.
      uTint: { value: new Color(rgbToHex(pal.sun)).lerp(new Color(0xffffff), 0.25) },
    }
    const geo = new BufferGeometry()
    // One triangle covering NDC; positions are used raw in the vertex stage.
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    const mat = new ShaderMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec2 uSun;
        uniform float uAspect;
        uniform float uIntensity;
        uniform vec3 uTint;
        varying vec2 vNdc;

        /** Soft-edged disc in aspect-corrected screen units. */
        float fdisc(vec2 q, vec2 c, float r) {
          return smoothstep(r, r * 0.3, length(q - c));
        }

        void main() {
          // Aspect-corrected coordinates, so the ghosts are circles rather
          // than the ellipses raw NDC would draw on a wide screen.
          vec2 q = vec2(vNdc.x * uAspect, vNdc.y);
          vec2 s = vec2(uSun.x * uAspect, uSun.y);
          // The reflection axis: sun through frame centre and out the far side.
          vec2 v = -s;

          vec3 col = vec3(0.0);

          // Veiling glare: the broad wash that lifts the whole sunward part of
          // the frame, plus a hot centre right on the source.
          float dSun = length(q - s);
          col += uTint * exp(-dSun * 2.6) * 0.14;
          col += vec3(1.0) * exp(-dSun * 12.0) * 0.2;

          // The streak — horizontal, faint, the one anamorphic touch.
          col += uTint * exp(-abs(q.y - s.y) * 34.0) * exp(-abs(q.x - s.x) * 2.4) * 0.1;

          // Ghosts down the axis. Alternating warm and cool, because real
          // coatings hand every other reflection a complementary cast; sizes
          // and spacings irregular, because a regular row reads as beads.
          vec3 coolTint = mix(uTint, vec3(0.45, 0.75, 1.0), 0.65);
          col += uTint * fdisc(q, s + v * 0.45, 0.035) * 0.06;
          col += coolTint * fdisc(q, s + v * 0.72, 0.02) * 0.08;
          col += uTint * fdisc(q, s + v * 1.05, 0.055) * 0.045;
          col += coolTint * fdisc(q, s + v * 1.35, 0.03) * 0.07;
          col += uTint * fdisc(q, s + v * 1.85, 0.085) * 0.035;

          // The wide halo ghost past centre, with a whisper of dispersion —
          // each channel a slightly different radius, which is what smears a
          // real ring into a rainbow.
          vec2 hc = s + v * 1.55;
          float hd = length(q - hc);
          col.r += exp(-pow((hd - 0.205) * 26.0, 2.0)) * 0.032;
          col.g += exp(-pow((hd - 0.22) * 26.0, 2.0)) * 0.032;
          col.b += exp(-pow((hd - 0.238) * 26.0, 2.0)) * 0.036;

          col *= uIntensity;
          gl_FragColor = vec4(col, 1.0);
          ${TONEMAP_GLSL}
        }
      `,
    })
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 30
    mesh.visible = false
    return { mesh, uniforms }
  }, [world])

  useEffect(
    () => () => {
      mesh.geometry.dispose()
      ;(mesh.material as ShaderMaterial).dispose()
    },
    [mesh],
  )

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    let target = 0

    camera.getWorldDirection(FWD)
    const facing = FWD.dot(world.sunDir)
    if (facing > FACING_OFF) {
      // Where the sun lands on screen. A point far along the sun direction —
      // the direction itself has no position for project() to use.
      P.copy(world.sunDir).multiplyScalar(5000).add(camera.position).project(camera)
      uniforms.uSun.value.set(P.x, P.y)

      const face = Math.min((facing - FACING_OFF) / (FACING_ON - FACING_OFF), 1)
      // Let it live a little past the frame edge, so a sun sliding out of
      // shot takes its flare with it instead of having it snapped away.
      const edge = Math.max(Math.abs(P.x), Math.abs(P.y))
      const inFrame = 1 - Math.min(Math.max((edge - 0.9) / 0.5, 0), 1)
      target = face * inFrame * (occluded(camera.position, world) ? 0 : 1)
    }

    // Eased, both ways — the rise as you turn into sun and the die-off behind
    // a ridge are the whole feel of the thing. A pop in either direction
    // reads as a bug.
    const k = 1 - Math.exp(-7 * dt)
    uniforms.uIntensity.value += (target - uniforms.uIntensity.value) * k
    uniforms.uAspect.value = size.width / Math.max(size.height, 1)
    mesh.visible = uniforms.uIntensity.value > 0.004
  })

  return <primitive ref={meshRef} object={mesh} />
}

const FWD = new Vector3()
const P = new Vector3()

/**
 * Is the terrain standing between the camera and the sun?
 *
 * A march along the sun ray, against the same surface the physics uses (water
 * counts — a sun behind the sea horizon is a sun you cannot see). The sun's
 * minimum elevation is ~9 degrees, so the ray climbs at least 0.16 m per
 * metre and clears the tallest possible terrain within a few kilometres —
 * the early-out above hf.max keeps the loop short in practice.
 */
function occluded(cam: Vector3, world: World): boolean {
  const hf = world.heightfield
  const s = world.sunDir
  for (let i = 1; i <= 24; i++) {
    const t = i * 240
    const y = cam.y + s.y * t
    if (y > hf.max + 5) return false
    if (surfaceHeight(hf, cam.x + s.x * t, cam.z + s.z * t) > y) return true
  }
  return false
}
