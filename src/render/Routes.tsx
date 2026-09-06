import { useMemo } from 'react'
import { Quaternion, Vector3 } from 'three'
import type { World } from '../sim/world'
import type { ScenicRoute } from '../game/routes'
import { useHud } from '../state'
import { surfaceHeight } from '../sim/terrain'

export function Routes({ route, world }: { route: ScenicRoute; world: World }) {
  const s = useHud()
  const rotations = useMemo(() => route.gates.map((g) => new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), g.normal)), [route])
  const landingRing = useMemo(() => {
    if (!route.landing) return null
    const pts: number[] = []
    for (let i = 0; i <= 96; i++) {
      const a = i / 96 * Math.PI * 2
      const x = route.landing.x + Math.cos(a) * 65, z = route.landing.z + Math.sin(a) * 65
      pts.push(x, surfaceHeight(world.heightfield, x, z) + 0.8, z)
    }
    return new Float32Array(pts)
  }, [route, world])
  if (s.replaying || s.cheated) return null
  return <group>
    {route.gates.map((g, i) => i >= s.routeGates && <mesh key={i} position={g.position} quaternion={rotations[i]}>
      <torusGeometry args={[g.radius, i === s.routeGates ? 0.65 : 0.35, 6, 72]} />
      <meshBasicMaterial color={i === s.routeGates ? '#ffe3a2' : '#c7e2e8'} transparent opacity={i === s.routeGates ? 0.82 : 0.24} depthWrite={false} />
    </mesh>)}
    {landingRing && s.routeGates === route.gates.length && <lineLoop>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[landingRing, 3]} /></bufferGeometry>
      <lineBasicMaterial color="#ffe3a2" transparent opacity={0.85} depthWrite={false} />
    </lineLoop>}
  </group>
}
