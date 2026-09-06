import { Quaternion, Vector3 } from 'three'
import type { Phase } from '../sim/flight'

/** Render-only flight state, written before scenery updates; never feeds physics. */
export const flightVisual = {
  phase: 'ready' as Phase,
  position: new Vector3(),
  rotation: new Quaternion(),
  speed: 0,
  lift: 0,
  stall: 0,
  time: 0,
  replaying: false,
  landed: false,
  touchdown: 0,
  impactPosition: new Vector3(),
  impactWater: false,
}
