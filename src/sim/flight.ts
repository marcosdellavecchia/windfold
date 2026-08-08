import { Quaternion, Vector3 } from 'three'
import { TUNING } from './tuning'
import { sampleAir, type Air, type Vec3Like } from './air'
import { clamp, surfaceHeight, sampleHeight, HALF_WORLD, type Heightfield } from './terrain'

export type Phase = 'ready' | 'flying' | 'down'

export interface FlightInput {
  /** -1 (left) .. 1 (right) */
  x: number
  /** -1 (down) .. 1 (up) */
  y: number
}

export interface FlightSample {
  x: number
  y: number
  z: number
}

const X_AXIS = new Vector3(1, 0, 0)
const Y_AXIS = new Vector3(0, 1, 0)
const Z_AXIS = new Vector3(0, 0, 1)

const FIXED_DT = 1 / 120
const MAX_STEPS = 8
const RECORD_HZ = 10

export interface LaunchSite {
  pos: Vector3
  heading: number
}

/**
 * The whole flight model. No React, no Three.js scene graph — just state and a
 * fixed-timestep integrator, so it can be stepped headlessly in a test.
 */
export class Flight {
  readonly pos = new Vector3()
  readonly vel = new Vector3()
  readonly quat = new Quaternion()

  phase: Phase = 'ready'
  time = 0
  distance = 0
  /** Signed climb rate of the aircraft, m/s. */
  vario = 0
  /** Vertical speed of the air itself — what the thermal indicator reads. */
  airLift = 0
  airspeed = 0
  alpha = 0
  bank = 0
  stallFactor = 0
  aglHeight = 0
  /** Recorded path at RECORD_HZ, for ghost trails and the altitude profile. */
  path: FlightSample[] = []

  private readonly launchPos = new Vector3()
  private launchHeading = 0
  private accumulator = 0
  private recordTimer = 0
  private smoothed: FlightInput = { x: 0, y: 0 }

  // Scratch, reused every step to keep the hot loop allocation-free.
  private readonly airVel: Vec3Like = { x: 0, y: 0, z: 0 }
  private readonly relVel = new Vector3()
  private readonly bodyRel = new Vector3()
  private readonly fwd = new Vector3()
  private readonly right = new Vector3()
  private readonly up = new Vector3()
  private readonly liftDir = new Vector3()
  private readonly force = new Vector3()
  private readonly invQuat = new Quaternion()
  private readonly dq = new Quaternion()

  constructor(
    private hf: Heightfield,
    private air: Air,
    site: LaunchSite,
  ) {
    this.launchPos.copy(site.pos)
    this.launchHeading = site.heading
    this.reset()
  }

  /** Instant restart: state reset and nothing more. No allocation of the world. */
  reset() {
    this.phase = 'ready'
    this.time = 0
    this.distance = 0
    this.vario = 0
    this.airLift = 0
    this.stallFactor = 0
    this.accumulator = 0
    this.recordTimer = 0
    this.smoothed.x = 0
    this.smoothed.y = 0
    this.path = []

    this.pos.copy(this.launchPos)
    this.quat.setFromAxisAngle(Y_AXIS, this.launchHeading)
    this.dq.setFromAxisAngle(X_AXIS, TUNING.launchPitch)
    this.quat.multiply(this.dq)

    this.bodyAxes()
    this.vel.copy(this.fwd).multiplyScalar(TUNING.launchSpeed)
    this.airspeed = TUNING.launchSpeed
    this.alpha = 0
    this.bank = 0
    this.aglHeight = this.pos.y - sampleHeight(this.hf, this.pos.x, this.pos.z)
  }

  launch() {
    if (this.phase !== 'ready') return
    this.phase = 'flying'
    this.path.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
  }

  update(frameDt: number, input: FlightInput) {
    const dt = clamp(frameDt, 0, 1 / 15)

    // Pointer smoothing, framerate-independent.
    const k = 1 - Math.pow(1 - TUNING.inputSmoothing, dt * 60)
    this.smoothed.x += (input.x - this.smoothed.x) * k
    this.smoothed.y += (input.y - this.smoothed.y) * k

    if (this.phase === 'ready') {
      // Hold at the launch point but let the pointer preview the attitude, so the
      // controls are discoverable before committing to a flight.
      this.previewAttitude(dt)
      return
    }
    if (this.phase === 'down') return

    this.accumulator += dt
    let steps = 0
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.step(FIXED_DT)
      this.accumulator -= FIXED_DT
      steps++
      if (this.phase !== 'flying') break
    }
    if (steps === MAX_STEPS) this.accumulator = 0

