import type { World } from '../sim/world'
import type { WorldRecord } from './persist'

/**
 * The share card. Plain text, emoji, copyable — it has to survive being
 * pasted into WhatsApp, iMessage and Discord as text, which is why there is
 * no image and never will be in v1.
 *
 * The block strip is the altitude profile of the best flight: a picture of
 * how you flew, with every thermal climb visible in it. Par gives the card a
 * verdict — beat the paper pilot or not — which makes cards comparable even
 * between players whose distances differ wildly. The URL names the exact
 * world, so every card is also a challenge link. No streak: it was built and
 * cut — the card sells the flight, not the habit.
 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Where the game lives. Full scheme, so the card's last line is a real link. */
const SITE = 'https://windfold.vercel.app'

export function shareCard(world: World, rec: WorldRecord): string {
  const m = Math.round(rec.best).toLocaleString('en-US')
  const flights = `${rec.attempts} ${rec.attempts === 1 ? 'flight' : 'flights'}`
  const par = rec.parBeaten ? 'par ✓' : 'par ✗'
  const landed = rec.landed ? ' \u{1F6EC}' : ''

  const lines = [
    `✈️ Windfold #${world.day} · ${world.palette.mood} ${world.biome}`,
    `${m} m · ${flights} · ${par}${landed}`,
  ]
  if (rec.profile.length > 0) {
    lines.push('', rec.profile.map((v) => BLOCKS[Math.max(0, Math.min(7, v))]).join(''))
  }
  lines.push('', `${SITE}/?world=${world.day}`)
  return lines.join('\n')
}

/** Clipboard, and only the clipboard — one click, then go paste it somewhere. */
export async function copyCard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
