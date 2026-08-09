import { useState } from 'react'
import { useHud } from '../state'
import type { World } from '../sim/world'
import { recordOf, savedState } from '../game/persist'
import { copyCard, shareCard } from '../game/share'
import { callsign, rerollCallsign, setCallsign } from '../game/callsign'

const metres = (v: number) => Math.round(v).toLocaleString('en-US')

/** Under 10 km keep a decimal, above it round — "2.4 km", then "124 km". */
const kmFlown = (m: number) =>
  m < 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString('en-US')} km`

export function Hud({ world, par, metresFlown }: { world: World; par: number; metresFlown: number }) {
  const s = useHud()

  return (
    <div className="hud">
      {/*
        Debug turbo's speed effect. A real motion blur wants a post-processing
        pass and a render target, neither of which this game has — but the blur
        that actually reads at speed is the one at the edge of vision, and a
        backdrop filter behind a radial mask is exactly that for a few lines of
        CSS. The centre of the frame stays sharp, which is both what the eye does
        and what keeps the thing you are flying at legible.
      */}
      <div className={`speedRush${s.turbo ? ' on' : ''}`} />

      {/* Flight instruments — thin and minimal, per the art direction. */}
      <div className={`instruments ${s.phase === 'down' ? 'dim' : ''}`}>
        <div className="readout">
          <span className={`value${s.cheated ? ' void' : ''}`}>{metres(s.distance)}</span>
          <span className="unit">m</span>
        </div>
        {/*
          The panel states the rule before turbo is switched on; this states it
          again at the only other moment it matters. The distance keeps counting,
          because going somewhere to look at it is the point — but a number that
          is quietly not going to be kept is worse than no number, so it says so
          while it is still running rather than at the results screen.
        */}
        {s.cheated && <div className="voidTag">turbo · not scored</div>}
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
          {/* Sign the paper before it flies — on the ramp, ignorable forever. */}
          <Signature />
        </div>
      )}

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
 * "Sign your paper": the call sign your resting darts carry. Type your own,
 * roll another, or keep what you were dealt — inline, right where you are.
 * Never a prompt, never a modal: rule 7 stands, and a first-time visitor can
 * ignore this line forever.
 */
function Signature() {
  const [name, setName] = useState(callsign)
  const [editing, setEditing] = useState(false)

  if (editing) {
    const commit = (value: string) => {
      setName(setCallsign(value))
      setEditing(false)
    }
    return (
      <div className="signed" data-ui>
        flying as{' '}
        <input
          autoFocus
          defaultValue={name}
          maxLength={20}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      </div>
    )
  }

  return (
    <div className="signed" data-ui>
      flying as {name}
      <button onClick={() => setEditing(true)}>change</button>
      <button onClick={() => setName(rerollCallsign())} title="roll another sign">
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
