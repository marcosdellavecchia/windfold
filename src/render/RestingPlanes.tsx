import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  CanvasTexture,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  Euler,
  Vector3,
} from 'three'
import type { World } from '../sim/world'
import type { RestPoint } from '../game/net'
import { mulberry32 } from '../sim/rng'
import { sampleGradient, sampleHeight, surfaceHeight } from '../sim/terrain'
import { buildDart } from './PaperPlane'
import { patchAirFog } from './atmosphere'

/**
 * Where other players' flights ended, as paper on the ground.
 *
 * This is the whole presence idea in one image: a beach below a popular
 * thermal run drifted with pale darts, an untouched far ridge still pristine —
 * the world reads where humanity flew the way snow reads footprints. Landed
 * planes sit upright, as if set down; crashed ones lie crumpled, part-buried.
 *
 * Signed paper carries its pilot's name in the world itself: a small label
 * floats above the dart — "Quiet Heron · 2.1 km" — fading in as you approach,
 * hidden behind hills like anything else that is really there. A pooled
 * handful of canvas sprites serves the nearest darts; four hundred permanent
 * text textures would cost real memory for words nobody is close enough to
 * read.
 *
 * One instanced draw call plus the label pool, capped. Planes that came to
 * rest on water are skipped — paper does not float for two weeks.
 */
const MAX = 400
const LABELS = 6
/**
 * Labels fade in inside this range of the camera, metres. Far enough that a
 * label is readable *ahead* of a low pass, not only directly underneath —
 * from cruise height a ground label within a short radius sits below the
 * frustum and is never seen at all.
 */
const LABEL_NEAR = 300
const LABEL_FAR = 560

interface PlacedRest {
  x: number
  y: number
  z: number
  name: string
  metres: number
}

export function RestingPlanes({ world, rests }: { world: World; rests: RestPoint[] | null }) {
  const camera = useThree((s) => s.camera)

  const built = useMemo(() => {
    const restMat = new MeshLambertMaterial({ vertexColors: true, side: 2 })
    patchAirFog(restMat)
    const mesh = new InstancedMesh(buildDart(), restMat, MAX)
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
    mesh.frustumCulled = false
    mesh.count = 0

    const group = new Group()
    group.add(mesh)
    const labels = Array.from({ length: LABELS }, () => makeLabel())
    for (const l of labels) group.add(l.sprite)

    return { mesh, group, labels }
  }, [])

  useEffect(
    () => () => {
      built.mesh.geometry.dispose()
      ;(built.mesh.material as MeshLambertMaterial).dispose()
      for (const l of built.labels) {
        l.texture.dispose()
        ;(l.sprite.material as MeshBasicMaterial).dispose()
        l.sprite.geometry.dispose()
      }
    },
    [built],
  )

  /** The named darts actually placed this world, for the label pool. */
  const placed = useRef<PlacedRest[]>([])
  const labelTimer = useRef(0)

  useEffect(() => {
    const hf = world.heightfield
    const pal = world.palette
    // Deterministic per world, so everyone sees the same drift of paper.
    const rng = mulberry32(world.seed ^ 0x9e57)
    const pos = new Vector3()
    const quat = new Quaternion()
    const scl = new Vector3()
    const mtx = new Matrix4()
    const eul = new Euler()
    const color = new Color()
    const grad = { x: 0, z: 0 }

    placed.current = []
    let n = 0
    for (const r of rests ?? []) {
      if (n >= MAX) break
      const ground = sampleHeight(hf, r.x, r.z)
      // Skip water arrivals; the sea keeps what it catches.
      if (hf.hasWater && ground < hf.waterLevel + 0.5) continue

      const yaw = rng() * Math.PI * 2
      const restY = surfaceHeight(hf, r.x, r.z)
      if (r.landed) {
        // Set down on the slope, wings level with the ground it stopped on.
        sampleGradient(hf, r.x, r.z, grad)
        eul.set(Math.atan2(grad.z, 1) * 0.6, yaw, -Math.atan2(grad.x, 1) * 0.6)
        pos.set(r.x, restY + 0.25, r.z)
      } else {
        // Crumpled: nosed in at some angle, one wing high, slightly buried.
        eul.set(-0.5 - rng() * 0.7, yaw, (rng() - 0.5) * 2.2)
        pos.set(r.x, restY + 0.05, r.z)
      }
      quat.setFromEuler(eul)
      const s = 0.8 + rng() * 0.25
      scl.set(s, s, s)
      mtx.compose(pos, quat, scl)
      built.mesh.setMatrixAt(n, mtx)

      // Weathered paper: white sun-bleached toward the day's ground colour, a
      // little more faded the longer it has notionally lain there.
      const fade = 0.55 + rng() * 0.35
      color.setRGB(
        0.92 * fade + pal.low[0] * (1 - fade) * 0.9,
        0.92 * fade + pal.low[1] * (1 - fade) * 0.9,
        0.9 * fade + pal.low[2] * (1 - fade) * 0.9,
      )
      built.mesh.setColorAt(n, color)
      n++

      if (r.name) {
        placed.current.push({ x: r.x, y: restY, z: r.z, name: r.name, metres: r.metres })
      }
    }

    built.mesh.count = n
    built.mesh.instanceMatrix.needsUpdate = true
    if (built.mesh.instanceColor) built.mesh.instanceColor.needsUpdate = true
  }, [built, world, rests])

  // Assign the label pool to the nearest signed darts, at a gentle cadence;
  // opacity follows the camera every frame so the fade never steps.
  useFrame((_, dt) => {
    labelTimer.current += dt
    if (labelTimer.current > 0.25) {
      labelTimer.current = 0
      FWD.set(0, 0, -1).applyQuaternion(camera.quaternion)
      assignLabels(built.labels, placed.current, camera.position, FWD)
    }
    for (const l of built.labels) {
      if (!l.key) continue
      const d = Math.hypot(l.sprite.position.x - camera.position.x, l.sprite.position.z - camera.position.z)
      const t = 1 - smooth((d - LABEL_NEAR) / (LABEL_FAR - LABEL_NEAR))
      ;(l.sprite.material as MeshBasicMaterial).opacity = t * 0.92
      l.sprite.visible = t > 0.02
      // A billboard by hand: the label always faces the camera. Sprites do
      // this for free but proved unreliable in this pipeline; a plane that
      // copies the camera's quaternion is the same picture through the same
      // battle-tested mesh path as everything else in the game.
      l.sprite.quaternion.copy(camera.quaternion)
    }
  })

  return <primitive object={built.group} />
}

