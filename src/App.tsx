import { useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { buildWorld, dayNumber } from './sim/world'
import { Scene } from './render/Scene'
import { Hud } from './ui/Hud'
import { TuningPanel } from './ui/TuningPanel'
import { attachInput } from './input'
import { TUNING } from './sim/tuning'
import { useMusic } from './audio/useMusic'
import { AudioToggle } from './ui/AudioToggle'

export default function App() {
  // ?day=N forces a specific day. Only a dev affordance — there is nothing to gain
  // from it, since every player gets the same world either way.
  const [day, setDay] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('day')
    const n = q === null ? NaN : Number(q)
    return Number.isFinite(n) ? Math.trunc(n) : dayNumber()
  })
  const world = useMemo(() => buildWorld(day), [day])

  const music = useMusic(world.seed)

  useEffect(() => attachInput(), [])

  return (
    <>
      <Canvas
        flat
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: TUNING.fov, near: 0.5, far: 20000, position: [0, 400, 0] }}
      >
        <Scene world={world} />
      </Canvas>
      <Hud world={world} />
      <AudioToggle muted={music.muted} onToggle={music.toggle} />
      <TuningPanel day={day} onDay={setDay} />
    </>
  )
}
