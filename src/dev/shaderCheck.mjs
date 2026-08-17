/**
 * Static check over every hand-written shader in `src/render`.
 *
 *   npm run shader:check
 *
 * This exists because a shader is a string, and nothing else in the toolchain
 * looks inside one. `tsc` sees a template literal; so does `vite build`. A
 * uniform referenced in GLSL but never declared is a compile error that only
 * happens on a GPU, and when it happens the material fails silently and the
 * surface it belonged to stops drawing — which is precisely what a dangling
 * `uSky` reference did here after a uniform was renamed, with both build steps
 * reporting success.
 *
 * Three things per file:
 *
 *   - every `uName` used in GLSL is declared there as a uniform
 *   - every declared uniform is actually supplied from the TypeScript side
 *   - anything supplied but never used, which is dead weight rather than a fault
 *
 * Uniforms reach a shader two ways in this codebase — a `uniforms: {}` block on
 * a ShaderMaterial, and `shader.uniforms.x =` inside an `onBeforeCompile` patch
 * — so both are recognised, which is what lets this cover the terrain material
 * as well as the standalone ones.
 *
 * Plain .mjs rather than .ts on purpose: it needs `fs`, the project has no
 * `@types/node`, and one dev script is a poor reason to add a dependency. `tsc`
 * takes only .ts and .tsx out of `src`, so this is invisible to it, while esbuild
 * still resolves the .ts import below when bundling.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { AIR_FOG_GLSL, AIR_FOG_UNIFORMS, CLOUD_SHADOW_GLSL } from '../render/atmosphere'
import { WATER_OPTICS_GLSL } from '../render/waterOptics'

const DIR = 'src/render'

/**
 * Contents of every template literal in a file, concatenated.
 *
 * A scanner rather than a regex because these literals nest: the shaders
 * interpolate `${CLOUD_SHADOW_GLSL}` and `${FOG_DENSITY.toFixed(6)}`, and a
 * naive backtick match ends the string at the first brace it meets.
 */
function templateLiterals(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '`' && src[i - 1] !== '\\') {
      let depth = 0
      let j = i + 1
      let body = ''
      while (j < src.length) {
        const c = src[j]
        if (c === '\\') { j += 2; continue }
        if (c === '$' && src[j + 1] === '{') { depth++; j += 2; continue }
        if (c === '}' && depth > 0) { depth--; j++; continue }
        if (c === '`' && depth === 0) break
        body += c
        j++
      }
      out += `\n${body}`
      i = j + 1
      continue
    }
    i++
  }
  return out
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).sort()
let failures = 0
let checked = 0

for (const file of files) {
  const path = `${DIR}/${file}`
  const src = readFileSync(path, 'utf8')
  // The shared chunks are interpolated at runtime; expand them so the helpers
  // and uniforms they declare count as present rather than as missing.
  const glsl = templateLiterals(src)
    .replace(/\bCLOUD_SHADOW_GLSL\b/g, CLOUD_SHADOW_GLSL)
    .replace(/\bAIR_FOG_GLSL\b/g, AIR_FOG_GLSL)
    .replace(/\bWATER_OPTICS_GLSL\b/g, WATER_OPTICS_GLSL)
  if (!/\b(gl_FragColor|gl_Position|void main)\b/.test(glsl)) continue
  checked++

  const declared = new Set([...glsl.matchAll(/\buniform\s+\w+\s+(u[A-Z]\w*)\s*;/g)].map((m) => m[1]))
  // A name appearing only on its own declaration line is declared and never
  // read, which is the third case below rather than a use.
  const used = new Set(
    [...glsl.matchAll(/\b(u[A-Z]\w*)\b/g)].map((m) => m[1]).filter((name) => {
      const total = (glsl.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      const asDecl = (glsl.match(new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`, 'g')) ?? []).length
      return total > asDecl
    }),
  )
  const supplied = new Set([
    ...[...src.matchAll(/^\s*(u[A-Z]\w*)\s*:\s*\{\s*value/gm)].map((m) => m[1]),
    ...[...src.matchAll(/shader\.uniforms\.(u[A-Z]\w*)\s*=/g)].map((m) => m[1]),
    // The shared haze uniforms arrive as a spread or an Object.assign of the
    // whole record; either supplies every key it holds.
    ...(/\.\.\.AIR_FOG_UNIFORMS|Object\.assign\([^)]*AIR_FOG_UNIFORMS\)/.test(src)
      ? Object.keys(AIR_FOG_UNIFORMS)
      : []),
  ])

  const undeclared = [...used].filter((u) => !declared.has(u))
  const unsupplied = [...declared].filter((u) => !supplied.has(u))
  const unused = [...supplied].filter((u) => !used.has(u))

  const bad = undeclared.length > 0 || unsupplied.length > 0
  if (bad) failures++
  console.log(`${bad ? 'FAIL' : 'ok  '} ${path}`)
  if (undeclared.length) console.log(`       used in glsl but never declared:  ${undeclared.join(', ')}`)
  if (unsupplied.length) console.log(`       declared but never supplied:      ${unsupplied.join(', ')}`)
  if (unused.length) console.log(`       supplied but never used:          ${unused.join(', ')}`)
}

console.log(`\n${checked} shaders checked, ${failures} with problems`)
process.exit(failures ? 1 : 0)
