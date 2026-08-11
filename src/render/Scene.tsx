import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three'
import type { World } from '../sim/world'
import { Flight } from '../sim/flight'
import { sampleGradient } from '../sim/terrain'
import { noteFlight, noteLaunch, recordOf, savedState, writeMarker } from '../game/persist'
import { postFlight, type RestPoint } from '../game/net'
import { callsign } from '../game/callsign'
import { Ghosts, type GhostData } from './Ghosts'
import { RestingPlanes } from './RestingPlanes'
import { TUNING } from '../sim/tuning'
import { surfaceHeight } from '../sim/terrain'
import { rgbToHex } from '../sim/palette'
import { isTurboHeld, readAxis, setCommitHandler } from '../input'
import { flushHud, writeHud } from '../state'
import { Terrain } from './Terrain'
import { Water } from './Water'
import { Streams } from './Streams'
import { Clouds } from './Clouds'
import { Trees } from './Trees'
import { Birds } from './Birds'
import { Herds } from './Herds'
import { Landmarks } from './Landmarks'
import { Motes } from './Motes'
import { FOG_DENSITY } from './atmosphere'
import { Sky } from './Sky'
import { Thermals } from './Thermals'
import { PaperPlane, buildDartShadow } from './PaperPlane'
import { Trail } from './Trail'

export function Scene({
  world,
  par,
  onWorldReady,
  rests,
  onFlightRested,
}: {
  world: World
  par: number
  /** Fired on the first rendered frame of each world — the veil lifts on it. */
  onWorldReady?: () => void
  /** Where other players' flights came to rest, from the presence layer. */
  rests?: RestPoint[] | null
  /** Reports this player's finished flight so it joins the drift at once. */
  onFlightRested?: (rest: RestPoint, distance: number) => void
}) {
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
      <Streams world={world} />
      <Thermals world={world} />
      <Clouds world={world} />
      <Birds world={world} />
      <Herds world={world} planeRef={planeRef} />
      <Landmarks world={world} />
      <RestingPlanes world={world} rests={rests ?? null} />
      <Motes world={world} />
      <primitive object={trail.object} />
      <PaperPlane ref={planeRef} world={world} />

      <Simulation
        world={world}
        par={par}
        planeRef={planeRef}
        trail={trail}
        onWorldReady={onWorldReady}
        onFlightRested={onFlightRested}
      />
    </>
  )
}

interface SimProps {
  world: World
  par: number
  planeRef: React.RefObject<Group | null>
  trail: Trail
  onWorldReady?: () => void
  onFlightRested?: (rest: RestPoint, distance: number) => void
}

/** How many previous attempts stay on screen, besides the best. */
const GHOST_ATTEMPTS = 5

/**
 * Extra degrees of field of view at full debug turbo, on top of the speed gain.
 * Deliberately restrained: turbo already pins the speed gain on its own, so this
 * only has to say "and this is not normal flight". Pushed further the lens starts
 * bending the horizon and the frame reads as a fisheye rather than as speed.
 */
const TURBO_FOV = 5

