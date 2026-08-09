import { useSyncExternalStore } from 'react'
import type { Phase } from './sim/flight'

/**
 * Read model for the HUD. The simulation writes into `draft` every frame; the
 * store only publishes a new immutable snapshot at HUD_HZ, so React re-renders
 * a handful of times a second instead of sixty.
 */
export interface HudState {
  phase: Phase
  distance: number
  best: number
  attempts: number
  altitude: number
  airspeed: number
  vario: number
  airLift: number
  stall: number
  /** Set on the frame a flight ends, so the results screen can shout about it. */
  newBest: boolean
  lastDistance: number
  /** Whether the last flight ended in a gentle touchdown rather than a crash. */
  landed: boolean
}

const HUD_HZ = 12

const draft: HudState = {
  phase: 'ready',
  distance: 0,
  best: 0,
  attempts: 0,
  altitude: 0,
  airspeed: 0,
  vario: 0,
  airLift: 0,
  stall: 0,
  newBest: false,
  lastDistance: 0,
  landed: false,
}

let snapshot: HudState = { ...draft }
let listeners: Array<() => void> = []
let sinceFlush = 0

export function writeHud(patch: Partial<HudState>) {
  Object.assign(draft, patch)
}

/** Publish if enough time has passed, or immediately when `force` is set. */
export function flushHud(dt: number, force = false) {
  sinceFlush += dt
  if (!force && sinceFlush < 1 / HUD_HZ) return
  sinceFlush = 0
  snapshot = { ...draft }
  for (const l of listeners) l()
}

const subscribe = (cb: () => void) => {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((l) => l !== cb)
  }
}

export const useHud = () => useSyncExternalStore(subscribe, () => snapshot)

export const hudDraft = draft
