import { useEffect, useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Line, LineBasicMaterial } from 'three'
import type { FlightSample } from '../sim/flight'

/**
 * Your own previous attempts, drawn as faint white lines over the terrain.
 *
 * This is the main feedback loop for retrying: you can see exactly where the
 * last run went wrong and where you fell short of your own best line. The last
 * few attempts render dim; the personal best renders brighter, because it is
 * the line you are actually flying against. Other players' ghosts arrive with
 * the backend — these are kept deliberately quieter than that future layer
 * (white, not the cyan/purple/pink of the score bands) so the two never fight.
 *
 * Paths live in memory only, per the persistence table: they do not need to
 * survive a refresh, and the attempt that matters — the best — is the one the
 * backend will eventually own.
 */
export interface GhostData {
  /** The last few attempts, oldest first. Capped in Scene, not here. */
  attempts: FlightSample[][]
  /** The best flight so far today, drawn brighter than the rest. */
  best: FlightSample[] | null
}

const ATTEMPT_BRIGHTNESS = 0.09
const BEST_BRIGHTNESS = 0.22

export function Ghosts({ data }: { data: GhostData }) {
  const group = useMemo(() => {
    const g = new Group()
    for (const path of data.attempts) {
      if (path !== data.best) g.add(ghostLine(path, ATTEMPT_BRIGHTNESS))
    }
    if (data.best) g.add(ghostLine(data.best, BEST_BRIGHTNESS))
    return g
  }, [data])

  useEffect(
    () => () => {
      for (const child of group.children as Line[]) {
        child.geometry.dispose()
        ;(child.material as LineBasicMaterial).dispose()
      }
    },
    [group],
  )

  return <primitive object={group} />
}

function ghostLine(path: FlightSample[], brightness: number): Line {
  const positions = new Float32Array(path.length * 3)
  for (let i = 0; i < path.length; i++) {
    positions[i * 3] = path[i].x
    positions[i * 3 + 1] = path[i].y
    positions[i * 3 + 2] = path[i].z
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))

  // Additive blending turns a dark colour into transparency, same trick as the
  // wake trail — no per-vertex alpha needed. depthWrite off so the lines never
  // punch holes in each other; depthTest on so a line behind a hill is behind
  // the hill, which is what makes the routes readable as routes.
  const material = new LineBasicMaterial({
    color: new Color(brightness, brightness, brightness),
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  })
  const line = new Line(geometry, material)
  line.frustumCulled = false
  return line
}
