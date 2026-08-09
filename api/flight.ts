/**
 * One call per completed flight: where the plane came to rest, how far it flew,
 * whether it landed. Everything is an anonymous aggregate — no token, no IP
 * retained, nothing joinable across days — per design rule 5.
 *
 * Storage is Redis over REST (Vercel KV / Upstash): a distance counter and a
 * capped list of resting points per world, both expiring after two weeks. The
 * plausibility check is the whole anti-cheat, exactly as the design doc says:
 * Wordle survived fine and so will this.
 */
export const config = { runtime: 'edge' }

const HALF_WORLD = 6144
/** No honest flight is this long; see the harness distribution. */
const MAX_DISTANCE = 30000
const REST_CAP = 600
const TTL_S = 14 * 86400

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method', { status: 405 })

  let body: { w?: number; x?: number; z?: number; d?: number; l?: boolean }
  try {
    body = await req.json()
  } catch {
    return new Response('body', { status: 400 })
  }

  const { w, x, z, d, l } = body
  if (
    typeof w !== 'number' || !Number.isFinite(w) || !Number.isInteger(w) ||
    typeof x !== 'number' || Math.abs(x) > HALF_WORLD ||
    typeof z !== 'number' || Math.abs(z) > HALF_WORLD ||
    typeof d !== 'number' || d < 0 || d > MAX_DISTANCE
  ) {
    return new Response('implausible', { status: 400 })
  }

  const rest = `${Math.round(x)},${Math.round(z)},${l ? 1 : 0}`
  const ok = await redis([
    ['INCRBYFLOAT', `w:${w}:m`, String(Math.round(d))],
    ['LPUSH', `w:${w}:r`, rest],
    ['LTRIM', `w:${w}:r`, '0', String(REST_CAP - 1)],
    ['EXPIRE', `w:${w}:m`, String(TTL_S)],
    ['EXPIRE', `w:${w}:r`, String(TTL_S)],
  ])
  return ok ? new Response('ok') : new Response('storage', { status: 503 })
}

async function redis(commands: string[][]): Promise<boolean> {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return false
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(commands),
    })
    return r.ok
  } catch {
    return false
  }
}
