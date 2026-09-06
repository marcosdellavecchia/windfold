import { useSyncExternalStore } from 'react'

interface Settings {
  reducedMotion: boolean
  routes: boolean
}
function readSettings(): Settings {
  return {
    reducedMotion: typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    routes: false,
  }
}
let settings = readSettings()
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
export const getSettings = () => settings
export const useSettings = () => useSyncExternalStore(subscribe, getSettings)
export function changeSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  listeners.forEach((cb) => cb())
}
