/**
 * A word left with the paper: the optional line a pilot writes after a flight
 * comes down, read by whoever swoops low enough over their resting dart.
 *
 * Deliberately *not* part of the flight beacon. That beacon carries the shared
 * odometer and must fire the instant the plane stops — a note is typed seconds
 * later, on the results screen, and half of them never get typed at all. So it
 * is a second, rarer call that touches nothing the first one wrote.
 *
 * One note per call sign per world, not per flight: a pilot who crashed five
 * times in one meadow is one story, and the label pool already thins their
 * darts down to one name. Rewriting simply pushes a newer entry that shadows
 * the old one, and the list is capped and expiring like everything else here.
 * Call signs are not accounts (rule 5) — two pilots who roll the same sign
 * share the note, which is the honest cost of identity without authentication.
 */
import { cleanName, cleanNote } from './_clean'

export const config = { runtime: 'edge' }

const NOTE_CAP = 400
const TTL_S = 14 * 86400

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('method', { status: 405 })

  let body: { w?: number; n?: string; t?: string }
  try {
    body = await req.json()
  } catch {
    return new Response('body', { status: 400 })
  }

  const { w } = body
  if (typeof w !== 'number' || !Number.isFinite(w) || !Number.isInteger(w)) {
    return new Response('world', { status: 400 })
  }

  const name = cleanName(body.n)
  const text = cleanNote(body.t)
  // A note is a signature's companion; unsigned paper has nothing to hang it
  // on. A note that the gate emptied out is a silent no-op by design — the
  // writer is not told which word offended, because that is a guessing game
  // with a prize.
  if (!name || !text) return new Response('ok')

  // The name is letters and spaces, so the first comma is unambiguously the
  // separator and the note may keep its own commas.
  const ok = await redis([
    ['LPUSH', `w:${w}:t`, `${name},${text}`],
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
