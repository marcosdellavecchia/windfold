/**
 * Controller support, so the whole game is playable with a pad in your hands.
 *
 * The Gamepad API has no events for sticks and buttons — it is a polled
 * snapshot — so this module runs its own small requestAnimationFrame loop and
 * turns that snapshot into the two things the rest of the game wants: a live
 * steering axis (read once per frame by `readAxis`) and edge-triggered actions
 * (subscribed to by the HUD, the panel and the audio toggle). The loop only
 * exists while a pad is actually connected, so a mouse-and-keyboard player pays
 * nothing for this file being here.
 *
 * Button numbers are the W3C "standard mapping", which is what a wireless Xbox
 * controller reports on every browser that matters:
 *
 *   A  launch / fly again      Start  launch / fly again
 *   B  close the tuning panel  Back   toggle the tuning panel
 *   X  music on / off          Y      new random world (not mid-flight)
 *   LB share the card          RB/RT  hold for turbo
 *   left stick / d-pad         steer
 *
 * Right stick is deliberately unbound: there is no camera to fly.
 *
 * Nothing here shows up in the UI. A controller is the edge case and the hints
 * belong to the pointer nearly everyone arrives with, so this extends what the
 * game accepts without changing a word of what it says.
 *
 * RB and RT hold turbo exactly the way a held mouse button does, which means
 * they are inert until turbo is switched on in the tuning panel — same gate,
 * same stated consequence, no new way to stumble into it.
 */

/** Everything a pad can ask the game to do. */
export type PadAction = 'commit' | 'cancel' | 'panel' | 'reroll' | 'mute' | 'share'

/**
 * Face and shoulder buttons, in standard-mapping order. `commit` is on both A
 * and Start because rule 7 gives us about two seconds to be discovered, and a
 * player who has never seen this game will press one of those two.
 */
const ACTIONS: ReadonlyArray<readonly [number, PadAction]> = [
  [0, 'commit'], // A
  [1, 'cancel'], // B
  [2, 'mute'], // X
  [3, 'reroll'], // Y
  [4, 'share'], // LB
  [8, 'panel'], // Back / View
  [9, 'commit'], // Start / Menu
]

/** Shoulder and trigger, either of which holds turbo. */
const TURBO_BUTTONS = [5, 7] as const

/** D-pad, which steers exactly like the arrow keys do. */
const DPAD = { up: 12, down: 13, left: 14, right: 15 } as const

/**
 * Stick shaping. An Xbox stick rests somewhere inside a couple of tenths of
 * centre and never quite reaches the rim, so the raw value needs a hole cut in
 * the middle and the remainder stretched back out to a full unit — otherwise
 * the plane creeps at rest and can never be fully banked.
 *
 * The deadzone is radial rather than per-axis: cut it squarely and a stick
 * pushed straight up still leaks a little roll, which on a glider reads as the
 * aircraft refusing to fly straight.
 */
const DEADZONE = 0.18
/** Treat the last sliver before the rim as full deflection. */
const SATURATION = 0.03
/**
 * Slightly expo. The mouse maps screen position to deflection, which gives a
 * lot of travel for small corrections; a linear stick by comparison feels
 * twitchy around centre, which is exactly where a thermal is centred.
 */
const CURVE = 1.3
/** Analog triggers report a `value`; this is where it counts as pressed. */
const PRESS = 0.5

const stick = { x: 0, y: 0 }
let turboHeld = false
/**
 * Whether a pad has been touched this session. Steering has to latch onto the
 * controller the way it latches onto touch: the mouse steers by absolute cursor
 * position, so a controller player whose cursor happens to be resting in the
 * corner of the screen would otherwise be flying at full deflection with the
 * stick centred. Unlike the touch latch this one releases — move the mouse and
 * the mouse has it back.
 */
let active = false

let raf = 0
let held = new Set<number>()

const listeners = new Map<PadAction, Set<() => void>>()

/**
 * Subscribe to a pad action. Returns an unsubscribe, so a component can own a
 * binding for exactly as long as it is on screen — which is how the share
 * button gets LB only on the results screen.
 */
