import type { FlightSample } from '../sim/flight'

/**
 * Everything the game remembers between visits, all of it in localStorage per
 * the design rules: no accounts, no server, and if the browser data goes, the
 * records go with it — that is the honest cost of no signup.
 *
 * Records are kept per *world*, not just for today: a share-card link opens
 * someone else's world as an expedition, and your best on it is worth keeping.
 * Old records are trimmed so thirty visits don't silt up the store.
 */
export interface WorldRecord {
  best: number
  attempts: number
  /** Altitude profile of the best flight, 12 steps quantised 0-7, for the card. */
  profile: number[]
  parBeaten: boolean
  landed: boolean
}

export interface SavedState {
  records: Record<string, WorldRecord>
}

const KEY = 'windfold.state'
const MARKER_KEY = 'windfold.inflight'
const KEEP_RECORDS = 10

/**
 * One instance for the session, shared by the simulation (which writes) and
 * the HUD (which reads when it builds the share card). Reconciles any
 * in-flight marker from a dead page on first touch.
 */
let singleton: SavedState | null = null
export function savedState(): SavedState {
  if (!singleton) {
    singleton = loadState()
    reconcileMarker(singleton)
  }
  return singleton
}

export function loadState(): SavedState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as SavedState
      if (s.records && typeof s.records === 'object') return { records: s.records }
    }
  } catch {
    // Corrupt or blocked storage reads as a fresh start; the game must never
    // refuse to fly over a bookkeeping problem.
  }
  return { records: {} }
}

function saveState(s: SavedState) {
  try {
    // Trim to the most recent worlds so the store stays a few kilobytes.
    const keys = Object.keys(s.records)
    if (keys.length > KEEP_RECORDS) {
      keys
        .sort((a, b) => Number(a) - Number(b))
        .slice(0, keys.length - KEEP_RECORDS)
        .forEach((k) => delete s.records[k])
    }
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage full or blocked: play on, remember nothing.
  }
}

export function recordOf(s: SavedState, world: number): WorldRecord {
  return s.records[world] ?? { best: 0, attempts: 0, profile: [], parBeaten: false, landed: false }
}

/**
 * An attempt is counted the moment the plane launches — written here before
 * the first physics tick, so refreshing mid-flight still burns it.
 */
export function noteLaunch(s: SavedState, world: number): SavedState {
  const rec = recordOf(s, world)
  s.records[world] = { ...rec, attempts: rec.attempts + 1 }
  saveState(s)
  return s
}

/** A flight resolved. Fold it into the world's record. */
export function noteFlight(
  s: SavedState,
  world: number,
  distance: number,
  par: number,
  landed: boolean,
  path: FlightSample[],
): SavedState {
  const rec = recordOf(s, world)
  const isBest = distance > rec.best
  s.records[world] = {
    best: isBest ? distance : rec.best,
    attempts: rec.attempts,
    profile: isBest ? profileOf(path) : rec.profile,
    parBeaten: rec.parBeaten || distance >= par,
    landed: isBest ? landed : rec.landed,
  }
  clearMarker()
  saveState(s)
  return s
}

/**
 * The in-flight marker: world and the distance so far, refreshed on a slow
 * cadence while flying. If the page dies mid-flight, the next load finds it
 * and logs the attempt at its last recorded sample, exactly as the attempt
 * rules demand — bailing out must never be cheaper than crashing.
 */
export function writeMarker(world: number, distance: number) {
  try {
    localStorage.setItem(MARKER_KEY, JSON.stringify({ world, distance }))
  } catch {
    /* same policy as saveState */
  }
}

export function clearMarker() {
  try {
    localStorage.removeItem(MARKER_KEY)
  } catch {
    /* ignore */
  }
}

/** Reconcile a marker left by a dead page. Returns true if one was folded in. */
export function reconcileMarker(s: SavedState): boolean {
  try {
    const raw = localStorage.getItem(MARKER_KEY)
    if (!raw) return false
    const m = JSON.parse(raw) as { world: number; distance: number }
    localStorage.removeItem(MARKER_KEY)
    if (typeof m.world !== 'number' || typeof m.distance !== 'number') return false
    const rec = recordOf(s, m.world)
    // The attempt itself was already counted at launch; only the distance of
    // the abandoned flight needs folding in.
    if (m.distance > rec.best) {
      s.records[m.world] = { ...rec, best: m.distance, landed: false }
    }
    saveState(s)
    return true
  } catch {
    return false
  }
}

/**
 * The altitude profile: the best flight's height above its own lowest point,
 * resampled to 12 steps and quantised to the eight block heights. It is a
 * picture of how you flew — every thermal climb is visible in it.
 */
function profileOf(path: FlightSample[]): number[] {
  if (path.length < 2) return []
  const STEPS = 12
  let min = Infinity
  let max = -Infinity
  for (const p of path) {
    if (p.y < min) min = p.y
    if (p.y > max) max = p.y
  }
  const range = Math.max(max - min, 1)
  const out: number[] = []
  for (let i = 0; i < STEPS; i++) {
    const p = path[Math.min(Math.round((i / (STEPS - 1)) * (path.length - 1)), path.length - 1)]
    out.push(Math.max(0, Math.min(7, Math.round(((p.y - min) / range) * 7))))
  }
  return out
}
