import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three'
import type { World } from '../sim/world'
import { mulberry32 } from '../sim/rng'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS } from './atmosphere'
import { TONEMAP_GLSL } from './grade'

/** Spray originates from the rendered cascade ribbon, not a second river map. */
export function CascadeMist({ geometry, world }: { geometry: BufferGeometry; world: World }) {
  const gl = useThree((s) => s.gl), size = useThree((s) => s.size)
  const points = useMemo(() => {
    const positions: number[] = [], phases: number[] = []
    const pos = geometry.getAttribute('position'), foam = geometry.getAttribute('aFoam')
    const sites = new Set<string>(), rng = mulberry32(world.seed ^ 0xfaa11)
    for (let i = 0; i < pos.count - 3 && sites.size < 80; i += 4) {
      if (foam.getX(i + 2) < 0.75) continue
      const x = (pos.getX(i + 2) + pos.getX(i + 3)) * 0.5
      const y = (pos.getY(i + 2) + pos.getY(i + 3)) * 0.5
      const z = (pos.getZ(i + 2) + pos.getZ(i + 3)) * 0.5
      const key = `${Math.floor(x / 80)},${Math.floor(z / 80)}`
      if (sites.has(key)) continue
      sites.add(key)
      for (let k = 0; k < 6; k++) { positions.push(x, y + 0.6, z); phases.push(rng()) }
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geo.setAttribute('aPhase', new BufferAttribute(new Float32Array(phases), 1))
    const mat = new ShaderMaterial({ transparent: true, depthWrite: false, uniforms: {
      uSprayTime: { value: 0 },
      uSprayScale: { value: 600 },
      uSprayColor: { value: new Color().setRGB(...world.palette.skyHorizon).lerp(new Color(1, 1, 1), 0.7) },
      ...AIR_FOG_UNIFORMS,
    }, vertexShader: /* glsl */ `
      uniform float uSprayTime;
      uniform float uSprayScale;
      attribute float aPhase;
      varying float vSprayAlpha;
      varying vec3 vSprayWorld;
      void main() {
        float life = fract(aPhase + uSprayTime * 0.16);
        vec3 p = position + vec3(sin(aPhase * 73.0) * life * 9.0, life * 13.0, cos(aPhase * 53.0) * life * 9.0);
        vSprayWorld = (modelMatrix * vec4(p, 1.0)).xyz;
        vec4 mv = viewMatrix * vec4(vSprayWorld, 1.0);
        vSprayAlpha = sin(life * 3.14159) * (1.0 - smoothstep(450.0, 1200.0, length(mv.xyz)));
        gl_PointSize = clamp((4.0 + life * 9.0) * uSprayScale / max(-mv.z, 1.0), 1.0, 64.0);
        gl_Position = projectionMatrix * mv;
      }
    `, fragmentShader: /* glsl */ `
      uniform vec3 uSprayColor;
      varying float vSprayAlpha;
      varying vec3 vSprayWorld;
      ${AIR_FOG_GLSL}
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float alpha = (1.0 - smoothstep(0.0, 1.0, d)) * vSprayAlpha * 0.14;
        if (alpha < 0.003) discard;
        vec3 ray = vSprayWorld - cameraPosition;
        float fog = airFogAmount(length(ray), vSprayWorld.y);
        gl_FragColor = vec4(mix(uSprayColor, airFogColor(normalize(ray)), fog), alpha * (1.0 - fog));
        ${TONEMAP_GLSL}
      }
    ` })
    const p = new Points(geo, mat); p.frustumCulled = false; return p
  }, [geometry, world])
  useEffect(() => () => { points.geometry.dispose(); points.material.dispose() }, [points])
  useFrame((_, dt) => {
    points.material.uniforms.uSprayTime.value += Math.min(dt, 0.1)
    points.material.uniforms.uSprayScale.value = size.height * gl.getPixelRatio() * 0.5
  })
  return <primitive object={points} />
}
