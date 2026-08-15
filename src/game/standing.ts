import type { RestPoint } from './net'

/**
 * Where your best flight stands among the day's flights.
 *
 * The presence layer was already carrying this and nobody had asked it: every
 * resting point ships the distance that produced it, so the client holds a
 * sample of today's distances the moment the world loads. No new endpoint, no
 * new storage, no ghost backend — a sort and a search.
 *
 * Two things the wording has to be honest about. The rows are *flights*, not
 * pilots: someone who flew thirty times put thirty rows in, most of them bad,
 * so "farther than 78% of pilots" would be a lie where "78% of today's
 * flights" is not. And the pool is deliberately everyone *else* — your own
 * attempts are merged into presence as you fly, and letting your thirty
 * crashes pad the denominator would make grinding look like improving.
 */

/** Below this the sample says more about who showed up early than about you. */
const MIN_SAMPLE = 20

/**
 * The comparison pool: other people's flight distances, sorted ascending.
 * Rests written before the distance field existed carry 0 and are dropped —
 * they would otherwise read as a pile of zero-metre flights to beat.
 */
export function standingPool(rests: RestPoint[]): number[] {
  const out: number[] = []
  for (const r of rests) if (r.metres > 0) out.push(r.metres)
  return out.sort((a, b) => a - b)
}

/**
 * The share of the pool your best beats, 0-100, or null when there is not
 * enough of a pool to say anything. 100 means it is the longest logged here,
 * which the callers say in words rather than as a percentage.
 */
export function percentileOf(best: number, pool: number[]): number | null {
  if (best <= 0 || pool.length < MIN_SAMPLE) return null
  // Upper bound: ties count as beaten, so matching the field's worst flight is
  // not reported as beating nobody.
  let lo = 0
  let hi = pool.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pool[mid] <= best) lo = mid + 1
    else hi = mid
  }
  return Math.round((lo / pool.length) * 100)
}
