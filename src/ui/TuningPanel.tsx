import { useEffect, useState } from 'react'
import { TUNING, resetTuning, type Tuning } from '../sim/tuning'

interface Row {
  key: keyof Tuning
  min: number
  max: number
  step: number
  label: string
}

const GROUPS: Array<{ name: string; rows: Row[] }> = [
  {
    name: 'lift & drag',
    rows: [
      { key: 'clAlpha', min: 2, max: 9, step: 0.1, label: 'CL slope' },
      { key: 'alphaStall', min: 0.1, max: 0.6, step: 0.01, label: 'stall AoA' },
      { key: 'stallDecay', min: 0.05, max: 1, step: 0.01, label: 'stall softness' },
      { key: 'cd0', min: 0.005, max: 0.12, step: 0.001, label: 'parasitic drag' },
      { key: 'inducedK', min: 0.01, max: 0.2, step: 0.002, label: 'induced drag' },
      { key: 'cdSpeed', min: 0, max: 0.1, step: 0.002, label: 'high-speed drag' },
      { key: 'wingArea', min: 0.02, max: 0.15, step: 0.001, label: 'wing area' },
    ],
  },
  {
    name: 'handling',
    rows: [
      { key: 'maxBank', min: 0.3, max: 1.6, step: 0.02, label: 'max bank' },
      { key: 'maxPitch', min: 0.3, max: 1.4, step: 0.02, label: 'max pitch' },
      { key: 'rollP', min: 0.5, max: 8, step: 0.1, label: 'roll gain' },
      { key: 'pitchP', min: 0.5, max: 8, step: 0.1, label: 'pitch gain' },
      { key: 'maxRollRate', min: 0.5, max: 6, step: 0.1, label: 'roll rate' },
      { key: 'maxPitchRate', min: 0.3, max: 4, step: 0.05, label: 'pitch rate' },
      { key: 'weathervane', min: 0, max: 6, step: 0.1, label: 'weathervane' },
      { key: 'stallPitchDown', min: 0, max: 8, step: 0.1, label: 'stall break' },
      { key: 'inputSmoothing', min: 0.02, max: 1, step: 0.01, label: 'input smoothing' },
    ],
  },
  {
    name: 'launch & camera',
    rows: [
      { key: 'launchSpeed', min: 8, max: 60, step: 1, label: 'launch speed' },
      { key: 'launchAboveRoute', min: 60, max: 600, step: 10, label: 'release height' },
      { key: 'camDistance', min: 6, max: 45, step: 0.5, label: 'cam distance' },
      { key: 'camHeight', min: 0, max: 20, step: 0.2, label: 'cam height' },
      { key: 'camLag', min: 0.5, max: 14, step: 0.1, label: 'cam lag' },
      { key: 'camRoll', min: 0, max: 1, step: 0.02, label: 'cam roll' },
      { key: 'fov', min: 40, max: 100, step: 1, label: 'fov' },
    ],
  },
]

/**
 * Build step 1 is "iterate until flying is genuinely fun". That is a lot faster
 * with sliders than with a rebuild, so the tunables are editable in place.
 */
export function TuningPanel({ day, onDay }: { day: number; onDay: (d: number) => void }) {
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyT' && !e.metaKey && !e.ctrlKey) setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return <div className="tuneHint" data-ui>T</div>

  return (
    <div className="tune" data-ui>
      <div className="tuneHead">
        <strong>tuning</strong>
        <button onClick={() => { resetTuning(); bump((v) => v + 1) }}>reset</button>
        <button onClick={() => setOpen(false)}>close</button>
      </div>

      <div className="tuneRow">
        <label>day / seed</label>
        <div className="dayNav">
          <button onClick={() => onDay(day - 1)}>-</button>
          <span>{day}</span>
          <button onClick={() => onDay(day + 1)}>+</button>
        </div>
      </div>

      {GROUPS.map((g) => (
        <div key={g.name} className="tuneGroup">
          <div className="tuneGroupName">{g.name}</div>
          {g.rows.map((r) => (
            <div key={r.key} className="tuneRow">
              <label>{r.label}</label>
              <input
                type="range"
                min={r.min}
                max={r.max}
                step={r.step}
                value={TUNING[r.key] as number}
                onChange={(e) => {
                  setTune(r.key, parseFloat(e.target.value))
                  bump((v) => v + 1)
                }}
              />
              <span className="num">{fmt(TUNING[r.key] as number)}</span>
            </div>
          ))}
        </div>
      ))}

      <div className="tuneRow">
        <label>invert pitch</label>
        <input
          type="checkbox"
          checked={TUNING.invertPitch}
          onChange={(e) => {
            TUNING.invertPitch = e.target.checked
            bump((v) => v + 1)
          }}
        />
      </div>
    </div>
  )
}

const setTune = (k: keyof Tuning, v: number) => {
  ;(TUNING as unknown as Record<string, number>)[k as string] = v
}

const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''))
