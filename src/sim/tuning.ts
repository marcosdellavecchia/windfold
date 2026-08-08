/**
 * Every number that decides how flying feels. Mutable on purpose — the in-game
 * tuning panel (press T) writes straight into this object so the flight model can
 * be iterated without a reload.
 *
 * The aero constants are arcade-scaled, not a real paper dart: mass and wing area
 * are chosen so trim speed lands around 22 m/s and stall around 14 m/s, which is
 * the range where banking reads well on screen.
 */
export const TUNING = {
  // --- airframe -----------------------------------------------------------
  mass: 1.0, // kg
  wingArea: 0.055, // m^2
  airDensity: 1.225, // kg/m^3
  gravity: 9.81,

  // --- lift ---------------------------------------------------------------
  /** dCL/dAoA, per radian. */
  clAlpha: 5.0,
  /** AoA where the wing lets go, radians (~16 deg). */
  alphaStall: 0.28,
  /** How fast lift collapses past the stall. Larger = gentler. */
  stallDecay: 0.3,
  /** Residual lift fraction deep in the stall. */
  stallResidual: 0.32,

  // --- drag ---------------------------------------------------------------
  cd0: 0.048,
  /** Induced drag factor, multiplies CL^2. */
  inducedK: 0.07,
  /** Extra drag added by a stalled wing. */
  stallCd: 0.5,
  /** Quadratic high-speed drag, referenced to 50 m/s. Caps terminal velocity. */
  cdSpeed: 0.02,
  /** Sideslip drag — punishes flying sideways. */
  cdBeta: 0.9,

  // --- control ------------------------------------------------------------
  /** Full pointer deflection, radians. */
  maxBank: 1.31, // 75 deg
  maxPitch: 0.96, // 55 deg
  rollP: 3.4,
  pitchP: 3.2,
  maxRollRate: 2.9, // rad/s
  maxPitchRate: 1.7, // rad/s
  /** Airspeed at which control authority is full. Below this the plane goes mushy. */
  authoritySpeed: 16,
  /** How hard the tail pulls the nose back into the airflow. */
  weathervane: 2.4,
  /** Nose-drop torque past the stall. This is what makes a stall recoverable. */
  stallPitchDown: 2.2,
  /**
   * Fraction of the stall AoA the pitch command is allowed to reach. Below 1 the
   * aircraft can be flown to the edge of the envelope but not through it.
   */
  aoaLimit: 0.94,
  /** Pointer smoothing, 0..1 per 60 Hz frame. Lower = heavier feel. */
  inputSmoothing: 0.22,
  invertPitch: false,

  // --- launch -------------------------------------------------------------
  launchSpeed: 26,
  /**
   * Release height above the mean terrain *along the route ahead* — not above the
   * ground directly below. Measuring it this way is what stops a launch peak with
   * a valley in front of it from handing out free distance. At a ~5:1 glide this
   * buys roughly 1.3 km before the first thermal has to be found.
   */
  launchAboveRoute: 260,
  /** Floor on release height above the ground below, so the plane never starts buried. */
  launchMinClearance: 110,
  /** Nose-down angle at release, radians. */
  launchPitch: -0.14,

  // --- world --------------------------------------------------------------
  /** Distance below the surface that counts as contact. */
  crashClearance: 1.2,

  // --- camera -------------------------------------------------------------
  camDistance: 16,
  camHeight: 4.2,
  /** Where the camera eases to once the flight is over, so you can see the crash. */
  camCrashDistance: 46,
  camCrashHeight: 22,
  camLag: 5.5,
  camRoll: 0.5,
  camLookAhead: 8,
  fov: 68,
  /** Extra FOV at high speed, for the sense of rush. */
  fovSpeedGain: 16,
}

export type Tuning = typeof TUNING

const DEFAULTS: Tuning = { ...TUNING }

export function resetTuning() {
  Object.assign(TUNING, DEFAULTS)
}