interface Label {
  sprite: Mesh
  texture: CanvasTexture
  canvas: HTMLCanvasElement
  key: string
}

function makeLabel(): Label {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 96
  const texture = new CanvasTexture(canvas)
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    // Occluded by terrain like anything real, but never writing depth — two
    // overlapping labels should blend, not punch holes in each other. No fog:
    // a label close enough to read is too close to be hazed.
    depthTest: true,
    depthWrite: false,
    fog: false,
  })
  // World size: ~4.5 m of text height stays readable a few hundred metres
  // ahead and dissolves into the fade before it could clutter.
  const sprite = new Mesh(new PlaneGeometry((4.5 * 512) / 96, 4.5), material)
  sprite.visible = false
  sprite.frustumCulled = false
  return { sprite, texture, canvas, key: '' }
}

function assignLabels(labels: Label[], placed: PlacedRest[], eye: Vector3, fwd: Vector3) {
  // Nearest signed darts *ahead*, one label per pilot name — a pilot who
  // crashed five times in one meadow is one story, not five overlapping ones.
  // The forward test matters more than it looks: the nearest dart is usually
  // the one just flown past, and a pool that prefers nearest fills itself
  // with labels behind the camera, rendered perfectly where nobody looks.
  const byDist = placed
    .map((p) => ({ p, d: (p.x - eye.x) ** 2 + (p.z - eye.z) ** 2 }))
    .filter((e) => e.d < LABEL_FAR * LABEL_FAR)
    .filter((e) => (e.p.x - eye.x) * fwd.x + (e.p.z - eye.z) * fwd.z > 0)
    .sort((a, b) => a.d - b.d)

  const chosen: PlacedRest[] = []
  const seen = new Set<string>()
  for (const { p } of byDist) {
    if (seen.has(p.name)) continue
    seen.add(p.name)
    chosen.push(p)
    if (chosen.length >= labels.length) break
  }

  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    const p = chosen[i]
    if (!p) {
      l.key = ''
      l.sprite.visible = false
      continue
    }
    const key = `${p.name}|${p.x}|${p.z}`
    if (l.key !== key) {
      l.key = key
      drawLabel(l, p)
    }
    l.sprite.position.set(p.x, p.y + 9, p.z)
  }
}

function drawLabel(l: Label, p: PlacedRest) {
  const ctx = l.canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, 512, 96)
  const dist = p.metres >= 1000 ? `${(p.metres / 1000).toFixed(1)} km` : p.metres > 0 ? `${p.metres} m` : ''
  const text = dist ? `${p.name} · ${dist}` : p.name
  ctx.font = '600 40px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = 10
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.fillText(text, 256, 50, 500)
  l.texture.needsUpdate = true
}

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

const FWD = new Vector3()
