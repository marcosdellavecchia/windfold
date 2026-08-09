/**
 * Call signs: identity without accounts, personality without moderation.
 *
 * Every pilot gets a two-word name drawn from curated lists — never typed, so
 * there is nothing to filter and nothing to ban; rerollable until one feels
 * right, so it still feels chosen. The sign rides the flight beacon and is
 * revealed when someone swoops low over your resting paper. Both word lists
 * are pure letters, which is also the server's validation rule.
 */
const FIRST = [
  'Quiet', 'Paper', 'Gloaming', 'Drifting', 'Hazy', 'Amber', 'Windward',
  'Fading', 'Folded', 'Gentle', 'Dawn', 'Dusk', 'Wandering', 'Misty',
  'Distant', 'Homeward', 'Rising', 'Silver', 'Golden', 'Pale', 'Lone',
  'Sunlit', 'Thermal', 'Feather', 'Willow', 'Summer', 'Reverie', 'Slow',
]

const SECOND = [
  'Heron', 'Swift', 'Kestrel', 'Wren', 'Plover', 'Tern', 'Finch', 'Lark',
  'Petrel', 'Osprey', 'Swallow', 'Curlew', 'Kite', 'Merlin', 'Dove',
  'Crane', 'Egret', 'Gull', 'Skylark', 'Starling', 'Linnet', 'Avocet',
  'Dunlin', 'Pipit', 'Siskin', 'Robin', 'Sparrow', 'Swan',
]

const KEY = 'windfold.callsign'

export function callsign(): string {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored) return stored
  } catch {
    /* storage blocked: a session-only sign below */
  }
  return rerollCallsign()
}

export function rerollCallsign(): string {
  return store(`${pick(FIRST)} ${pick(SECOND)}`)
}

/**
 * A typed sign. Client-side it obeys the same rules the server enforces —
 * letters and spaces, capped — so what you see is what the world can carry.
 * Emptied out, it falls back to a rolled sign: paper is never unsigned by
 * accident, only by history.
 */
export function setCallsign(raw: string): string {
  const clean = raw.replace(/[^A-Za-z ]/g, '').replace(/ +/g, ' ').trim().slice(0, 20)
  return clean ? store(clean) : rerollCallsign()
}

function store(name: string): string {
  try {
    localStorage.setItem(KEY, name)
  } catch {
    /* it just will not persist */
  }
  return name
}

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]
