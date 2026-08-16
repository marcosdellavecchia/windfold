/**
 * A word left with the paper: the optional line a pilot writes after a flight
 * comes down, read by whoever swoops low enough over their resting dart.
 *
 * Deliberately *not* part of the flight beacon. That beacon carries the shared
 * odometer and must fire the instant the plane stops — a note is typed seconds
 * later, on the results screen, and half of them never get typed at all. So it
 * is a second, rarer call that touches nothing the first one wrote.
 *
 * One note per *flight*, keyed by the resting point it was written about. The
 * first cut keyed it by call sign instead, on the theory that a pilot who
 * crashed five times in one meadow is one story — and it was wrong in play:
 * you meet a pilot's darts one at a time, not all at once, so there was no
 * ambiguity to protect against, only a second message silently rewriting the
 * caption on the first one's paper. A note is about a flight ("so close",
 * "the ridge lied"), and the flight is where it belongs.
 *
 * Rewriting a point simply pushes a newer entry that shadows the old one, and
 * the list is capped and expiring like everything else here.
 */
import { cleanNote, plausiblePoint, restKey } from './_clean'

export const config = { runtime: 'edge' }

const NOTE_CAP = 400
const TTL_S = 14 * 86400

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method', { status: 405 })

  let body: { w?: number; x?: number; z?: number; t?: string }
  try {
    body = await req.json()
  } catch {
    return new Response('body', { status: 400 })
  }

  const { w, x, z } = body
  if (typeof w !== 'number' || !Number.isFinite(w) || !Number.isInteger(w)) {
    return new Response('world', { status: 400 })
  }
  if (!plausiblePoint(x, z)) return new Response('implausible', { status: 400 })

  // A note the gate emptied out is a silent no-op by design — the writer is
  // not told which word offended, because that is a guessing game with a prize.
  const text = cleanNote(body.t)
  if (!text) return new Response('ok')

  // The key is two integers, so the second comma is unambiguously the end of
  // it and the note may keep its own commas.
  const ok = await redis([
    ['LPUSH', `w:${w}:t`, `${restKey(x as number, z as number)},${text}`],
    ['LTRIM', `w:${w}:t`, '0', String(NOTE_CAP - 1)],
    ['EXPIRE', `w:${w}:t`, String(TTL_S)],
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
