import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Group, MathUtils, Vector3, type PerspectiveCamera } from 'three'
import type { World } from '../sim/world'
import { Flight } from '../sim/flight'
import { TUNING } from '../sim/tuning'
import { surfaceHeight } from '../sim/terrain'
import { rgbToHex } from '../sim/palette'
import { readAxis, setCommitHandler } from '../input'
import { flushHud, writeHud } from '../state'
import { Terrain } from './Terrain'
import { Water } from './Water'
import { Clouds } from './Clouds'
import { Trees } from './Trees'
import { Birds } from './Birds'
import { Motes } from './Motes'
import { FOG_DENSITY } from './atmosphere'
import { Sky } from './Sky'
import { Thermals } from './Thermals'
import { PaperPlane } from './PaperPlane'
import { Trail } from './Trail'

export function Scene({ world }: { world: World }) {
  const planeRef = useRef<Group>(null)
  const trail = useMemo(() => new Trail([0.55, 0.9, 1.0]), [])
  useEffect(() => () => trail.dispose(), [trail])

  const pal = world.palette

  return (
    <>
      <fogExp2 attach="fog" args={[rgbToHex(pal.fog), FOG_DENSITY]} />
      <ambientLight color={rgbToHex(pal.ambient)} intensity={0.5} />
      <hemisphereLight
        color={rgbToHex(pal.skyHorizon)}
        groundColor={rgbToHex(pal.low)}
        intensity={0.75}
      />
      <directionalLight
        color={rgbToHex(pal.sunLight)}
        intensity={2.1}
        position={[world.sunDir.x * 3000, world.sunDir.y * 3000, world.sunDir.z * 3000]}
      />

      <Sky world={world} />
      <Terrain world={world} />
      <Trees world={world} />
      <Water world={world} />
      <Thermals world={world} />
      <Clouds world={world} />
      <Birds world={world} />
      <Motes world={world} />
      <primitive object={trail.object} />
      <PaperPlane ref={planeRef} world={world} />

      <Simulation world={world} planeRef={planeRef} trail={trail} />
    </>
  )
}

interface SimProps {
  world: World
  planeRef: React.RefObject<Group | null>
  trail: Trail
}

