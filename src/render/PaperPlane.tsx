import { forwardRef, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, DoubleSide, Group } from 'three'
import type { World } from '../sim/world'
import { rgbToHex } from '../sim/palette'

/**
 * A folded dart, built from five points. Procedural like everything else — the
 * "ship no 3D model files" rule applies to the plane too.
 */
export const PaperPlane = forwardRef<Group, { world: World }>(function PaperPlane({ world }, ref) {
  const geometry = useMemo(() => buildDart(), [])
  const tint = rgbToHex(world.palette.high)

  return (
    <group ref={ref}>
      <mesh geometry={geometry}>
        <meshLambertMaterial
          color={0xfffdf6}
          emissive={tint}
          emissiveIntensity={0.3}
          side={DoubleSide}
          flatShading
        />
      </mesh>
    </group>
  )
})

function buildDart(): BufferGeometry {
  // Nose at -Z, tail at +Z. Wingspan ~3.2 m.
  const nose = [0, 0, -2.4]
  const spine = [0, 0.22, 1.4]
  const tipL = [-1.6, 0.1, 1.8]
  const tipR = [1.6, 0.1, 1.8]
  const keel = [0, -0.55, 1.5]

  const tris = [
    nose, tipL, spine, // left wing, normal up
    nose, spine, tipR, // right wing
    nose, keel, spine, // vertical fin under the fold
  ]

  const positions = new Float32Array(tris.length * 3)
  for (let i = 0; i < tris.length; i++) {
    positions[i * 3] = tris[i][0]
    positions[i * 3 + 1] = tris[i][1]
    positions[i * 3 + 2] = tris[i][2]
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.computeVertexNormals()
  return geo
}
