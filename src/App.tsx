import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hudDraft } from './state'
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
  // ?world=N opens a specific world — a share-card challenge link, or a dev
  // affordance. Without it, today's world.
  const [day, setDay] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('world')
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? Math.trunc(n) : dayNumber()
  })
  // Whether the player deliberately chose a world (link, R, panel). A chosen
  // world never gets swapped out from under them at midnight.
  const overridden = useRef(new URLSearchParams(window.location.search).has('world'))
  const world = useMemo(() => buildWorld(day), [day])
  // The paper pilot flies the day once, headlessly, and its distance is par.
  // ~100 ms at world build, deterministic, no server involved.
  const par = useMemo(() => computePar(world), [world])

  // Keep ?world= in sync when the world is changed from the panel or the R
  // shortcut, so any world found while testing survives a reload and can be
  // linked to.
  const changeDay = useCallback((d: number) => {
    overridden.current = true
    setDay(d)
    const url = new URL(window.location.href)
    url.searchParams.set('world', String(d))
    window.history.replaceState(null, '', url)
  }, [])

  // Midnight rollover: a tab left open overnight gets the new world when it
  // next matters — on refocus or on a slow tick — but never mid-flight, and
  // never when the player deliberately opened a specific world.
  useEffect(() => {
    const check = () => {
      if (overridden.current) return
      if (hudDraft.phase === 'flying') return
      const today = dayNumber()
      if (today !== day) setDay(today)
    }
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    const tick = window.setInterval(check, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(tick)
    }
  }, [day])

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
        <Scene world={world} par={par} />
      </Canvas>
      <div className="dream" aria-hidden="true" />
      <Hud world={world} par={par} />
      <AudioToggle muted={music.muted} onToggle={music.toggle} />
      <TuningPanel day={day} onDay={changeDay} world={world} />
    </>
  )
}
