/**
 * The word you leave with your paper: one optional line, written after a
 * flight comes down and read by whoever swoops low over your resting dart.
 *
 * Deliberately not remembered, unlike the call sign. The sign persists because
 * it is who you are; a note is what you said about *this* flight, so every
 * results screen asks again from empty. Remembering the last one was worse
 * than useless: the note only reaches the world when it is confirmed, so a
 * screen that showed yesterday's line was offering something it had no
 * intention of sending, and the next flight's paper went out bare.
 *
 * Client-side it obeys exactly the rules the server enforces (`api/_clean.ts`),
 * so what you see on the results screen is what the world can carry; the
 * server still cleans it again, because it must.
 */
export const NOTE_MAX = 48

/**
 * Letters, spaces and `,'!?-`. No digits and no full stop, which between them
 * leave no way to write a URL, a handle or a phone number — the mirror of
 * `cleanNote` on the server, and the reason a note needs no moderator.
 */
export function cleanNote(raw: string): string {
  const text = clip(raw.replace(/[^A-Za-z ,'!?-]/g, ' ').replace(/\s+/g, ' ').trim())
  return text.length < 2 ? '' : text
}

/** Trim to the cap on a word boundary rather than mid-syllable. */
function clip(text: string): string {
  if (text.length <= NOTE_MAX) return text
  const cut = text.slice(0, NOTE_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > NOTE_MAX * 0.6 ? cut.slice(0, space) : cut).trim()
}
