import { useState } from 'react'
import { useHud } from '../state'
import type { World } from '../sim/world'
import { recordOf, savedState } from '../game/persist'
import { copyCard, shareCard } from '../game/share'

const metres = (v: number) => Math.round(v).toLocaleString('en-US')

export function Hud({ world, par }: { world: World; par: number }) {
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
          <div className="meta">
            World {world.day} · {world.palette.mood} {world.biome} · wind{' '}
            {Math.round(world.air.windSpeed)} m/s
          </div>
          {/* The world's completable goal: beat the paper pilot and the day is won. */}
          <div className="par">par {metres(par)} m</div>
          <div className="hint">Move to steer · click or space to launch</div>
          {/* Dev affordances, worth surfacing while the game is being tested. */}
          <div className="keys">R for another world · T for tuning</div>
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
        </div>
      )}
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
