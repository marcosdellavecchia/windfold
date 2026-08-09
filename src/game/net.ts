/**
 * The thin wire to the presence backend. Everything here fails silently and
 * completely: the game is a solo glider first, and it must fly identically
 * with no network, no backend, and no data — presence is a layer laid over
 * the world, never a dependency of it.
 */
export interface RestPoint {
  x: number
  z: number
  landed: boolean
}

export interface Presence {
  /** Total metres flown on this world, by everyone. */
  metres: number
  /** Where planes came to rest — the world's drift of paper. */
  rests: RestPoint[]
}

/** Fire-and-forget: one beacon per finished flight. */
export function postFlight(world: number, x: number, z: number, distance: number, landed: boolean) {
  try {
    void fetch('/api/flight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ w: world, x: Math.round(x), z: Math.round(z), d: Math.round(distance), l: landed }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* offline, blocked, absent: all fine */
  }
}

export async function fetchPresence(world: number): Promise<Presence | null> {
  try {
    const r = await fetch(`/api/world?id=${world}`)
    if (!r.ok) return null
    const data = (await r.json()) as { m: number; rests: Array<[number, number, number]> }
    if (typeof data.m !== 'number' || !Array.isArray(data.rests)) return null
    return {
      metres: data.m,
      rests: data.rests
        .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([x, z, l]) => ({ x, z, landed: l === 1 })),
    }
  } catch {
    return null
  }
}
