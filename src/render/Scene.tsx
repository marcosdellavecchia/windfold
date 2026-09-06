import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  DirectionalLight,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
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
import { LensFlare } from './LensFlare'
import { FOG_DENSITY, updateAirFog } from './atmosphere'
import { Sky } from './Sky'
import { ToneMapping } from './grade'
import { Thermals } from './Thermals'
import { PaperPlane, buildDartShadow } from './PaperPlane'
import { Trail } from './Trail'
import { GroundCover } from './GroundCover'
import { Formations } from './Formations'
import { Touchdown } from './Touchdown'
import { Routes } from './Routes'
import { flightVisual } from './presentation'
import { getSettings, useSettings } from '../game/settings'
import { ApproachReplay, setReplayHandler, type ReplayPose } from '../game/replay'
import { buildRoute, RouteProgress } from '../game/routes'
import { sampleHeight } from '../sim/terrain'

export function Scene({
  world,
  par,
  shadows,
  onWorldReady,
  rests,
  onFlightRested,
}: {
  world: World
  par: number
  /** Whether the sun casts real shadows — the renderer's one quality setting. */
  shadows?: boolean
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

  // The directional haze uniforms are shared by reference across every material
  // in the scene, so this one call re-points all of them at the new day.
  useMemo(() => updateAirFog(world), [world])

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
      <SunLight world={world} planeRef={planeRef} shadows={shadows ?? false} />

      <ToneMapping />
      <Sky world={world} />
      <Terrain world={world} />
      <Trees world={world} />
      <Formations world={world} />
      <GroundCover world={world} />
      <Touchdown world={world} />
      <Water world={world} />
      <Streams world={world} />
      <Thermals world={world} />
      <Clouds world={world} />
      <Birds world={world} />
      <Herds world={world} planeRef={planeRef} />
      <Landmarks world={world} />
      <RestingPlanes world={world} rests={rests ?? null} />
      <Motes world={world} />
      <LensFlare world={world} />
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

/** Half-extent of the shadow camera's box, metres. */
const SHADOW_HALF = 1600

/**
 * The day's sun, and — on hardware that can afford it — its shadows.
 *
 * Every day in this game has a deliberately low sun, chosen "for long shadows
 * and rim light", and then for a long time nothing cast one. This is the other
 * half of that decision: at 9-24 degrees a 25 m spruce throws a shadow up to
 * ten times its height, and a hillside of them is most of what a photograph of
 * evening country *is*.
 *
 * The shadow camera cannot cover a 12 km map at any usable resolution, so its
 * box rides along with the aircraft. Moving it naively makes every shadow edge
 * crawl as it re-rasterises — so the box only ever moves in whole shadow-map
 * texels, measured in the light's own plane. The world the map sees is then
 * pixel-identical between frames until the box takes a discrete one-texel
 * step, and the edges hold still.
 */
function SunLight({
  world,
  planeRef,
  shadows,
}: {
  world: World
  planeRef: React.RefObject<Group | null>
  shadows: boolean
}) {
  const ref = useRef<DirectionalLight>(null)
  const shadowMap = 2048

  // A fixed basis across the light's plane, for the texel snapping.
  const basis = useMemo(() => {
    const right = new Vector3(0, 1, 0).cross(world.sunDir).normalize()
    const up = new Vector3().crossVectors(world.sunDir, right).normalize()
    return { right, up }
  }, [world])

  useFrame(() => {
    const l = ref.current
    const p = planeRef.current
    if (!l || !p) return
    const texel = (2 * SHADOW_HALF) / shadowMap
    const s = SNAP.copy(p.position)
    const r = Math.round(s.dot(basis.right) / texel) * texel
    const u = Math.round(s.dot(basis.up) / texel) * texel
    const along = s.dot(world.sunDir)
    s.copy(basis.right)
      .multiplyScalar(r)
      .addScaledVector(basis.up, u)
      .addScaledVector(world.sunDir, along)
    l.target.position.copy(s)
    // The target is not in the scene graph, so its matrix is fed by hand.
    l.target.updateMatrixWorld()
    l.position.copy(s).addScaledVector(world.sunDir, 2600)
  })

  return (
    <directionalLight
      key={shadowMap}
      ref={ref}
      color={rgbToHex(world.palette.sunLight)}
      intensity={2.1}
      position={[world.sunDir.x * 3000, world.sunDir.y * 3000, world.sunDir.z * 3000]}
      castShadow={shadows}
      shadow-mapSize-width={shadowMap}
      shadow-mapSize-height={shadowMap}
      shadow-camera-left={-SHADOW_HALF}
      shadow-camera-right={SHADOW_HALF}
      shadow-camera-top={SHADOW_HALF}
      shadow-camera-bottom={-SHADOW_HALF}
      shadow-camera-near={200}
      shadow-camera-far={6000}
      // Normal bias rather than depth bias does the acne-prevention here.
      // Sized for the terrain, which self-shadows at grazing sun: five metres
      // along the normal of a 32 m cell is invisible from a glider, and it is
      // what lets the ground be in the shadow map at a nine-degree sun at all.
      // (A pale mottle on shaded alpine slopes was chased as acne and turned
      // out to be the scree paint — at this bias none has actually been seen.)
      shadow-bias={-0.0005}
      shadow-normalBias={5}
    />
  )
}

const SNAP = new Vector3()

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

  const settings = useSettings()
  const route = useMemo(() => buildRoute(world), [world])
  const progress = useMemo(() => new RouteProgress(), [world])
  const replay = useMemo(() => new ApproachReplay(), [world])
  const display = useMemo<ReplayPose>(() => ({ time: 0, position: new Vector3(), rotation: new Quaternion(), speed: 0, lift: 0, stall: 0 }), [])
  const beforeStep = useMemo(() => new Vector3(), [])
  const finishPose = useMemo(() => ({ age: 0, rotation: new Quaternion() }), [world])
  const cameraMotion = useRef({ lift: 0, time: 0, replaying: false })
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
    setReplayHandler((action) => {
      if (action === 'start' && flight.phase === 'down') replay.start()
      else replay.stop()
      cam.current.ready = false
      writeHud({ replaying: replay.active })
      flushHud(0, true)
    })
    return () => setReplayHandler(() => {})
  }, [flight, replay])

  useEffect(() => {
    const launch = () => {
      replay.reset()
      progress.reset()
      finishPose.age = 0
      replay.record(0, flight.pos, flight.quat, flight.airspeed, 0, 0)
      writeHud({ replaying: false, replayAvailable: false, routeGates: 0, routeLanding: false, landmarkFound: false })
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
  }, [flight, trail, world, saved, replay, progress, finishPose])

  // A world change loads that world's record — the best and attempt count of
  // a linked or revisited world carry across sessions.
  useEffect(() => {
    const rec = recordOf(saved, world.day)
    stats.current = { best: rec.best, attempts: rec.attempts }
    writeHud({ best: rec.best, attempts: rec.attempts })
    cam.current.ready = false
    prevPhase.current = flight.phase
    cameraMotion.current = { lift: 0, time: 0, replaying: false }
    writeHud({ phase: 'ready', replaying: false, replayAvailable: false, routeGates: 0, routeTotal: route.gates.length, routeTitle: route.title, routeHasLanding: route.landing !== null, routeLanding: false, landmarkFound: false, cheated: false, landed: false, newBest: false })
    trail.clear()
    setGhosts({ attempts: [], best: null })
  }, [world, trail, saved, flight, route])

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

    beforeStep.copy(flight.pos)
    const wasFlying = flight.phase === 'flying'
    flight.update(dt, axis)
    if (wasFlying && getSettings().routes) progress.update(route, world, beforeStep, flight)
    if (wasFlying) replay.record(flight.time, flight.pos, flight.quat, flight.airspeed, flight.airLift, flight.stallFactor, flight.phase === 'down')

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
        replay.finish()
        finishPose.age = 0
        sampleGradient(world.heightfield, flight.pos.x, flight.pos.z, GRAD)
        const water = world.heightfield.hasWater && sampleHeight(world.heightfield, flight.pos.x, flight.pos.z) < world.heightfield.waterLevel
        NORMAL.set(water ? 0 : -GRAD.x, 1, water ? 0 : -GRAD.z).normalize()
        SHADOW_Z.set(0, 0, 1).applyQuaternion(flight.quat)
        SHADOW_Z.addScaledVector(NORMAL, -SHADOW_Z.dot(NORMAL)).normalize()
        SHADOW_X.crossVectors(NORMAL, SHADOW_Z).normalize()
        BASIS.makeBasis(SHADOW_X, NORMAL, SHADOW_Z)
        finishPose.rotation.setFromRotationMatrix(BASIS)
        // Leaving the map is not an impact, and must not throw dust into the sky.
        if (flight.aglHeight < 3) {
          flightVisual.touchdown++
          flightVisual.impactPosition.copy(flight.pos)
          flightVisual.impactPosition.y = surfaceHeight(world.heightfield, flight.pos.x, flight.pos.z)
          flightVisual.impactWater = water
        }
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

    // Replay reads a separate pose buffer. The simulation remains down, so no
    // distance, attempts, route progress, or network submissions can be replayed.
    const replaying = replay.sample(dt, display)
    if (!replaying) {
      display.position.copy(flight.pos); display.rotation.copy(flight.quat)
      display.time = flight.time; display.speed = flight.airspeed; display.lift = flight.airLift; display.stall = flight.stallFactor
    }
    if (flight.phase === 'down' && !replaying && flight.aglHeight < 3) {
      finishPose.age += dt
      const settle = 1 - Math.exp(-finishPose.age * 3.5)
      display.position.y -= settle * 0.55
      if (flight.landed) display.rotation.slerp(finishPose.rotation, settle)
    }
    Object.assign(flightVisual, { phase: flight.phase, speed: display.speed, lift: display.lift, stall: display.stall, time: display.time, replaying, landed: flight.landed })
    flightVisual.position.copy(display.position); flightVisual.rotation.copy(display.rotation)
    const plane = planeRef.current
    if (plane) { plane.position.copy(display.position); plane.quaternion.copy(display.rotation) }

    // --- ground shadow --------------------------------------------------------
    const groundY = surfaceHeight(world.heightfield, display.position.x, display.position.z)
    const displayAltitude = display.position.y - groundY
    const fade = 1 - MathUtils.smoothstep(displayAltitude, 14, 70)
    const blobMat = blob.material as MeshBasicMaterial
    if (fade <= 0.02) {
      blobMat.opacity = 0
    } else {
      blobMat.opacity = 0.3 * fade
      blob.position.set(display.position.x, groundY + 0.4, display.position.z)

      // Lie on the slope rather than hovering flat inside it, *and* point where
      // the aircraft points. A disc needed only the first of those, which is why
      // it never had a heading — and why on short final, when the shadow is the
      // thing you are looking at, it was the one object in the frame admitting
      // it was a stand-in.
      sampleGradient(world.heightfield, display.position.x, display.position.z, GRAD)
      NORMAL.set(-GRAD.x, 1, -GRAD.z).normalize()
      // Heading flattened onto the slope: the component along the ground normal
      // is removed, so a climbing aircraft does not foreshorten its own shadow.
      SHADOW_Z.set(0, 0, 1).applyQuaternion(display.rotation)
      SHADOW_Z.addScaledVector(NORMAL, -SHADOW_Z.dot(NORMAL))
      if (SHADOW_Z.lengthSq() < 1e-6) SHADOW_Z.set(0, 0, 1)
      SHADOW_Z.normalize()
      SHADOW_X.crossVectors(NORMAL, SHADOW_Z)
      BASIS.makeBasis(SHADOW_X, NORMAL, SHADOW_Z)
      blob.quaternion.setFromRotationMatrix(BASIS)

      // Wider and softer as the plane climbs, like a real penumbra — and
      // narrower across the wings as it banks, because a shadow is the aircraft
      // seen from underneath and a knife-edge one has almost no width to cast.
      const grow = 0.95 + displayAltitude * 0.035
      blob.scale.set(grow * (0.34 + 0.66 * Math.abs(Math.cos(flight.bank))), grow, grow)
    }

    // --- camera -------------------------------------------------------------
    scratch.fwd.set(0, 0, -1).applyQuaternion(display.rotation)
    scratch.up.set(0, 1, 0).applyQuaternion(display.rotation)

    // Once the flight is over, ease out to a wider, level vantage. Holding the
    // chase position leaves the camera pressed against the hillside the player
    // just hit, and the results screen renders over a wall of flat green.
    const down = flight.phase === 'down' && !replaying
    const distance = down ? TUNING.camCrashDistance : replaying ? TUNING.camDistance * 1.35 : TUNING.camDistance
    const height = down ? TUNING.camCrashHeight : TUNING.camHeight

    // Blend the aircraft's own up toward world up: the horizon tilts with the
    // roll, which is what makes banking read on screen, but not so far that the
    // world turns upside down in a hard turn.
    scratch.tilt.set(0, 1, 0).lerp(scratch.up, down || settings.reducedMotion ? 0 : TUNING.camRoll).normalize()

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
        .copy(display.position)
        .addScaledVector(scratch.flat, -distance)
        .addScaledVector(scratch.tilt, height)
    } else {
      scratch.desired
        .copy(display.position)
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

    // Smooth lift entry has a small heave; stall buffet never changes steering.
    const motion = cameraMotion.current
    motion.time += dt
    motion.lift += (Math.max(0, display.lift) - motion.lift) * (1 - Math.exp(-dt * 2.5))
    camera.position.copy(c.pos)
    if (!down && !settings.reducedMotion) {
      camera.position.y += Math.min(motion.lift, 5) * 0.08 + Math.sin(motion.time * 27) * display.stall * 0.035
    }
    camera.position.y = Math.max(camera.position.y, surfaceHeight(world.heightfield, camera.position.x, camera.position.z) + clearance)
    camera.up.copy(c.up)
    // Aim off the aircraft's true forward, not the lagged one. The position lag
    // gives the camera its trailing feel; letting the aim lag as well lets the
    // plane swing out of frame in a hard dive.
    scratch.look.copy(display.position).addScaledVector(scratch.fwd, down ? 0 : TUNING.camLookAhead)
    camera.lookAt(scratch.look)

    const rush = MathUtils.clamp((display.speed - 22) / 45, 0, 1)
    // Debug turbo widens the lens past anything a real airspeed can reach — and
    // eases in and out rather than switching, because the punch on entry and the
    // settle on release are most of what sells the speed. Snapping straight to a
    // wide lens reads as a glitch rather than as acceleration. Turbo already
    // pins `rush` on its own, since it reports 165 m/s airspeed; this is the
    // part on top that says "and this is not normal flight".
    turboEase.current += ((flight.turbo ? 1 : 0) - turboEase.current) * (1 - Math.pow(0.004, dt))
    const fov = TUNING.fov + (settings.reducedMotion ? 0 : TUNING.fovSpeedGain * rush + TURBO_FOV * turboEase.current)
    const persp = camera as PerspectiveCamera
    if (Math.abs(persp.fov - fov) > 0.05) {
      persp.fov = fov
      persp.updateProjectionMatrix()
    }

    const target = route.gates[progress.gates]?.position ?? route.landing
    const targetX = target ? target.x - flight.pos.x : 0, targetZ = target ? target.z - flight.pos.z : 0
    // --- hud ----------------------------------------------------------------
    writeHud({
      phase: flight.phase,
      replaying,
      replayAvailable: replay.available,
      routeGates: progress.gates,
      routeLanding: progress.landed,
      landmarkFound: progress.discovered,
      routeDistance: target ? flight.pos.distanceTo(target) : 0,
      routeTurn: Math.atan2(scratch.fwd.x * targetZ - scratch.fwd.z * targetX, scratch.fwd.x * targetX + scratch.fwd.z * targetZ),
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
    flushHud(dt, phaseChanged || cameraMotion.current.replaying !== replaying)
    cameraMotion.current.replaying = replaying
  }, -1)

  return (
    <>
      <Ghosts data={ghosts} />
      {settings.routes && <Routes route={route} world={world} />}
      <primitive object={blob} />
    </>
  )
}

const GRAD = { x: 0, z: 0 }
const NORMAL = new Vector3()
const SHADOW_X = new Vector3()
const SHADOW_Z = new Vector3()
const BASIS = new Matrix4()
