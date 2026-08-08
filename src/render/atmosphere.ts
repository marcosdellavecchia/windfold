/**
 * Single source of truth for the fog. Three separate shaders reproduce the scene's
 * FogExp2 by hand — water, clouds, and anything else that needs to blend into the
 * same haze — and if any of them disagrees with the renderer the seam shows up as a
 * hard line along the horizon.
 *
 * Tuned to the 12 km map: the original 0.00055 was set for a 6 km world and buried
 * everything past two kilometres, which is most of the landscape the player is
 * supposed to be enjoying.
 */
export const FOG_DENSITY = 0.00034

/** Distance at which fog is essentially total — useful for sizing scenery radii. */
export const FOG_LIMIT = 5200