    this.recordTimer += dt
    if (this.recordTimer >= 1 / RECORD_HZ && this.phase === 'flying') {
      this.recordTimer = 0
      this.path.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
    }
  }

  private previewAttitude(dt: number) {
    const targetBank = this.smoothed.x * TUNING.maxBank
    const targetPitch = (TUNING.invertPitch ? -this.smoothed.y : this.smoothed.y) * TUNING.maxPitch * 0.6
    this.bodyAxes()
    const bank = Math.atan2(-this.right.y, this.up.y)
    const pitch = Math.asin(clamp(this.fwd.y, -1, 1))
    const rollRate = clamp((targetBank - bank) * TUNING.rollP, -TUNING.maxRollRate, TUNING.maxRollRate)
    const pitchRate = clamp((targetPitch - pitch) * TUNING.pitchP, -TUNING.maxPitchRate, TUNING.maxPitchRate)
    this.applyRates(pitchRate, rollRate, 0, dt)
    this.bank = bank
    this.vel.copy(this.fwd).multiplyScalar(TUNING.launchSpeed)
  }

  private bodyAxes() {
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat)
    this.right.set(1, 0, 0).applyQuaternion(this.quat)
    this.up.set(0, 1, 0).applyQuaternion(this.quat)
  }

  private applyRates(pitchRate: number, rollRate: number, yawRate: number, dt: number) {
    // Body-frame rotations. Forward is -Z, so a positive (right-wing-down) roll is
    // a negative rotation about +Z, and a nose-right yaw is negative about +Y.
    this.dq.setFromAxisAngle(X_AXIS, pitchRate * dt)
    this.quat.multiply(this.dq)
    this.dq.setFromAxisAngle(Z_AXIS, -rollRate * dt)
    this.quat.multiply(this.dq)
    this.dq.setFromAxisAngle(Y_AXIS, -yawRate * dt)
    this.quat.multiply(this.dq)
    this.quat.normalize()
    this.bodyAxes()
  }

  private step(dt: number) {
    const T = TUNING
    this.bodyAxes()

    // --- air ---------------------------------------------------------------
    sampleAir(this.air, this.hf, this.pos.x, this.pos.y, this.pos.z, this.airVel)
    this.airLift = this.airVel.y

    this.relVel.set(this.vel.x - this.airVel.x, this.vel.y - this.airVel.y, this.vel.z - this.airVel.z)
    const V = this.relVel.length()
    this.airspeed = V

    // --- angles ------------------------------------------------------------
    this.invQuat.copy(this.quat).invert()
    this.bodyRel.copy(this.relVel).applyQuaternion(this.invQuat)
    const alpha = V > 0.5 ? Math.atan2(-this.bodyRel.y, -this.bodyRel.z) : 0
    const beta = V > 0.5 ? Math.atan2(this.bodyRel.x, -this.bodyRel.z) : 0
    this.alpha = alpha

    // --- lift coefficient, with a soft stall -------------------------------
    const absA = Math.abs(alpha)
    const sgnA = Math.sign(alpha)
    const clPeak = T.clAlpha * T.alphaStall
    let cl: number
    let stall = 0
    if (absA <= T.alphaStall) {
      cl = T.clAlpha * alpha
    } else {
      const over = absA - T.alphaStall
      const decay = Math.exp(-over / T.stallDecay)
      cl = sgnA * clPeak * (T.stallResidual + (1 - T.stallResidual) * decay)
      stall = 1 - decay
    }
    // Beyond 90 deg of AoA the wing is a flat plate going backwards; kill lift.
    if (absA > Math.PI / 2) cl *= Math.max(0, (Math.PI - absA) / (Math.PI / 2))
    this.stallFactor = stall

    const cd =
      T.cd0 +
      T.inducedK * cl * cl +
      T.stallCd * stall +
      T.cdSpeed * ((V * V) / 2500) +
      T.cdBeta * beta * beta

    // --- forces ------------------------------------------------------------
    const q = 0.5 * T.airDensity * V * V * T.wingArea
    this.force.set(0, -T.gravity * T.mass, 0)

    if (V > 0.5) {
      // Lift acts perpendicular to the relative wind, in the plane containing the
      // wing's span normal. Banking tilts it, and the horizontal component is what
      // turns the aircraft — no separate turn kinematics needed.
      this.liftDir.crossVectors(this.right, this.relVel)
      const len = this.liftDir.length()
      if (len > 1e-4) {
        this.liftDir.multiplyScalar(1 / len)
        this.force.addScaledVector(this.liftDir, q * cl)
      }
      this.force.addScaledVector(this.relVel, (-q * cd) / V)
    }

    this.vel.addScaledVector(this.force, dt / T.mass)
    this.pos.addScaledVector(this.vel, dt)
    this.time += dt

    // --- control -----------------------------------------------------------
    const authority = Math.min(1, V / T.authoritySpeed) ** 2
    const bank = Math.atan2(-this.right.y, this.up.y)
    const pitch = Math.asin(clamp(this.fwd.y, -1, 1))
    this.bank = bank

    const targetBank = this.smoothed.x * T.maxBank
    const targetPitch = (T.invertPitch ? -this.smoothed.y : this.smoothed.y) * T.maxPitch

    let rollRate = clamp((targetBank - bank) * T.rollP, -T.maxRollRate, T.maxRollRate) * authority
    let pitchRate = clamp((targetPitch - pitch) * T.pitchP, -T.maxPitchRate, T.maxPitchRate) * authority
    const yawRate = beta * T.weathervane * authority

    // AoA limiter. Without it, a hard pull out of a dive rotates the nose faster
    // than the flight path can follow, the wing departs, and the stall break
    // below cancels the pull — which makes the dive-then-flare trade, the core
    // skill of the game, physically impossible. Tapering the command near the
    // stall means yanking the pointer gives maximum performance instead.
    //
    // It fades out below stall speed on purpose. Protecting the slow case too
    // would turn every over-flare into a harmless mush, and the design calls for
    // a stall you can feel: nose drops, lift collapses, recoverable.
    const clMax = T.clAlpha * T.alphaStall
    const vStall = Math.sqrt((T.mass * T.gravity) / (0.5 * T.airDensity * T.wingArea * clMax))
    const protection = clamp((V - vStall) / (0.35 * vStall), 0, 1)
    if (protection > 0) {
      const limit = T.alphaStall * T.aoaLimit
      const band = T.alphaStall * 0.25
      const taper = pitchRate > 0 ? clamp((limit - alpha) / band, 0, 1) : clamp((limit + alpha) / band, 0, 1)
      pitchRate *= 1 - protection * (1 - taper)
    }

    // A stalled wing still drops its nose regardless of what the pilot asks for —
    // the limiter only governs the command, it does not repeal aerodynamics.
    if (stall > 0) {
      const bite = Math.min(1, V / 12)
      pitchRate -= T.stallPitchDown * stall * bite * (sgnA >= 0 ? 1 : -1)
    }
    // Slight roll damping so hard reversals do not ring.
    rollRate *= 1 - 0.25 * stall

    this.applyRates(pitchRate, rollRate, yawRate, dt)

    // --- world -------------------------------------------------------------
    this.vario = this.vel.y
    const ground = surfaceHeight(this.hf, this.pos.x, this.pos.z)
    this.aglHeight = this.pos.y - ground
    const dx = this.pos.x - this.launchPos.x
    const dz = this.pos.z - this.launchPos.z
    this.distance = Math.sqrt(dx * dx + dz * dz)

    if (this.pos.y <= ground + T.crashClearance) {
      this.pos.y = ground + T.crashClearance
      this.land()
      return
    }
    if (Math.abs(this.pos.x) > HALF_WORLD * 0.985 || Math.abs(this.pos.z) > HALF_WORLD * 0.985) {
      this.land()
    }
  }

  private land() {
    this.phase = 'down'
    this.vel.set(0, 0, 0)
    this.path.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
  }
}
