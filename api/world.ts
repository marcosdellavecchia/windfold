/**
 * A world's presence: total metres flown on it, where planes came to rest, and
 * the words their pilots left with them. Read on world load; briefly cacheable
 * at the edge because the numbers only need to feel alive, not be exact.
 */
export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!Number.isFinite(id) || !Number.isInteger(id)) return new Response('id', { status: 400 })

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return new Response('storage', { status: 503 })

  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify([
        ['GET', `w:${id}:m`],
        ['LRANGE', `w:${id}:r`, '0', '399'],
        ['LRANGE', `w:${id}:t`, '0', '399'],
      ]),
    })
    if (!r.ok) return new Response('storage', { status: 503 })
    const [mRes, rRes, tRes] = (await r.json()) as Array<{ result: unknown }>

    const m = Number(mRes.result ?? 0) || 0
    const rests: Array<[number, number, number, string, number]> = []
    if (Array.isArray(rRes.result)) {
      for (const item of rRes.result as string[]) {
        const parts = String(item).split(',')
        const x = Number(parts[0])
        const z = Number(parts[1])
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue
        // Older entries have no name or metres; they stay anonymous paper.
        rests.push([x, z, Number(parts[2]) ? 1 : 0, parts[3] ?? '', Number(parts[4]) || 0])
      }
    }

    // Keyed by the resting point the note was written about, "x,z". Newest
    // first out of the list, so the first entry for a point is that flight's
    // current word and every older one it shadows is skipped.
    const notes: Record<string, string> = {}
    if (Array.isArray(tRes?.result)) {
      for (const item of tRes.result as string[]) {
        const raw = String(item)
        const c1 = raw.indexOf(',')
        const c2 = c1 < 0 ? -1 : raw.indexOf(',', c1 + 1)
        if (c2 < 0) continue
        const key = raw.slice(0, c2)
        const text = raw.slice(c2 + 1)
        if (!text || key in notes) continue
        notes[key] = text
      }
    }

    return new Response(JSON.stringify({ m, rests, notes }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 's-maxage=60, stale-while-revalidate=300',
      },
    })
  } catch {
    return new Response('storage', { status: 503 })
  }
}
