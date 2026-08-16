/**
 * The one gate every piece of player-supplied data passes through, shared by
 * all three edge functions so there is exactly one list to argue about.
 *
 * The game has no accounts, so it can never ban anybody — which means the only
 * moderation available is at the moment of writing. Both cleaners are therefore
 * shaped by what they *cannot* express rather than by what they catch: a call
 * sign is letters, a note is letters and a breath of punctuation, and neither
 * can contain a digit, a dot, a slash or an at-sign. That single restriction
 * removes every URL, handle and phone number in one move, and takes most
 * leetspeak evasion with it.
 */

/** Half the world's extent. Anything claiming to be outside it is not a flight. */
export const HALF_WORLD = 6144

/** A resting point the client claims: finite, and inside the world. */
export function plausiblePoint(x: unknown, z: unknown): boolean {
  return (
    typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= HALF_WORLD &&
    typeof z === 'number' && Number.isFinite(z) && Math.abs(z) <= HALF_WORLD
  )
}

/**
 * The key a note hangs on: the resting point it was written about, rounded to
 * the metre. Both sides must round identically or a note never finds its dart,
 * so the rounding lives here and nowhere else.
 */
export function restKey(x: number, z: number): string {
  return `${Math.round(x)},${Math.round(z)}`
}

/**
 * Deliberately short and unambiguous. Over-blocking a "Raccoon" is a cost
 * worth paying (the Scunthorpe problem cuts both ways); anything subtler than
 * this list is a judgement call a static file should not be making.
 */
export const BLOCKED = [
  'nigg', 'faggot', 'kike', 'spic', 'chink', 'wetback', 'coon', 'tranny',
  'retard', 'hitler', 'nazi', 'rape', 'cunt', 'whore', 'slut', 'pedo',
]

/** Letters squashed together — spacing tricks are the cheapest evasion there is. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

const blocked = (s: string) => BLOCKED.some((w) => squash(s).includes(w))

/**
 * A call sign: letters and spaces only, capped. A blocked sign ships as
 * anonymous paper — the flight still counts, the signature does not.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const name = raw.replace(/[^A-Za-z ]/g, ' ').replace(/ +/g, ' ').trim().slice(0, 24).trim()
  return blocked(name) ? '' : name
}

/** Short enough to read at a glance from a low pass, and to fit two lines of label. */
export const NOTE_MAX = 48

/**
 * Trim to the cap on a word boundary. A hard slice leaves "…forty eight
 * characters w" hanging over a field for a fortnight; falling back to the
 * whole word reads as a line that simply ended.
 */
export function clip(text: string): string {
  if (text.length <= NOTE_MAX) return text
  const cut = text.slice(0, NOTE_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > NOTE_MAX * 0.6 ? cut.slice(0, space) : cut).trim()
}

/**
 * A word left with the paper. Letters, spaces and `,'!?-` — no full stop, which
 * is what actually kills `example.com`, and no cost worth naming at this length:
 * forty-eight characters is a fragment, not a paragraph.
 */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Disallowed characters become spaces rather than vanishing, so "he@llo"
  // reads as two words instead of quietly reassembling into one.
  let text = clip(raw.replace(/[^A-Za-z ,'!?-]/g, ' ').replace(/\s+/g, ' ').trim())
  if (text.length < 2 || blocked(text)) return ''

  // Shouting is answered rather than refused: a line in capitals reads as
  // someone yelling across a quiet valley, so the valley lowers its voice.
  const letters = text.replace(/[^A-Za-z]/g, '')
  const caps = text.replace(/[^A-Z]/g, '')
  if (letters.length > 6 && caps.length > letters.length * 0.7) {
    text = text.charAt(0) + text.slice(1).toLowerCase()
  }
  return text
}
