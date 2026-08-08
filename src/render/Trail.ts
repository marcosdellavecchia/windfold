import { AdditiveBlending, BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from 'three'
import type { Rgb } from '../sim/palette'

const MAX_POINTS = 2200
const DROP = 300
const SAMPLE_HZ = 20

/**
 * The live wake behind the aircraft. Not the ghost-trail system from the design
 * doc — that comes with the backend — but the same idea, and it is most of what
 * makes a flight legible while you are flying it.
 */
export class Trail {
  readonly object: Line
  private positions: Float32Array
  private colors: Float32Array
  private geometry: BufferGeometry
  private count = 0
  private timer = 0
  private rgb: Rgb

  constructor(colour: Rgb) {
    this.rgb = colour
    this.positions = new Float32Array(MAX_POINTS * 3)
    this.colors = new Float32Array(MAX_POINTS * 3)
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(35048))
    this.geometry.setAttribute('color', new BufferAttribute(this.colors, 3).setUsage(35048))
    this.geometry.setDrawRange(0, 0)

    const material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      // Never fog an additive material: fog mixes *toward* the fog colour, and
      // adding fog-coloured fragments tints the line cream at distance no
      // matter what colour it is. The age fade is this line's own fog.
      fog: false,
    })
    this.object = new Line(this.geometry, material)
    this.object.frustumCulled = false
  }

  clear() {
    this.count = 0
    this.timer = 0
    this.geometry.setDrawRange(0, 0)
  }

  update(dt: number, x: number, y: number, z: number) {
    this.timer += dt
    if (this.timer < 1 / SAMPLE_HZ) return
    this.timer = 0

    if (this.count >= MAX_POINTS) {
      this.positions.copyWithin(0, DROP * 3)
      this.count -= DROP
    }

    const i = this.count * 3
    this.positions[i] = x
    this.positions[i + 1] = y
    this.positions[i + 2] = z
    this.count++

    // Oldest samples fade out; additive blending turns a dark colour into
    // transparency without needing per-vertex alpha.
    for (let k = 0; k < this.count; k++) {
      const age = k / Math.max(this.count - 1, 1)
      const f = 0.06 + 0.94 * age * age
      this.colors[k * 3] = this.rgb[0] * f
      this.colors[k * 3 + 1] = this.rgb[1] * f
      this.colors[k * 3 + 2] = this.rgb[2] * f
    }

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.color.needsUpdate = true
    this.geometry.setDrawRange(0, this.count)
  }

  dispose() {
    this.geometry.dispose()
    ;(this.object.material as LineBasicMaterial).dispose()
  }
}
