/**
 * Pointer position drives pitch and roll — mouse move on desktop, drag on touch.
 * Same scheme on both, per the design rules. Nothing else is bound except a
 * keyboard fallback, which exists so the flight model can be tested without a
 * hand on the mouse.
 */
export interface Axis {
  x: number
  y: number
}

export const axis: Axis = { x: 0, y: 0 }

type Action = () => void

let onCommit: Action = () => {}

/** Called on click, tap, or space — launch when ready, restart when down. */
export function setCommitHandler(fn: Action) {
  onCommit = fn
}

const keys = { left: false, right: false, up: false, down: false }

let captured = false

/**
 * While a UI surface owns the pointer — the tuning panel, mainly — the pointer
 * and touch stop steering and clicks commit nothing, so adjusting a slider
 * mid-flight does not also roll the aircraft into a hill. The keyboard keeps
 * flying: it is the testing fallback, and one hand on the sliders with the
 * other on WASD is exactly the tuning workflow. The pointer position keeps
 * being tracked underneath, so steering resumes from wherever the cursor
 * actually is the moment the panel closes.
 */
export function setPointerCaptured(v: boolean) {
  captured = v
}

let touchActive = false
let touchOriginX = 0
let touchOriginY = 0
let touchX = 0
let touchY = 0
let pointerX = 0
let pointerY = 0
let sawTouch = false

export function attachInput(target: HTMLElement | Window = window): () => void {
  const el = target as Window

  const onMouseMove = (e: MouseEvent) => {
    if (sawTouch) return
    pointerX = (e.clientX / window.innerWidth) * 2 - 1
    pointerY = -((e.clientY / window.innerHeight) * 2 - 1)
  }

  const touchScale = () => Math.min(window.innerWidth, window.innerHeight) * 0.28

  const onTouchStart = (e: TouchEvent) => {
    sawTouch = true
    const t = e.touches[0]
    touchActive = true
    touchOriginX = t.clientX
    touchOriginY = t.clientY
    touchX = 0
    touchY = 0
  }

  const onTouchMove = (e: TouchEvent) => {
    if (!touchActive) return
    e.preventDefault()
    const t = e.touches[0]
    const s = touchScale()
    touchX = clamp((t.clientX - touchOriginX) / s, -1, 1)
    touchY = clamp(-(t.clientY - touchOriginY) / s, -1, 1)
  }

  const onTouchEnd = () => {
    touchActive = false
  }

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        keys.left = true
        break
      case 'ArrowRight':
      case 'KeyD':
        keys.right = true
        break
      case 'ArrowUp':
      case 'KeyW':
        keys.up = true
        break
      case 'ArrowDown':
      case 'KeyS':
        keys.down = true
        break
      case 'Space':
      case 'Enter':
        e.preventDefault()
        onCommit()
        break
    }
  }

  const onKeyUp = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        keys.left = false
        break
      case 'ArrowRight':
      case 'KeyD':
        keys.right = false
        break
      case 'ArrowUp':
      case 'KeyW':
        keys.up = false
        break
      case 'ArrowDown':
      case 'KeyS':
        keys.down = false
        break
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (captured) return
    if ((e.target as HTMLElement)?.closest?.('[data-ui]')) return
    onCommit()
  }

  el.addEventListener('mousemove', onMouseMove as EventListener)
  el.addEventListener('touchstart', onTouchStart as EventListener, { passive: true })
  el.addEventListener('touchmove', onTouchMove as EventListener, { passive: false })
  el.addEventListener('touchend', onTouchEnd as EventListener)
  el.addEventListener('touchcancel', onTouchEnd as EventListener)
  el.addEventListener('keydown', onKeyDown as EventListener)
  el.addEventListener('keyup', onKeyUp as EventListener)
  el.addEventListener('pointerup', onPointerUp as EventListener)

  return () => {
    el.removeEventListener('mousemove', onMouseMove as EventListener)
    el.removeEventListener('touchstart', onTouchStart as EventListener)
    el.removeEventListener('touchmove', onTouchMove as EventListener)
    el.removeEventListener('touchend', onTouchEnd as EventListener)
    el.removeEventListener('touchcancel', onTouchEnd as EventListener)
    el.removeEventListener('keydown', onKeyDown as EventListener)
    el.removeEventListener('keyup', onKeyUp as EventListener)
    el.removeEventListener('pointerup', onPointerUp as EventListener)
  }
}

/** Resolve the current control axes. Called once per frame by the simulation. */
export function readAxis(dt: number): Axis {
  if (captured) {
    axis.x = 0
    axis.y = 0
  } else if (sawTouch) {
    if (!touchActive) {
      const k = 1 - Math.pow(0.001, dt)
      touchX += (0 - touchX) * k
      touchY += (0 - touchY) * k
    }
    axis.x = touchX
    axis.y = touchY
  } else {
    axis.x = pointerX
    axis.y = pointerY
  }

  const kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0)
  const ky = (keys.up ? 1 : 0) - (keys.down ? 1 : 0)
  if (kx !== 0) axis.x = kx
  if (ky !== 0) axis.y = ky

  axis.x = clamp(axis.x, -1, 1)
  axis.y = clamp(axis.y, -1, 1)
  return axis
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