function Simulation({ world, planeRef, trail }: SimProps) {
  const camera = useThree((s) => s.camera)

  const flight = useMemo(
    () => new Flight(world.heightfield, world.air, world.launch),
    [world],
  )

  const stats = useRef({ best: 0, attempts: 0 })
  const prevPhase = useRef(flight.phase)
  const cam = useRef({
    pos: new Vector3(),
    fwd: new Vector3(),
    up: new Vector3(0, 1, 0),
    ready: false,
  })

  useEffect(() => {
    setCommitHandler(() => {
      if (flight.phase === 'ready') {
        flight.launch()
        stats.current.attempts++
      } else if (flight.phase === 'down') {
        // Instant restart. The world is already resident, so this is a state
        // reset and nothing more — no fade, no confirmation.
        flight.reset()
        trail.clear()
        flight.launch()
        stats.current.attempts++
        writeHud({ newBest: false })
      }
    })
    return () => setCommitHandler(() => {})
  }, [flight, trail])

  // Reset the session when the world changes (dev-time seed switching).
  useEffect(() => {
    stats.current = { best: 0, attempts: 0 }
    cam.current.ready = false
    trail.clear()
  }, [world, trail])

  const scratch = useMemo(
    () => ({
      fwd: new Vector3(),
      up: new Vector3(),
      tilt: new Vector3(),
      flat: new Vector3(),
      desired: new Vector3(),
      look: new Vector3(),
    }),
    [],
  )

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 15)
    const axis = readAxis(dt)

    flight.update(dt, axis)

    if (flight.phase === 'flying') {
      trail.update(dt, flight.pos.x, flight.pos.y, flight.pos.z)
    }

    // --- resolve the end of a flight ---------------------------------------
    const phaseChanged = prevPhase.current !== flight.phase
    if (phaseChanged) {
      if (flight.phase === 'down') {
        const d = flight.distance
        const isBest = d > stats.current.best
        if (isBest) stats.current.best = d
        writeHud({ newBest: isBest, lastDistance: d })
      }
      prevPhase.current = flight.phase
    }

    // --- plane transform ----------------------------------------------------
    const plane = planeRef.current
    if (plane) {
      plane.position.copy(flight.pos)
      plane.quaternion.copy(flight.quat)
    }

    // --- camera -------------------------------------------------------------
    scratch.fwd.set(0, 0, -1).applyQuaternion(flight.quat)
    scratch.up.set(0, 1, 0).applyQuaternion(flight.quat)

    // Once the flight is over, ease out to a wider, level vantage. Holding the
    // chase position leaves the camera pressed against the hillside the player
    // just hit, and the results screen renders over a wall of flat green.
    const down = flight.phase === 'down'
    const distance = down ? TUNING.camCrashDistance : TUNING.camDistance
    const height = down ? TUNING.camCrashHeight : TUNING.camHeight

    // Blend the aircraft's own up toward world up: the horizon tilts with the
    // roll, which is what makes banking read on screen, but not so far that the
    // world turns upside down in a hard turn.
    scratch.tilt.set(0, 1, 0).lerp(scratch.up, down ? 0 : TUNING.camRoll).normalize()

    const c = cam.current
    const lag = 1 - Math.exp(-TUNING.camLag * dt)
    if (!c.ready) {
      c.fwd.copy(scratch.fwd)
      c.up.copy(scratch.tilt)
    } else {
      c.fwd.lerp(scratch.fwd, lag).normalize()
      c.up.lerp(scratch.tilt, lag).normalize()
    }

    if (down) {
      // Flatten the offset axis so the crash is viewed roughly level, with sky in
      // frame. Backing straight off a nose-in impact puts the camera above the
      // aircraft staring down at the slope it hit.
      scratch.flat.set(c.fwd.x, 0, c.fwd.z)
      if (scratch.flat.lengthSq() < 1e-6) scratch.flat.set(0, 0, -1)
      scratch.flat.normalize()
      scratch.desired
        .copy(flight.pos)
        .addScaledVector(scratch.flat, -distance)
        .addScaledVector(scratch.tilt, height)
    } else {
      scratch.desired
        .copy(flight.pos)
        .addScaledVector(c.fwd, -distance)
        .addScaledVector(c.up, height)
    }

    // Never let the camera sink into the hill behind the player.
    const clearance = down ? 16 : 3.5
    const floor = surfaceHeight(world.heightfield, scratch.desired.x, scratch.desired.z) + clearance
    if (scratch.desired.y < floor) scratch.desired.y = floor

    if (!c.ready) {
      c.pos.copy(scratch.desired)
      c.ready = true
    } else {
      c.pos.lerp(scratch.desired, lag)
    }

    camera.position.copy(c.pos)
    camera.up.copy(c.up)
    // Aim off the aircraft's true forward, not the lagged one. The position lag
    // gives the camera its trailing feel; letting the aim lag as well lets the
    // plane swing out of frame in a hard dive.
    scratch.look.copy(flight.pos).addScaledVector(scratch.fwd, down ? 0 : TUNING.camLookAhead)
    camera.lookAt(scratch.look)

    const rush = MathUtils.clamp((flight.airspeed - 22) / 45, 0, 1)
    const fov = TUNING.fov + TUNING.fovSpeedGain * rush
    const persp = camera as PerspectiveCamera
    if (Math.abs(persp.fov - fov) > 0.05) {
      persp.fov = fov
      persp.updateProjectionMatrix()
    }

    // --- hud ----------------------------------------------------------------
    writeHud({
      phase: flight.phase,
      distance: flight.distance,
      best: stats.current.best,
      attempts: stats.current.attempts,
      altitude: flight.aglHeight,
      airspeed: flight.airspeed,
      vario: flight.vario,
      airLift: flight.airLift,
      stall: flight.stallFactor,
    })
    flushHud(dt, phaseChanged)
  })

  return null
}
