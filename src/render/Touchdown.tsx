import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshBasicMaterial, Points, RingGeometry, ShaderMaterial } from 'three'
import type { World } from '../sim/world'
import { mulberry32 } from '../sim/rng'
import { flightVisual } from './presentation'
import { TONEMAP_GLSL } from './grade'

const COUNT = 72
export function Touchdown({ world }: { world: World }) {
  const gl = useThree((s) => s.gl), size = useThree((s) => s.size)
  const built = useMemo(() => {
    const positions = new Float32Array(COUNT * 3), velocity = new Float32Array(COUNT * 3)
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3))
    const mat = new ShaderMaterial({ transparent: true, depthWrite: false, uniforms: {
      uImpactAge: { value: 3 },
      uImpactScale: { value: 600 },
      uImpactColor: { value: new Color() },
    }, vertexShader: /* glsl */ `
      uniform float uImpactScale;
      uniform float uImpactAge;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp((0.3 + uImpactAge * 0.6) * uImpactScale / max(-mv.z, 1.0), 1.0, 42.0);
        gl_Position = projectionMatrix * mv;
      }
    `, fragmentShader: /* glsl */ `
      uniform float uImpactAge;
      uniform vec3 uImpactColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float alpha = (1.0 - smoothstep(0.15, 1.0, d)) * (1.0 - smoothstep(0.15, 2.4, uImpactAge)) * 0.38;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(uImpactColor, alpha);
        ${TONEMAP_GLSL}
      }
    ` })
    const points = new Points(geo, mat); points.frustumCulled = false; points.visible = false
    const ring = new Mesh(new RingGeometry(0.92, 1, 72), new MeshBasicMaterial({ color: '#e1f1ee', transparent: true, opacity: 0, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2
    return { points, ring, positions, velocity, age: 3, serial: flightVisual.touchdown }
  }, [world])
  useEffect(() => () => {
    built.points.geometry.dispose(); built.points.material.dispose(); built.ring.geometry.dispose(); built.ring.material.dispose()
  }, [built])
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const v = flightVisual
    if (v.touchdown !== built.serial) {
      built.serial = v.touchdown; built.age = 0
      const rng = mulberry32(world.seed ^ v.touchdown)
      for (let i = 0; i < COUNT; i++) {
        const a = rng() * Math.PI * 2, speed = (v.landed ? 1.4 : 3.2) * (0.4 + rng())
        built.positions.set([v.impactPosition.x + Math.cos(a) * 0.6, v.impactPosition.y + 0.15, v.impactPosition.z + Math.sin(a) * 0.6], i * 3)
        built.velocity.set([Math.cos(a) * speed, (v.impactWater ? 2 : 0.7) + rng() * 1.5, Math.sin(a) * speed], i * 3)
      }
      const tint = v.impactWater ? world.palette.skyHorizon : world.biome === 'valley' ? world.palette.low : world.palette.sand
      built.points.material.uniforms.uImpactColor.value.setRGB(...tint).lerp(new Color(1, 1, 1), v.impactWater ? 0.5 : 0.15)
      built.ring.position.copy(v.impactPosition); built.ring.position.y += 0.08
    }
    built.age += dt
    const visible = v.phase === 'down' && !v.replaying && built.age < 2.4
    built.points.visible = visible
    built.ring.visible = visible && v.impactWater
    if (!visible) return
    const count = COUNT
    built.points.geometry.setDrawRange(0, count)
    for (let i = 0; i < count; i++) {
      const k = i * 3
      built.velocity[k + 1] -= (v.impactWater ? 3 : 0.3) * dt
      built.positions[k] += built.velocity[k] * dt
      built.positions[k + 1] = Math.max(v.impactPosition.y + 0.08, built.positions[k + 1] + built.velocity[k + 1] * dt)
      built.positions[k + 2] += built.velocity[k + 2] * dt
    }
    built.points.geometry.getAttribute('position').needsUpdate = true
    built.points.material.uniforms.uImpactAge.value = built.age
    built.points.material.uniforms.uImpactScale.value = size.height * gl.getPixelRatio() * 0.5
    built.ring.scale.setScalar(1.5 + built.age * 5)
    built.ring.material.opacity = Math.max(0, 0.32 * (1 - built.age / 2.4))
  })
  return <><primitive object={built.points} /><primitive object={built.ring} /></>
}
