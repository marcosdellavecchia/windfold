import { useCallback, useEffect, useRef, useState } from 'react'
import { Music } from './music'
import { hudDraft } from '../state'

const STORAGE_KEY = 'windfold.muted'

const readMuted = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Private mode, or storage disabled. Not worth caring about — default to sound on.
    return false
  }
}

/**
 * Owns the session's Music instance.
 *
 * Written to survive being mounted twice. StrictMode runs the effect, tears it down,
 * and runs it again; an earlier version created the instance during render and set the
 * ref to null on cleanup, so the second run dereferenced a null and the whole tree
 * failed to mount — which showed up as the toggle simply not existing.
 */
export function useMusic(seed: number) {
  const ref = useRef<Music | null>(null)
  const [muted, setMuted] = useState(readMuted)
  const mutedRef = useRef(muted)
  const seedRef = useRef(seed)
  seedRef.current = seed

  const instance = useCallback(() => {
    if (ref.current === null) {
      ref.current = new Music(seedRef.current)
      ref.current.setMuted(mutedRef.current)
    }
    return ref.current
  }, [])

  useEffect(() => {
    const music = instance()
    const detach = music.attachAutostart()

    // The flight feeds the music through the same draft the HUD reads — no
    // wiring across the Canvas boundary. Lift gates the vario bells, altitude
    // opens the lowpass, and a gentle landing rings its bell once.
    let wasDown = false
    const feed = window.setInterval(() => {
      const flying = hudDraft.phase === 'flying'
      music.setLift(flying ? hudDraft.airLift : 0)
      music.setAltitude(Math.min(hudDraft.altitude / 900, 1))
      const down = hudDraft.phase === 'down'
      if (down && !wasDown && hudDraft.landed) music.landingBell()
      wasDown = down
    }, 120)

    return () => {
      window.clearInterval(feed)
      detach()
      music.dispose()
      ref.current = null
    }
  }, [instance])

  useEffect(() => {
    ref.current?.setSeed(seed)
  }, [seed])

  const toggle = useCallback(() => {
    setMuted((was) => {
      const next = !was
      mutedRef.current = next
      instance().setMuted(next)
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        // Preference just will not persist. The toggle still works this session.
      }
      return next
    })
  }, [instance])

  return { muted, toggle }
}
