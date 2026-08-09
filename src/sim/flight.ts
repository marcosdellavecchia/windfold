import { Quaternion, Vector3 } from 'three'
import { TUNING } from './tuning'
import { sampleAir, type Air, type Vec3Like } from './air'
import { clamp, surfaceHeight, sampleHeight, sampleGradient, HALF_WORLD, type Heightfield } from './terrain'

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

/**
 * Debug turbo. See `Flight.turboStep`.
 *
 * 165 m/s crosses the 12 km map in about seventy seconds, which is fast enough
 * to be worth doing and slow enough that the terrain streaming keeps up — the
 * trees rescatter every 230 m of travel, so at much more than this the scatter
 * runs several times a second and the frame budget goes with it.
 */
const TURBO_SPEED = 165
/** Steeper than the real aircraft is allowed: this one cannot stall or spin. */
const TURBO_BANK = 1.15
const TURBO_PITCH = 0.85
const TURBO_RATE = 2.6
/** How hard bank pulls the heading round. Not a lift calculation — just a turn. */
const TURBO_TURN = 1.15
/** Metres held above the ground by the floor, so the plane clears its own trees. */
const TURBO_CLEARANCE = 45

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
  /**
   * Path distance flown, not displacement from the launch.
   *
   * Displacement was the original score and it fought the game's own core
   * mechanic: circling in a thermal — the most satisfying thing the air offers —
   * froze the number, so the scoring was telling the player the soaring was
   * wasted time. Path distance keeps ticking through a climb, the way Tiny Wings
   * and Alto's count the journey, and it removes the map radius as a hard ceiling
   * on the score. It is not farmable: thermal tops, ambient sink and the day's
   * fixed lift budget bound how long the path can get.
   */
  distance = 0
  /** True when the flight ended in a gentle touchdown rather than a crash. */
  landed = false
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

  /**
   * Debug: hold the mouse button to cross the map at speed. Set from outside,
   * once per frame, before `update`. Reachable only with `?cheats=on` — see
   * `game/cheats.ts` for why it is switched on rather than discovered.
   *
   * A separate integration rather than a multiplier on the real one. Scaling the
   * aerodynamics would have to answer what a 160 m/s paper plane does about
   * stall, induced drag and a thermal, and every answer is a change to the flight
   * model — which is the one thing a debug affordance must not touch. This skips
   * the model entirely for as long as it is held and hands back a normally-flying
   * aircraft the moment it is released.
   */
  turbo = false
  /**
   * Whether turbo was ever engaged on this flight. Latched, and never cleared
   * except by `reset`.
   *
   * A flight that crossed six kilometres in forty seconds is not a score. Without
   * this it would be written to the day's record and beaconed to the presence
   * layer, where it would sit in a shared odometer that every other player reads
   * — so the flight is marked at the moment of the first press and the scoring
   * path checks it on landing.
   */
  cheated = false

  private readonly launchPos = new Vector3()
  private launchHeading = 0
  private accumulator = 0
  private recordTimer = 0
  private smoothed: FlightInput = { x: 0, y: 0 }

  // Scratch, reused every step to keep the hot loop allocation-free.
  private readonly airVel: Vec3Like = { x: 0, y: 0, z: 0 }
  private readonly grad = { x: 0, z: 0 }
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
    this.landed = false
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

    if (this.turbo) {
      this.cheated = true
      this.accumulator = 0
      this.turboStep(dt)
      this.recordTimer += dt
      if (this.recordTimer >= 1 / RECORD_HZ) {
        this.recordTimer = 0
        this.path.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
      }
      return
    }

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

  /**
   * Debug flight: kinematic, not aerodynamic. The nose points where the pointer
   * says and the aircraft goes that way at TURBO_SPEED, and that is all of it.
   *
   * Nothing here can end a flight. The ground is a floor rather than a collision
   * — at this speed the terrain arrives faster than anyone can pull up, and a
   * tool for looking at the map is useless if looking at the map kills you — and
   * the border is a wall rather than an ending, so the map is a room to fly
   * around in.
   *
   * `distance` is deliberately not advanced. It is the score, and none of this is
   * scoring; leaving it alone means a turbo hop to a far corner followed by a
   * real glide still measures the glide.
   */
  private turboStep(dt: number) {
    const T = TUNING
    this.bodyAxes()

    // Steering: the same pointer-to-attitude mapping the real model uses, run
    // straight rather than through the control authority that airspeed earns.
    const targetBank = this.smoothed.x * TURBO_BANK
    const targetPitch = (T.invertPitch ? -this.smoothed.y : this.smoothed.y) * TURBO_PITCH
    const bank = Math.atan2(-this.right.y, this.up.y)
    const pitch = Math.asin(clamp(this.fwd.y, -1, 1))
    const rollRate = clamp((targetBank - bank) * T.rollP, -TURBO_RATE, TURBO_RATE)
    const pitchRate = clamp((targetPitch - pitch) * T.pitchP, -TURBO_RATE, TURBO_RATE)
    // Bank turns the heading, so a roll actually goes somewhere — without this
    // the aircraft slides sideways across the map facing forwards.
    const yawRate = Math.sin(bank) * TURBO_TURN
    this.applyRates(pitchRate, rollRate, yawRate, dt)
    this.bank = bank

    this.vel.copy(this.fwd).multiplyScalar(TURBO_SPEED)
    this.pos.addScaledVector(this.vel, dt)
    this.time += dt

    // Floor, not collision.
    const ground = surfaceHeight(this.hf, this.pos.x, this.pos.z) + TURBO_CLEARANCE
    if (this.pos.y < ground) this.pos.y = ground
    // Wall, not ending.
    const edge = HALF_WORLD * 0.97
    this.pos.x = clamp(this.pos.x, -edge, edge)
    this.pos.z = clamp(this.pos.z, -edge, edge)

    this.airspeed = TURBO_SPEED
    this.vario = this.vel.y
    this.alpha = 0
    this.stallFactor = 0
    this.airLift = 0
    this.aglHeight = this.pos.y - sampleHeight(this.hf, this.pos.x, this.pos.z)
  }

  /**
   * Hand back a normally-flying aircraft. Called when the button comes up.
   *
   * Dropping out of turbo at 160 m/s would leave the model holding an airspeed it
   * has no answer for — the drag term alone would haul the nose through a
   * manoeuvre nobody asked for. Re-entering at launch speed puts the plane
   * wherever it was flown to, in the state it would have been in had it been
   * launched from there, which is exactly what a look-around tool should leave
   * behind.
   */
  endTurbo() {
    if (this.phase !== 'flying') return
    this.bodyAxes()
    this.vel.copy(this.fwd).multiplyScalar(TUNING.launchSpeed)
    this.airspeed = TUNING.launchSpeed
    this.accumulator = 0
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
    // Ground track, not 3D arc length: a climb scores the circles it flies, not
    // the height it gains — height is banked energy, and it pays out as track
    // when it is spent.
    this.distance += Math.hypot(this.vel.x, this.vel.z) * dt

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

    if (this.pos.y <= ground + T.crashClearance) {
      this.pos.y = ground + T.crashClearance
      // A landing, not a crash, when the touchdown is flared, level, and on
      // ground that could take it. Trim sink is ~2.1 m/s, so gliding straight
      // into the ground does not qualify — the flare that converts speed into a
      // soft arrival is the same energy trade the whole game is built on, asked
      // for one more time at the very end. Water counts: its surface is flat
      // even where the seabed under it is not.
      const onWater = this.hf.hasWater && sampleHeight(this.hf, this.pos.x, this.pos.z) < this.hf.waterLevel
      let slope = 0
      if (!onWater) {
        sampleGradient(this.hf, this.pos.x, this.pos.z, this.grad)
        slope = Math.hypot(this.grad.x, this.grad.z)
      }
      this.landed = this.vel.y > -2.0 && Math.abs(this.bank) < 0.35 && slope < 0.35
      this.land()
      return
    }
    if (Math.abs(this.pos.x) > HALF_WORLD * 0.985 || Math.abs(this.pos.z) > HALF_WORLD * 0.985) {
      // Drifting off the edge of the world is an ending, not an arrival.
      this.landed = false
      this.land()
    }
  }

  private land() {
    this.phase = 'down'
    this.vel.set(0, 0, 0)
    this.path.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z })
  }
}