export function onPad(action: PadAction, fn: () => void): () => void {
  let set = listeners.get(action)
  if (!set) listeners.set(action, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

/** Current steering deflection from the pad. Both axes in −1…1. */
export const padAxis = () => stick

/** Whether a shoulder or trigger is holding turbo. Gating is `input.ts`'s job. */
export const isPadTurboHeld = () => turboHeld

/** Whether the pad, rather than the pointer, currently owns steering. */
export const isPadActive = () => active

/** Hand steering back to the mouse. Called when the mouse actually moves. */
export function releasePad() {
  active = false
}

const emit = (action: PadAction) => {
  const set = listeners.get(action)
  if (set) for (const fn of [...set]) fn()
}

const isDown = (b: GamepadButton | undefined) => !!b && (b.pressed || b.value > PRESS)

/** Live pads only. `getGamepads` returns a sparse array with holes in it. */
function livePads(): Gamepad[] {
  const list = navigator.getGamepads?.() ?? []
  const out: Gamepad[] = []
  for (const p of list) if (p && p.connected) out.push(p)
  return out
}

/** Radial deadzone, saturation, and the expo curve, in that order. */
function shape(rx: number, ry: number): { x: number; y: number } {
  const mag = Math.hypot(rx, ry)
  if (mag <= DEADZONE) return { x: 0, y: 0 }
  const span = 1 - SATURATION - DEADZONE
  const unit = Math.min(1, (mag - DEADZONE) / (span > 0 ? span : 1))
  const out = Math.pow(unit, CURVE) / mag
  return { x: rx * out, y: ry * out }
}

/** Drop every held state without firing anything. */
function clear() {
  stick.x = 0
  stick.y = 0
  turboHeld = false
  held = new Set()
}

function poll() {
  raf = requestAnimationFrame(poll)

  const pads = livePads()
  if (!pads.length) {
    clear()
    stop()
    return
  }

  // Every connected pad is merged rather than one being chosen: it costs
  // nothing, and it removes the whole question of which index is "the"
  // controller when a browser also reports a dock, a wheel, or a stale entry.
  let bestX = 0
  let bestY = 0
  let bestMag = 0
  let turbo = false
  const down = new Set<number>()

  for (const p of pads) {
    const rx = p.axes[0] ?? 0
    const ry = p.axes[1] ?? 0
    const mag = Math.hypot(rx, ry)
    if (mag > bestMag) {
      bestMag = mag
      bestX = rx
      bestY = ry
    }
    for (let i = 0; i < p.buttons.length; i++) if (isDown(p.buttons[i])) down.add(i)
    for (const b of TURBO_BUTTONS) if (isDown(p.buttons[b])) turbo = true
  }

  // Stick y is negative upward; the game's axis is positive upward, matching
  // the mouse and W/Up. Pitch inversion, for anyone who wants stick-forward to
  // be nose-down, is already a global tunable (`TUNING.invertPitch`).
  const analog = shape(bestX, -bestY)
  const dx = (down.has(DPAD.right) ? 1 : 0) - (down.has(DPAD.left) ? 1 : 0)
  const dy = (down.has(DPAD.up) ? 1 : 0) - (down.has(DPAD.down) ? 1 : 0)
  stick.x = dx !== 0 ? dx : analog.x
  stick.y = dy !== 0 ? dy : analog.y
  turboHeld = turbo

  if (stick.x !== 0 || stick.y !== 0 || down.size) active = true

  for (const [button, action] of ACTIONS) {
    if (down.has(button) && !held.has(button)) emit(action)
  }
  held = down
}

function start() {
  if (raf) return
  raf = requestAnimationFrame(poll)
}

function stop() {
  if (!raf) return
  cancelAnimationFrame(raf)
  raf = 0
}

/**
 * Watch for controllers. Polling starts on the first connection and stops when
 * the last pad goes away, so this is free until a pad exists.
 *
 * `gamepadconnected` is what wakes it up. Browsers hide pads until the page has
 * been interacted with, and pressing a button on the pad is itself that
 * interaction — so a controller that was plugged in before the tab opened still
 * announces itself the first time it is used.
 */
export function attachGamepad(): () => void {
  const onConnect = () => start()
  const onDisconnect = () => {
    // Don't stop here: a second pad may still be live, and the poll decides.
    clear()
  }
  // The API freezes while the tab is unfocused, so a button held through an
  // alt-tab would still read as down on return — and turbo would be latched on.
  const onBlur = () => clear()

  window.addEventListener('gamepadconnected', onConnect)
  window.addEventListener('gamepaddisconnected', onDisconnect)
  window.addEventListener('blur', onBlur)
  // A pad may already be visible — a reload with one in hand, or StrictMode
  // re-running this after the connect event has been and gone.
  if (livePads().length) start()

  return () => {
    window.removeEventListener('gamepadconnected', onConnect)
    window.removeEventListener('gamepaddisconnected', onDisconnect)
    window.removeEventListener('blur', onBlur)
    stop()
    clear()
  }
}
