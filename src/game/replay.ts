import { Quaternion, Vector3 } from 'three'

export interface ReplayPose {
  time: number
  position: Vector3
  rotation: Quaternion
  speed: number
  lift: number
  stall: number
}
const CAPACITY = 242
/** Eight seconds at 30 Hz, independent of score/path recording. */
export class ApproachReplay {
  private ring: ReplayPose[] = []
  private head = 0
  private last = -Infinity
  private clip: ReplayPose[] = []
  private cursor = 0
  active = false
  get available() { return this.clip.length > 2 }
  reset() { this.ring = []; this.clip = []; this.head = 0; this.last = -Infinity; this.active = false; this.cursor = 0 }
  record(time: number, position: Vector3, rotation: Quaternion, speed: number, lift: number, stall: number, force = false) {
    if (time <= this.last || (!force && time - this.last < 1 / 30 - 1e-6)) return
    this.last = time
    let pose = this.ring[this.head]
    if (!pose) pose = { time, position: new Vector3(), rotation: new Quaternion(), speed, lift, stall }
    pose.time = time; pose.position.copy(position); pose.rotation.copy(rotation)
    pose.speed = speed; pose.lift = lift; pose.stall = stall
    this.ring[this.head] = pose
    this.head = (this.head + 1) % CAPACITY
  }
  finish() {
    this.clip = this.ring.length < CAPACITY ? [...this.ring] : [...this.ring.slice(this.head), ...this.ring.slice(0, this.head)]
    const end = this.clip.at(-1)?.time ?? 0
    this.clip = this.clip.filter((pose) => pose.time >= end - 8)
    this.active = false
  }
  start() { if (this.available) { this.cursor = this.clip[0].time; this.active = true } }
  stop() { this.active = false }
  sample(dt: number, out: ReplayPose): boolean {
    if (!this.active) return false
    this.cursor = Math.min(this.cursor + dt * 0.8, this.clip.at(-1)!.time)
    let i = 0
    while (i < this.clip.length - 2 && this.clip[i + 1].time < this.cursor) i++
    const a = this.clip[i], b = this.clip[i + 1]
    const t = Math.max(0, Math.min(1, (this.cursor - a.time) / Math.max(b.time - a.time, 1e-6)))
    out.position.lerpVectors(a.position, b.position, t)
    out.rotation.slerpQuaternions(a.rotation, b.rotation, t)
    out.speed = a.speed + (b.speed - a.speed) * t
    out.lift = a.lift + (b.lift - a.lift) * t
    out.stall = a.stall + (b.stall - a.stall) * t
    out.time = this.cursor
    if (this.cursor >= this.clip.at(-1)!.time) this.active = false
    return true
  }
}
let replayAction: (action: 'start' | 'stop') => void = () => {}
export const requestReplay = () => replayAction('start')
export const stopReplay = () => replayAction('stop')
export const setReplayHandler = (handler: typeof replayAction) => { replayAction = handler }