function Simulation({ world, par, planeRef, trail, onWorldReady, onFlightRested }: SimProps) {
  const camera = useThree((s) => s.camera)

  const flight = useMemo(
    () => new Flight(world.heightfield, world.air, world.launch),
    [world],
  )

  const stats = useRef({ best: 0, attempts: 0 })
  // The session's saved state — records per world, the in-flight marker.
  // One instance, shared with the HUD's share card.
  const saved = useMemo(() => savedState(), [])
  const markerTimer = useRef(0)
  /** Eased 0..1 turbo, for the lens. See the fov block below. */
  const turboEase = useRef(0)
  const [ghosts, setGhosts] = useState<GhostData>({ attempts: [], best: null })

  // The plane's shadow: a soft dark blob hugging the terrain below. Not a
  // shadow map — a disc that fades in under ~70 m of altitude, which is
  // exactly when height matters: skimming a ridge or timing a flare, the
  // shadow reads your clearance better than the HUD number does.
  const blob = useMemo(() => {
    const m = new Mesh(
      buildDartShadow(),
      new MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // The alpha in the geometry's colour attribute is what softens the edge.
        vertexColors: true,
      }),
    )
    m.frustumCulled = false
    return m
  }, [])
  useEffect(
    () => () => {
      blob.geometry.dispose()
      ;(blob.material as MeshBasicMaterial).dispose()
    },
    [blob],
  )
  const prevPhase = useRef(flight.phase)
  const cam = useRef({
    pos: new Vector3(),
    fwd: new Vector3(),
    up: new Vector3(0, 1, 0),
    ready: false,
  })

  useEffect(() => {
    const launch = () => {
      // Counted and persisted before the first physics tick — bailing out
      // must never be cheaper than crashing.
      noteLaunch(saved, world.day)
      stats.current.attempts = recordOf(saved, world.day).attempts
    }
    setCommitHandler(() => {
      if (flight.phase === 'ready') {
        flight.launch()
        launch()
      } else if (flight.phase === 'down') {
        // Instant restart. The world is already resident, so this is a state
        // reset and nothing more — no fade, no confirmation.
        flight.reset()
        trail.clear()
        flight.launch()
        launch()
        writeHud({ newBest: false })
      }
    })
    return () => setCommitHandler(() => {})
  }, [flight, trail, world, saved])

  // A world change loads that world's record — the best and attempt count of
  // a linked or revisited world carry across sessions.
  useEffect(() => {
    const rec = recordOf(saved, world.day)
    stats.current = { best: rec.best, attempts: rec.attempts }
    writeHud({ best: rec.best, attempts: rec.attempts })
    cam.current.ready = false
    trail.clear()
    setGhosts({ attempts: [], best: null })
  }, [world, trail, saved])

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

  const reportedWorld = useRef<World | null>(null)

  useFrame((_, rawDt) => {
    // The first frame of a new world: everything heavy — heightfield, terrain
    // geometry, tree scatter — has already happened by the time this runs, so
    // this is the moment the between-worlds veil can safely lift.
    if (reportedWorld.current !== world) {
      reportedWorld.current = world
      onWorldReady?.()
    }

    const dt = Math.min(rawDt, 1 / 15)
    const axis = readAxis(dt)

    // Debug turbo, resolved once per frame just before the step it applies to.
    // The falling edge matters as much as the state: releasing the button has to
    // hand the aircraft back to the flight model at a speed the model can fly.
    const turbo = isTurboHeld() && flight.phase === 'flying'
    if (flight.turbo && !turbo) flight.endTurbo()
    flight.turbo = turbo

    flight.update(dt, axis)

    if (flight.phase === 'flying') {
      trail.update(dt, flight.pos.x, flight.pos.y, flight.pos.z)
      // The in-flight marker, on a slow cadence: if the page dies mid-flight,
      // the next load logs this attempt at its last recorded sample.
      markerTimer.current += dt
      if (markerTimer.current > 2) {
        markerTimer.current = 0
        writeMarker(world.day, flight.distance)
      }
    }

    // --- resolve the end of a flight ---------------------------------------
    const phaseChanged = prevPhase.current !== flight.phase
    if (phaseChanged) {
      if (flight.phase === 'down') {
        const d = flight.distance
        // A flight that used the debug turbo is not a flight. It never touches
        // the day's record and it never reaches the presence layer — that
        // odometer is shared with everyone else on this world, and a number put
        // there cannot be taken back out. The distance still shows on the HUD,
        // because the point of the tool is to go and look at things.
        const isBest = !flight.cheated && d > stats.current.best
        if (!flight.cheated) {
          if (isBest) stats.current.best = d
          noteFlight(saved, world.day, d, par, flight.landed, flight.path)
          // The flight joins the world's presence: a resting point and its
          // metres, anonymously. Fire-and-forget — the game never waits on it —
          // and optimistically, so your own paper is lying there on the next
          // attempt instead of after a reload.
          const sign = callsign()
          postFlight(world.day, flight.pos.x, flight.pos.z, d, flight.landed, sign)
          onFlightRested?.(
            { x: flight.pos.x, z: flight.pos.z, landed: flight.landed, name: sign, metres: Math.round(d) },
            d,
          )
        }
        writeHud({ newBest: isBest, lastDistance: d, landed: flight.landed })
        // Keep the flight's path as a ghost. `reset()` replaces the array rather
        // than clearing it, so holding the reference is safe. The best is held
        // separately from the rolling window, so it survives any number of
        // later attempts — it is the line the player is flying against.
        const path = flight.path
        setGhosts((g) => ({
          attempts: [...g.attempts, path].slice(-GHOST_ATTEMPTS),
          best: isBest ? path : g.best,
        }))
      }
      prevPhase.current = flight.phase
    }

    // --- plane transform ----------------------------------------------------
    const plane = planeRef.current
    if (plane) {
      plane.position.copy(flight.pos)
      plane.quaternion.copy(flight.quat)
    }

    // --- ground shadow --------------------------------------------------------
    const groundY = flight.pos.y - flight.aglHeight
    const fade = 1 - MathUtils.smoothstep(flight.aglHeight, 14, 70)
    const blobMat = blob.material as MeshBasicMaterial
    if (fade <= 0.02) {
      blobMat.opacity = 0
    } else {
      blobMat.opacity = 0.3 * fade
      blob.position.set(flight.pos.x, groundY + 0.4, flight.pos.z)

      // Lie on the slope rather than hovering flat inside it, *and* point where
      // the aircraft points. A disc needed only the first of those, which is why
      // it never had a heading — and why on short final, when the shadow is the
      // thing you are looking at, it was the one object in the frame admitting
      // it was a stand-in.
      sampleGradient(world.heightfield, flight.pos.x, flight.pos.z, GRAD)
      NORMAL.set(-GRAD.x, 1, -GRAD.z).normalize()
      // Heading flattened onto the slope: the component along the ground normal
      // is removed, so a climbing aircraft does not foreshorten its own shadow.
      SHADOW_Z.set(0, 0, 1).applyQuaternion(flight.quat)
      SHADOW_Z.addScaledVector(NORMAL, -SHADOW_Z.dot(NORMAL))
      if (SHADOW_Z.lengthSq() < 1e-6) SHADOW_Z.set(0, 0, 1)
      SHADOW_Z.normalize()
      SHADOW_X.crossVectors(NORMAL, SHADOW_Z)
      BASIS.makeBasis(SHADOW_X, NORMAL, SHADOW_Z)
      blob.quaternion.setFromRotationMatrix(BASIS)

      // Wider and softer as the plane climbs, like a real penumbra — and
      // narrower across the wings as it banks, because a shadow is the aircraft
      // seen from underneath and a knife-edge one has almost no width to cast.
      const grow = 0.95 + flight.aglHeight * 0.035
      blob.scale.set(grow * (0.34 + 0.66 * Math.abs(Math.cos(flight.bank))), grow, grow)
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
    // Debug turbo widens the lens past anything a real airspeed can reach — and
    // eases in and out rather than switching, because the punch on entry and the
    // settle on release are most of what sells the speed. Snapping straight to a
    // wide lens reads as a glitch rather than as acceleration. Turbo already
    // pins `rush` on its own, since it reports 165 m/s airspeed; this is the
    // part on top that says "and this is not normal flight".
    turboEase.current += ((flight.turbo ? 1 : 0) - turboEase.current) * (1 - Math.pow(0.004, dt))
    const fov = TUNING.fov + TUNING.fovSpeedGain * rush + TURBO_FOV * turboEase.current
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
      turbo: flight.turbo,
      cheated: flight.cheated,
    })
    flushHud(dt, phaseChanged)
  })

  return (
    <>
      <Ghosts data={ghosts} />
      <primitive object={blob} />
    </>
  )
}

const GRAD = { x: 0, z: 0 }
const NORMAL = new Vector3()
const SHADOW_X = new Vector3()
const SHADOW_Z = new Vector3()
const BASIS = new Matrix4()
