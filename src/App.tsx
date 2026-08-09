import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hudDraft } from './state'

/**
 * The between-worlds veil: the live frame blurs away under a dark glass, the
 * heavy build runs while it is opaque, and it lifts slowly off the new world.
 * Mounted transparent and shown one frame later, so the fade-in actually
 * animates; data-ui plus pointer-events so a click during the swap cannot
 * launch a flight into a world that is about to vanish.
 */
function WorldVeil({ phase, onDone }: { phase: 'in' | 'out'; onDone: () => void }) {
  const [shown, setShown] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (phase === 'in') {
      const id = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(id)
    }
    // Unmount when the lift transition has actually played, not on a clock:
    // a timer started before the build burns down *during* the block and
    // yanks the veil off 14 ms after the world appears (measured). The
    // transitionend event can only fire once the fade has truly run.
    setShown(false)
    const el = ref.current
    const done = () => onDone()
    el?.addEventListener('transitionend', done, { once: true })
    const fallback = window.setTimeout(done, 3000)
    return () => {
      el?.removeEventListener('transitionend', done)
      window.clearTimeout(fallback)
    }
  }, [phase, onDone])
  return (
    <div ref={ref} className={`veil${shown ? ' show' : ''}${phase === 'out' ? ' lift' : ''}`} data-ui>
      <div className="veilText">Imagining new worlds…</div>
    </div>
  )
}
import { Canvas } from '@react-three/fiber'
import { buildWorld, dayNumber } from './sim/world'
import { computePar } from './sim/par'
import { fetchPresence, type Presence } from './game/net'
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

  // The presence layer: what everyone else did on this world. Strictly
  // decorative — the fetch failing (offline, no backend, dev) leaves the
  // game exactly as it was.
  const [presence, setPresence] = useState<Presence | null>(null)
  useEffect(() => {
    let alive = true
    setPresence(null)
    void fetchPresence(day).then((p) => {
      if (alive) setPresence(p)
    })
    return () => {
      alive = false
    }
  }, [day])

  // Swapping worlds blocks the main thread for the better part of a second —
  // heightfield, vertex colours, the paper pilot's par flight. Rather than
  // freeze mid-frame, a veil blurs the current world away first, the build
  // happens under it, and it lifts slowly off the new one. The text sells the
  // pause as the game thinking rather than the page hanging.
  const [veil, setVeil] = useState<{ day: number; phase: 'in' | 'out'; byUser: boolean } | null>(null)

  const changeDay = useCallback((d: number) => {
    overridden.current = true
    setVeil({ day: d, phase: 'in', byUser: true })
  }, [])

  useEffect(() => {
    if (!veil || veil.phase !== 'in') return
    // Give the veil time to fade fully opaque before the build stalls paint.
    // It stays opaque until the scene reports the new world's first rendered
    // frame — the React commit is fast, but the real stall is the scene
    // rebuild that follows on the frame loop, and lifting on a clock meant
    // fading out over the *old* world (measured).
    const t = window.setTimeout(() => {
      setDay(veil.day)
      if (veil.byUser) {
        const url = new URL(window.location.href)
        url.searchParams.set('world', String(veil.day))
        window.history.replaceState(null, '', url)
      }
    }, 300)
    // Failsafe: never leave the player behind an opaque veil.
    const failsafe = window.setTimeout(
      () => setVeil((v) => (v && v.phase === 'in' ? { ...v, phase: 'out' } : v)),
      6000,
    )
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(failsafe)
    }
  }, [veil])

  // The scene's first frame with the new world already resident.
  const onWorldReady = useCallback(() => {
    setVeil((v) => (v && v.phase === 'in' ? { ...v, phase: 'out' } : v))
  }, [])

  const veilDone = useCallback(() => setVeil(null), [])

  // Midnight rollover: a tab left open overnight gets the new world when it
  // next matters — on refocus or on a slow tick — but never mid-flight, and
  // never when the player deliberately opened a specific world.
  useEffect(() => {
    const check = () => {
      if (overridden.current) return
      if (hudDraft.phase === 'flying') return
      const today = dayNumber()
      if (today !== day) setVeil({ day: today, phase: 'in', byUser: false })
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
        <Scene world={world} par={par} onWorldReady={onWorldReady} rests={presence?.rests ?? null} />
      </Canvas>
      <div className="dream" aria-hidden="true" />
      {veil && <WorldVeil phase={veil.phase} onDone={veilDone} />}
      <Hud world={world} par={par} metresFlown={presence?.metres ?? 0} />
      <AudioToggle muted={music.muted} onToggle={music.toggle} />
      <TuningPanel day={day} onDay={changeDay} world={world} />
    </>
  )
}
