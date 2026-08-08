import { useCallback, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { buildWorld, dayNumber } from './sim/world'
import { computePar } from './sim/par'
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
  // The paper pilot flies the day once, headlessly, and its distance is par.
  // ~100 ms at world build, deterministic, no server involved.
  const par = useMemo(() => computePar(world), [world])

  // Keep ?day= in sync when the day is changed from the panel or the R shortcut,
  // so any world found while testing survives a reload and can be linked to.
  const changeDay = useCallback((d: number) => {
    setDay(d)
    const url = new URL(window.location.href)
    url.searchParams.set('day', String(d))
    window.history.replaceState(null, '', url)
  }, [])

  const music = useMusic(world.seed)

  useEffect(() => attachInput(), [])

  return (
    <>
      <Canvas
        flat
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        // near 1.2, not 0.5: depth precision scales with the near plane, and the
        // shoreline z-fight needed every bit of it. Nothing renders closer than
        // 1.5 m anyway — the motes fade themselves out inside that.
        camera={{ fov: TUNING.fov, near: 1.2, far: 20000, position: [0, 400, 0] }}
      >
        <Scene world={world} />
      </Canvas>
      <div className="dream" aria-hidden="true" />
      <Hud world={world} par={par} />
      <AudioToggle muted={music.muted} onToggle={music.toggle} />
      <TuningPanel day={day} onDay={changeDay} world={world} />
    </>
  )
}
