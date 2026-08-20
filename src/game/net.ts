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
  /** The pilot's call sign, or empty for anonymous paper. */
  name: string
  /** How far that flight flew, for the swoop-down reveal. */
  metres: number
  /** The word left about *this* flight, joined in from `Presence.notes`. */
  note?: string
}

/**
 * The key a note hangs on: its resting point, rounded to the metre. Local rest
 * points carry raw floats straight off the simulation while anything that has
 * been through the server is already integral, so both sides round here or a
 * note never finds its own dart. Mirrors `restKey` in `api/_clean.ts`.
 */
export function restKey(x: number, z: number): string {
  return `${Math.round(x)},${Math.round(z)}`
}

export interface Presence {
  /** Total metres flown on this world, by everyone. */
  metres: number
  /** Where planes came to rest — the world's drift of paper. */
  rests: RestPoint[]
  /** `restKey(x, z)` → the word left about the flight that ended there. */
  notes: Record<string, string>
}

const apiBase = `${import.meta.env.BASE_URL}api`

/** Fire-and-forget: one beacon per finished flight. */
export function postFlight(
  world: number,
  x: number,
  z: number,
  distance: number,
  landed: boolean,
  name: string,
) {
  try {
    void fetch(`${apiBase}/flight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        w: world,
        x: Math.round(x),
        z: Math.round(z),
        d: Math.round(distance),
        l: landed,
        n: name,
      }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* offline, blocked, absent: all fine */
  }
}

/**
 * The word left with the paper, sent when the pilot writes it rather than with
 * the flight — separate call, separate key, so a note can never disturb the
 * odometer the beacon already banked. Addressed by the resting point it is
 * about, which is the same point the beacon just filed. Fire-and-forget like
 * everything here.
 */
export function postNote(world: number, x: number, z: number, text: string) {
  try {
    void fetch(`${apiBase}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ w: world, x: Math.round(x), z: Math.round(z), t: text }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* offline, blocked, absent: all fine */
  }
}

export async function fetchPresence(world: number): Promise<Presence | null> {
  try {
    const r = await fetch(`${apiBase}/world?id=${world}`)
    if (!r.ok) return null
    const data = (await r.json()) as {
      m: number
      rests: Array<[number, number, number, string?, number?]>
      notes?: Record<string, string>
    }
    if (typeof data.m !== 'number' || !Array.isArray(data.rests)) return null
    const notes: Record<string, string> = {}
    // Worlds written before notes existed simply have none.
    if (data.notes && typeof data.notes === 'object') {
      for (const [name, text] of Object.entries(data.notes)) {
        if (typeof text === 'string' && text) notes[name] = text
      }
    }
    return {
      metres: data.m,
      notes,
      rests: data.rests
        .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([x, z, l, n, d]) => ({
          x,
          z,
          landed: l === 1,
          name: typeof n === 'string' ? n : '',
          metres: Number(d) || 0,
        })),
    }
  } catch {
    return null
  }
}
