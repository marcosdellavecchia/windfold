import { useState } from 'react'
import { useHud } from '../state'
import type { World } from '../sim/world'
import { recordOf, savedState } from '../game/persist'
import { copyCard, shareCard } from '../game/share'
import { callsign, rerollCallsign } from '../game/callsign'

const metres = (v: number) => Math.round(v).toLocaleString('en-US')

/** Under 10 km keep a decimal, above it round — "2.4 km", then "124 km". */
const kmFlown = (m: number) =>
  m < 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString('en-US')} km`

export function Hud({ world, par, metresFlown }: { world: World; par: number; metresFlown: number }) {
  const s = useHud()

  return (
    <div className="hud">
      {/* Flight instruments — thin and minimal, per the art direction. */}
      <div className={`instruments ${s.phase === 'down' ? 'dim' : ''}`}>
        <div className="readout">
          <span className="value">{metres(s.distance)}</span>
          <span className="unit">m</span>
        </div>
        <div className="sub">
          {/* Height above ground is the resource the whole game is about, so it
              turns amber once there is not much of it left. */}
          <span className={s.altitude < 80 && s.phase === 'flying' ? 'low' : undefined}>
            {metres(Math.max(s.altitude, 0))} m agl
          </span>
          <span>{Math.round(s.airspeed)} m/s</span>
          {s.best > 0 && <span className="best">best {metres(s.best)} m</span>}
        </div>
      </div>

      <Vario lift={s.airLift} stall={s.stall} phase={s.phase} />

      {s.phase === 'ready' && (
        <div className="prompt">
          <div className="title">Windfold</div>
          {/* One line for the world, par included — the wind is something you
              feel in the first three seconds of flying, not something to read. */}
          <div className="meta">
            World {world.day} · {world.palette.mood} {world.biome} · par {metres(par)} m
          </div>
          {/* The presence layer's one number: everyone's flying, pooled. Worded
              so it cannot be misread as the player's own distance. */}
          {metresFlown >= 100 && <div className="others">pilots have flown {kmFlown(metresFlown)} here</div>}
          <div className="hint">Move to steer · click or space to launch</div>
          {/* Dev affordances, worth surfacing while the game is being tested. */}
          <div className="keys">R for another world · T for tuning</div>
        </div>
      )}

      {/* The swoop-down reveal: whose paper is below, and how far it flew. */}
      {s.phase === 'flying' && s.note && <div className="note">{s.note}</div>}

      {s.phase === 'down' && (
        <div className="result">
          {s.newBest && <div className="fanfare">New best</div>}
          {/* The one guaranteed-negative moment of every flight, made winnable:
              a flared, level touchdown is a landing, not a crash. */}
          {s.landed && <div className="soft">Gentle landing</div>}
          <div className="big">
            {metres(s.lastDistance)} <span className="unit">m</span>
          </div>
          <div className="meta">
            best {metres(s.best)} m · par {metres(par)} m{s.best >= par ? ' ✓' : ''} ·{' '}
            {s.attempts} {s.attempts === 1 ? 'flight' : 'flights'}
          </div>
          <Share world={world} />
          <div className="again">Fly again</div>
          <Signature />
        </div>
      )}
    </div>
  )
}

/**
 * "Sign your paper": the call sign your resting darts carry, rerollable until
 * one feels right. Never a prompt, never a modal — rule 7 stands.
 */
function Signature() {
  const [name, setName] = useState(callsign)
  return (
    <div className="signed" data-ui>
      flying as {name}
      <button onClick={() => setName(rerollCallsign())} title="try another name">
        ↻
      </button>
    </div>
  )
}

/**
 * The share button. data-ui so pressing it does not also restart the flight.
 * Once clicked, the button is gone and a confirmation stands in its place —
 * the card is on the clipboard, there is nothing further to press. The state
 * resets naturally when the results screen unmounts on the next launch.
 */
function Share({ world }: { world: World }) {
  const [copied, setCopied] = useState(false)
  if (copied) {
    return (
      <div className="shareDone" data-ui>
        Copied to clipboard
      </div>
    )
  }
  return (
    <button
      className="share"
      data-ui
      onClick={async () => {
        const rec = recordOf(savedState(), world.day)
        if (await copyCard(shareCard(world, rec))) setCopied(true)
      }}
    >
      Share
    </button>
  )
}

/**
 * Vertical speed of the air itself, not the aircraft. Reading this is how you
 * find a thermal and how you know you have centred it.
 */
function Vario({ lift, stall, phase }: { lift: number; stall: number; phase: string }) {
  if (phase !== 'flying') return null
  const n = Math.max(-1, Math.min(1, lift / 6))
  const size = `${Math.abs(n) * 50}%`
  const style = n >= 0 ? { height: size, bottom: '50%' } : { height: size, top: '50%' }
  return (
    <div className="vario">
      <div className="track">
        <div className={`fill ${n >= 0 ? 'up' : 'down'}`} style={style} />
        <div className="mid" />
      </div>
      <div className="varioLabel">{lift >= 0 ? '+' : ''}{lift.toFixed(1)}</div>
      {stall > 0.15 && <div className="stall">stall</div>}
    </div>
  )
}
