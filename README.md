# Windfold

> A daily paper-plane gliding game in the browser. One landscape a day, as many flights as you like, best distance is your record. *Fly windfolded.*

**Status:** build steps 1 and 2 done. Flight model, a 12 km procedural world with seven
biomes, forests, lakes and sea, cumulus, birds, seeded daily worlds, air (wind /
thermals / ridge lift / thermal streets), chase camera, live wake trail, generated
ambient music, and the crash → retry loop all work. Everything from step 3 onward is unbuilt: no backend, no ghost trails from other
players, no share card, no streak, no persistence of any kind.
See [Built so far](#built-so-far).

**Name:** `Windfold` — decided. The working title was `Paper Trail`, dropped because
Newfangled Games' 2024 puzzle game owns that name in search. Windfold was chosen for
its near-zero web presence and because it names the mechanic: the wind, and the fold
that flies in it. The *blindfolded* echo lives on as the tagline, "fly windfolded."
The rename landed before deploy on purpose — the seed string carries the name, so
renaming reshuffles every world, which must never happen once scores exist.

---

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm run sim:check  # headless flight-model report, no browser
npm run build
```

Mouse (or drag on touch) steers pitch and roll. Click or space launches, and does an
instant restart once you are down. `T` opens a live tuning panel for the flight model
and lets you step through days, jump to a random day, or jump to a random day of a
chosen biome; `R` rerolls a random world from anywhere. `?day=N` loads a specific day
directly, and the URL tracks day changes so a world found while testing can be linked.

`npm run sim:check` runs `src/dev/glideTest.ts`: launch-site pressure, hands-off
distance versus a thermal-chaining autopilot, trim stability, stall entry and recovery,
the dive-and-flare energy trade, turn rate, circling sink, thermal climb rate, and a
determinism check. It is the fast way to tell whether a tuning change broke something,
since most of these are invisible in a single hand-flown flight.

The day sweeps cover three cycles of the biome rotation, not one. A single day per
biome was a complete sample back when a biome determined its terrain; now the day
draws its own shape and landform, so one alpine day says nothing about the next, and
the failure worth catching is a *particular* day being a free ride. Note that editing
terrain generation reshuffles the seeded stream, so every day's map changes and
comparing run to run day by day is meaningless — compare the distribution.

The autopilot is crude on purpose — it exists to bound a day's ceiling from below, not
to play well. When it beats a hands-off glide by a wide margin the day has depth; when
it loses, that is usually the autopilot wasting height rather than the day being flat.

---

## Pitch

Open the tab and there is one landscape. You launch a paper plane over it and glide as
far as you can. That is the entire game.

A new landscape appears every midnight Pacific, the same one for everyone on Earth.
You can fly it as many times as you want — your best flight is your record, and the
number of attempts it took you is part of your score. You can see the ghost trails of
everyone else who flew today.

---

## Non-negotiable design rules

These define the product. Features that violate them don't get built.

1. **One landscape per day.** New seed at `00:00 America/Los_Angeles`. Identical terrain, wind, and palette for every player worldwide.
2. **Unlimited attempts. Best flight is your record.** Retry as much as you like; the longest distance sticks. **Attempts are counted and shown** — reaching 1,800m in three flights is a different achievement from reaching it in thirty.
3. **Ghost trails.** You see the flight paths of other players who flew today, drawn as glowing 3D ribbons in cyan, purple, and pink. Your own earlier attempts show too, faintly.
4. **Wordle-style share card** on completion — plain text, emoji, copyable, survives being pasted into WhatsApp.
5. **No accounts. No signup. No tracking.** No analytics scripts, no third-party requests, no email capture, no ads.
6. **Streak lives in `localStorage` only.** If the user clears browser data, the streak is gone. The UI says so plainly. It is never backed up server-side.
7. **Zero onboarding.** No tutorial, no modal, no cookie banner. Controls must be discoverable in about two seconds.

---

## Core loop

Land on the page → see the landscape and today's ghost trails → press to launch →
glide → crash or land → distance in metres, compared against your best → **fly again**
or stop → share card + streak → come back tomorrow.

**Score is a single number: the longest distance in metres you flew today —
path flown, not displacement. Alongside it, the number of flights it took, and
whether you beat the day's par.**

The results screen after every flight shows: this flight's distance, your best so far,
your attempt count, and a prominent *Fly again*. Beating your best should be loud —
that's the moment the game is selling.

---

## Controls

Pointer position controls **pitch and roll** — mouse move on desktop, drag on touch.
Identical scheme on both platforms. Nothing else: no throttle, no yaw key.

Roll must visibly bank the plane. Banking is what makes the game look good in a
screen recording, which is most of how it will spread.

---

## Flight model

This is the whole game. Most of the tuning time goes here.

- Arcade aerodynamics, not a simulator: lift proportional to speed² and angle of attack, induced + parasitic drag, gravity, and a soft stall past an AoA threshold (nose drops, lift collapses, recoverable).
- **Trading altitude for speed and back must feel good.** Diving to build speed then flaring to convert it into distance is the core skill.
- **Thermals** — rising columns, hinted at by particles, dust, or circling birds. Entering one and spiralling up is the main way to extend a flight.
- **Ridge lift** — air pushed up windward slopes. Skimming a ridge is rewarded, so reading terrain matters.
- Wind is a seeded global vector for the day with mild altitude variation.
- Terrain contact or water contact ends the flight. Log distance at the moment of contact.
- **Score is path distance flown, not displacement from the launch.** Displacement froze the number while the player circled in a thermal — the scoring told them the game's best moment was wasted time — and it was hard-capped by the map radius. Path distance keeps ticking through a climb and has no ceiling.
- **A flared, level touchdown on gentle ground is a landing, not a crash.** Same score, different ending: the flare is the game's core energy trade, asked for once more at the very end, and it turns the one guaranteed-negative moment of every flight into a possible small win.
- **Every day has a par: what the paper pilot scores.** The chase autopilot from the test harness flies the day once at world build — one 150 s flight, floored at hands-off, rounded to 50 m — and that number is the day's completable goal. Deterministic from the seed, no server. Beat the paper pilot and the day is won, however far the grinders go past it; par also makes days comparable, because +400 m over par means the same thing on a mean day and a monster one.
- **Restart must be instant.** With unlimited retries, any delay between crashing and flying again is the single biggest thing that will kill the session. No loading, no fade, no confirmation — the terrain is already resident, so re-launch should be a state reset and nothing more.

Physics is plain TypeScript, outside React. No physics engine — Rapier is overkill
for one glider and one heightfield raycast.

---

## Daily generation

- `dayNumber = days since <launch date>, in America/Los_Angeles`. Seeds a deterministic PRNG (mulberry32 or similar). Same input, same world, on every device.
- The seed drives terrain heightmap, thermal placement, wind vector, colour palette, time of day, and cloud layout.
- **Everything is procedural — ship no 3D model files.** This is what keeps first load under 3 seconds, which rule 7 depends on.
- Rotate biomes by day so consecutive days feel different: alpine ridges, desert mesas, coastal cliffs, forested valleys, volcanic badlands, hay fields, archipelago.
- **The biome is not the whole day.** A strict rotation means a returning player sees the same seven landscapes in a week, so the day also draws its own relief, noise frequency, domain warp and water fraction, a second noise character blended across the map, and one structural landform — rivers, canyons, a caldera, a fault line, dunes, terraces, buttes, a glacial trough, or nothing. Two alpine days should be two different mountain ranges, not two crops of one.
- Wind and thermals are **fixed for the day, not re-rolled per attempt.** Retries must be a test of skill against a stable world, otherwise the best score is just whoever got the luckiest roll.

Determinism is testable and should be tested: two browsers, same day, byte-identical
terrain hash.

---

## Art direction

Beautiful landscapes are as much the reason to return as the score is.

- Stylised, not realistic. Large silhouettes, strong atmospheric perspective, heavy distance fog tinted to the day's palette, a low sun.
- **Slightly wrong on purpose.** A refraction-flattened sun, a moon in daylight, dust hanging in front of the camera, colour that does not quite belong to any hour. The player should half-notice these rather than see them. It is the difference between a landscape and a remembered one, and it is cheap: every one of them is a few lines in a shader that was already running.
- One striking seeded colour palette per day, plus one of six named grades that splits sky and ground in opposite hue directions. Vertex-coloured or gradient-ramped terrain rather than textures.
- The plane sits small on screen and always in frame. Camera follows loosely behind with slight lag and roll, so the horizon tilts.
- No UI chrome during flight beyond distance and altitude, thin and minimal.
- Target 60fps on a mid-tier Android phone. Fog is the draw-distance budget.

---

## Ghost trails

The signature visual: a valley threaded with dozens of glowing arcs.

**Other players' ghosts**

- Record each flight's path at 10Hz as `[x, y, z]`, quantised to `int16`, gzipped. A full flight is a couple of kilobytes.
- On load, fetch today's ghost bundle: **~40 trails sampled across the score distribution**, not at random. Include some of the day's best flights, some median, some short. The best lines should be visible and learnable.
- Colour by performance band — cyan for top flights, purple for middle, pink for short ones. Additive-blended tapered ribbons that fade with distance.
- Trails are visible **before** launch and stay visible during flight, so the player reads the day's lines before committing.
- **The trail you contribute is your best flight**, replaced on the server whenever you beat it.
- Trails carry no names, no IDs, nothing identifying. Anonymous by construction.

**Your own ghosts**

- Your previous attempts today render in faint white, dimmer than other players' trails.
- Cap at the last ~5 attempts plus your personal best, so the screen doesn't silt up over thirty flights. Highlight your own best slightly brighter than the rest.
- This is the main feedback loop for retrying: you can see exactly where the last run went wrong and where you fell short of your own best line.

---

## Share card

Plain text to clipboard, plus Web Share API where available.

```
✈️  Windfold #142
1,847 m · 4 flights

▁▂▄▆█▇▅▃▂▁▁
🟦 Top 12% today
Streak: 6 🔥

windfold.app
```

- The block strip is the **altitude profile of your best flight**, derived from its recorded path. It's a picture of how you flew, which is what makes it worth sharing.
- Attempt count sits next to the distance. It's the honest context for the number, and it's the thing friends will compete on once distances converge.
- Percentile comes from today's distribution of best distances.
- Must survive pasting into WhatsApp, iMessage, and Discord as text. No image generation in v1.

---

## Persistence & privacy

| Data | Where | Lifetime |
| --- | --- | --- |
| Best distance, attempt count, best flight's altitude profile, streak, last day played | `localStorage` | Until the user clears browser data |
| Music on/off preference | `localStorage` | Until the user clears browser data |
| Best distance + attempt count + opaque per-day token | D1 | ~7 days, then purged |
| Gzipped trail of the best flight | R2 | ~7 days, then purged |

Recent own-attempt trails are kept in memory only — they don't need to survive a
refresh, and keeping thirty of them in `localStorage` would be wasteful.

No IP, no user agent, no fingerprint, nothing joinable across days. There is nothing
to retain and no account to attach it to.

---

## Backend — Cloudflare Workers + D1 + R2

Chosen for edge-cheap global reads (ghost fetches happen on every page load,
worldwide) and near-zero cost on a viral day.

| Endpoint | Purpose |
| --- | --- |
| `GET /day` | Today's seed + metadata. Aggressively edge-cached. |
| `GET /ghosts` | Pre-built sampled trail bundle. Single cached R2 object read. |
| `POST /flight` | One call per completed flight. Upserts best-distance and increments attempt count for that token. |

- **`POST /flight` semantics:** every flight posts its distance (a few bytes, so this is cheap and gives an honest attempt distribution). **The trail blob is only uploaded when the flight is a new personal best** — that keeps R2 writes proportional to improvements, not to attempts.
- **D1** — one row per token per day: day number, opaque token, best distance, attempt count.
- **R2** — best-flight trail blobs, plus the daily ghost bundle regenerated every few minutes.
- Rate-limit `POST /flight` per token to something generous but finite (a flight can't physically complete in under a second or two). This is abuse protection, not anti-cheat.
- Hono for the Worker router is fine.

---

## Attempt counting — the rules that matter

The attempt count is now a scored quantity, so it needs to be unforgeable by accident
and hard to game casually.

- **An attempt is counted the moment the plane launches**, written locally before the first physics tick and posted when the flight resolves.
- **Bailing out mid-flight still burns the attempt.** Refreshing the page, closing the tab, or hitting restart mid-glide all count. Otherwise the counter means nothing, because the optimal strategy becomes refreshing every time a run starts badly.
- On return after a refresh, reconcile: the launched-but-unresolved attempt counts, with the distance logged at its last recorded sample.
- Best distance is monotonic — it only ever goes up within a day.
- Scores and counts are client-computed and therefore forgeable. Do a cheap plausibility check against the seed's theoretical maximum and drop absurd values. **Nothing more than that** — Wordle survived fine and so will this.

---

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Build | Vite + TypeScript | Static output, fast dev loop, small bundle. No SSR value in a WebGL canvas and no routing needed, so Next.js would be ceremony. |
| Rendering | Three.js via React Three Fiber | `useFrame` for the flight tick, JSX for terrain and ghost ribbons, normal React for HUD and share card. Drop to plain Three.js if R3F stops paying for itself. |
| Physics | Custom integrator, plain TS | One glider, one heightfield. An engine would be overkill. |
| Hosting | Cloudflare Pages + Workers | Matches the backend with no adapter layer. |

No external fonts, no CSS frameworks, no component libraries.

---

## Built so far

```
src/sim/          no React, no scene graph — steppable headlessly
  rng.ts          mulberry32 + FNV-1a seed hashing
  noise.ts        seeded Perlin, fbm / ridged / billow
  terrain.ts      heightfield generation, per-day shape and landform, sampling
  palette.ts      seven biome palettes in HSL, seeded hue rotation, daily grade
  air.ts          wind, thermal columns, ridge lift
  flight.ts       the flight model: fixed-timestep aero integrator
  tuning.ts       every tunable number, mutable for the live panel
  world.ts        day number -> seed -> biome, terrain, air, launch site, sun, moon
  flora.ts        where forest grows, what fills the ground it does not cover
src/render/       R3F components; all transforms driven from one useFrame
  Terrain.tsx     vertex-coloured heightfield: forest, strata, meadow, snow, aspect
  Trees.tsx       two tree species plus the biome's understory, streamed
  Clouds.tsx      cumulus billboards, one per thermal
  Water.tsx       fresnel + glitter + ripple, no render target
  Birds.tsx       flocks circling the nearest columns, and one skein passing through
  Herds.tsx       animals: sheep, deer, ibex, flamingos, seals, turtles
  Motes.tsx       near-field dust, wrapped around the camera
  Sky.tsx         gradient dome: sun, moon, cirrus, counter-glow, rays, ice halo,
                  daylight stars, falling stars
  atmosphere.ts   the single fog constant every shader has to agree on
src/audio/        Web Audio synthesis; no React inside music.ts
  music.ts        the day's generated score
  useMusic.ts     owns the one instance for the session
src/ui/           HUD, vario, results, tuning panel
src/dev/          headless flight-model harness
```

**Flight model.** Lift proportional to `V²·CL(α)` applied perpendicular to the relative
wind, induced + parasitic + sideslip + high-speed drag, gravity, soft stall past 16° AoA
with a nose-drop that recovers. Banking turns the aircraft because it tilts the lift
vector — there is no separate turn kinematics. Pointer position commands bank and pitch
attitude through rate-limited controllers whose authority scales with airspeed, so the
aircraft goes mushy when slow. An AoA limiter tapers the pitch command near the stall
but **fades out below stall speed**, so a hard flare gives maximum performance while
over-flaring at low speed still departs. Fixed 120 Hz substeps.

Measured: trim 21 m/s, stall 14 m/s, sink 2.1 m/s level and 3.7 m/s at 45° bank, 32°/s
turn rate at full bank, and a 41 m/s dive converts into a 59 m zoom.

**Air.** Wind is a seeded vector, 2–5.5 m/s, with mild altitude gradient. Thermals are
14 wide columns anchored to dry ground, 7–13 m/s cores, with a ring of compensating
sink so centring pays. Ridge lift is `wind · ∇terrain`, capped against wind speed and
decaying with height above the surface. Ambient sink of 2 m/s between the lift sets the
rhythm — mostly descending, occasionally climbing hard — and is deliberately not
aircraft drag, which would also eat the energy of a dive.

**Altitude is the scarce resource.** This is the design decision the rest of the game
hangs off, and getting it wrong once is instructive. The first version launched from the
highest upwind peak and scored candidate sites as `height − heightAhead`, so it
deliberately picked a summit with a valley in front of it. The ground fell away faster
than the aircraft sank, a hands-off glide crossed the map, and the lift in the air was
decoration you never had to learn.

Now the release height is measured against the mean terrain **along the route ahead**,
sampled out to 4.2 km, so a drop in front earns nothing. A reachable thermal inside the
opening glide is a scoring term, and every metre the route falls below the launch is
paid back almost one for one. You are released around 250–350 m above the ground you
have to cross, sinking at 2 m/s, with dust columns visible ahead — so the first glide is
already a decision about which one to go for.

Ridge lift needed no changes to become the risk/reward it was always meant to be: it
already decays as `exp(−agl / 220)`, so the strongest lift is right against the terrain.
Nobody flew low before because nobody had to.

**Terrain diversity, and what it cost.** Every number in a biome's shape used to be a
constant, so the only thing separating two alpine days was which patch of an infinite
noise field they sampled — same relief, same scale, same coastline. Now each day
varies its own amplitude, frequency, lacunarity, gain, warp and water fraction;
blends in a second noise character under a slow mask, so a map can be spines at one
end and rounded hills at the other; and draws one landform from a per-biome list.

The landforms are cheap on purpose — each is a few lines of arithmetic inside the
generation loop, which is why there are seven rather than one erosion pass. `rivers`
and `canyons` carve a `1 - |noise|` ridge network at the warped coordinates, so the
channels branch and meander instead of running in parallel. `caldera` is a gaussian
rim with the floor dropped out under it. `escarpment` is a noise-crooked fault with a
step across it, centred on zero so the map's mean height is unchanged. `dunes` is a
directional ripple. `terraces` is the mesa treatment somewhere it does not belong.

Two of these had to be reined in, and the reason is worth keeping. **Anything that
changes height at map scale is a ramp the flight can ride, and nothing downstream can
correct for it** — the launch scorer can only pick the least bad site on a map whose
shape is already the problem. The first caldera radius went to 2.8 km, which spans
5.6 km of a 12 km map, and a hands-off glide on such a day went 7.2 km against the
1.0–2.4 km the game is tuned around. River channels got the same treatment for the
same reason: cut deep and a glide follows one downhill for kilometres for free.

The suspect that turned out to be innocent was `curve`, the exponent that flattens
lowlands and stands peaks out of them. Holding it fixed across 60 days moved the
hands-off mean from 2391 m to 2291 m and left the tail where it was, so it kept a
full range. Measured over 60 days, hands-off distance now runs mean 2271 m, p90
3082 m, max 4627 m against a pre-change baseline of 2153 / 3079 / 4330 — the same
distribution within the sampling noise of something this skewed. Grouped by landform
over 120 days the means sit between 2035 m and 2448 m, and both of the worst days in
that sample were `plain`, which is no landform at all. The long tail is in the base
terrain and always was; one biome-per-day was simply too small a sample to show it,
which is why `glideTest` now sweeps three cycles instead of one.

**The field biome, and what flat country taught the air.** The seventh biome is hay
country: rolling billow swells at a third of anyone else's relief, hedgerow copses,
poppies in the fallow strips, and hay bales at twice life size, because a true 1.5 m
drum vanishes from 300 m up. It exists because every other biome is some kind of
mountainous — the map's variety axis ran from "peaks" to "peaks with water" — and
because a biome with no ridge lift at all forces the air to carry the day.

It does that with thermal streets. Below ~520 m of measured relief the columns start
snapping to a lattice of rows, and by field-day relief the organization is total: the
count rises half again, the cores strengthen 20%, and since every cloud marks a
thermal, the sky becomes rows of cumulus and the day becomes "pick a street and run
it". Streets key off measured relief rather than biome, so a flat plain-landform day
in any biome gets the same rescue — the two worst days in the 120-day sample were
both `plain`, and this is aimed at exactly that hole.

The first build ran the streets dead downwind, which is where real ones run, and it
was a free ride: launch heading is also downwind, so a hands-off glide fell out of
one thermal into the next for 6.1 km — the game's whole tuning target is 1.0–2.4 km.
The streets now sit 20–35° off the wind. A hands-off flight drifts out of its street
inside a kilometre; a player who banks to track the line keeps it. Same sky, but the
street is a skill now instead of a ramp. This is the ridge-lift lesson in a new
place: any lift the flight path crosses by default is free altitude, and the fix is
always to make holding it an action.

Two more landforms rode along. `buttes` stands steep-sided tables off a noise
threshold — mesa country by right, tors on a field day. `glacial` is one wide
U-trough across the map, reusing the escarpment's crooked fault line; constant depth
along its length, so entering it is one drop rather than a downhill to follow, which
is the caldera's lesson applied in advance. And shores got a material: a `sand` band
above the waterline, width wandering with the same patch noise as everything else,
suppressed on steep faces so cliffs still meet the sea bare. It is not always sand —
grey shingle on alpine lakes, alkali crust round a playa, river silt in the valley,
and black sand under the volcano, the one shore darker than its water.

**The landscape.** Terrain is one 385² vertex-coloured mesh spanning 12 km at 32 m
cells — the same draw cost as the original 6 km map for four times the area. Above it:
forests, cumulus, water, and birds, all procedural, still no art files.

The one non-obvious piece is how forest is drawn. Real woodland is a tree every few
metres; the instance budget affords one every ~150 m, and scattered individually they
read as a handful of shrubs on bare ground. So forest lives in two places at once —
the terrain mesh tints itself toward canopy colour wherever the forest mask is high,
which is what makes the hills read as wooded from a kilometre up, and instanced trees
add real silhouettes in the near field. Both read the same field from `flora.ts`, so
trees always stand on ground that already looks like forest. Trees stream in scatter
cells keyed by position, so a rebuild is stable and only the ones out at the fog limit
get recycled — and they shrink to nothing at the boundary, so recycling is invisible.

**Water does not move, and that is the point.** The wave function drove the *body
colour* as well as the surface normal, which put a 300 m brightness field on every
lake sliding across it at 43 m/s — the phase rates had been picked to feel right
without dividing them into the spatial frequencies they belonged to. At a fixed point
on a lake the deep/shallow mix swung by 0.118 on a three-second cycle, and on a lake
300 m across that is the whole surface pulsing at once, which reads as a rendering
fault rather than as water. Body colour is now a function of position only — swing
0.000, forever — and the waves that remain are 20–80 m features moving at 3–7 m/s,
where they belong: perturbing the normal for the fresnel and the sun glitter. Real
water seen from an aircraft does not change colour as a wave passes. It changes colour
where it is deeper, and that does not move at all.

The waterline was the other fault, and it was not the one it looked like. A shaking,
stair-stepped coast pattern-matches to z-fighting, but offsetting the water's depth
did nothing measurable — because the coast was the raw *depth intersection* of the
water plane and the terrain, and MSAA cannot antialias an edge that is computed per
pixel rather than drawn as geometry. The water now carries the heightfield as a
16-bit texture (two packed bytes, because filtering float textures needs an extension
mobile does not reliably have, and the decode is linear so bilinear filtering still
reconstructs the exact height) and fades its own alpha out over the last two metres
of depth. A soft wet edge instead of an intersection line: nothing left to alias,
nothing left to shake, and the same texture read gives true shallows that shelve the
last dozen metres toward every shore for free.

Cumulus is the piece of scenery that is also a mechanic. Dust columns only carry about
2 km, which is one glide; clouds carry to the fog limit, so the sky is a map of where
the lift is and "head for the next cloud" is a rule players teach themselves.

Three shaders reproduce the scene's fog by hand, so `FOG_DENSITY` lives in exactly one
place (`render/atmosphere.ts`). Any disagreement shows up as a hard line along the
horizon.

**The dream pass.** The art direction asks for stylised, not realistic, and the way
that is cashed out here is a set of details that are each slightly wrong on purpose.
A low sun is flattened by refraction into an oval — further than the atmosphere
actually manages — cut by a mirage notch, and shimmering a few percent on a slow
cycle. Crepuscular rays fan out of it on odd harmonics so the spokes are never even.
A moon hangs in the daylight, phase and position seeded, deliberately placed away
from the sun. Cirrus is drawn out along the day's wind on a projected sheet, so the
streaks converge toward the horizon. Opposite the sun sits the counter-glow, which is
the one thing in the list that is real. Near the camera, a few hundred motes wrap
around the aircraft on a torus: the whole rest of the world is at least a hundred
metres away, so without them there is no parallax at all and 21 m/s reads as a
panning painting.

The second pass leaned further in, still all inside the one sky shader. The sun got
a limb gradient — white-hot core cooling to the day's colour at the rim, because a
flat disc reads as a sticker — and an ice-halo ring at a shrunken 22 degrees, warm
inside and cold outside like the real one, breathing slowly. The moon got maria off
the same value noise as everything else, limb darkening, a whisper of lunar corona,
and earthshine, so its dark side is a cool ghost instead of a hole. Stars hang in
the deep blue of the upper dome in broad daylight — wrong the way the daytime moon
is wrong, and for the same reason — keeping clear of the sun, dimming under cirrus,
each twinkling on its own period, denser on some days than others. And roughly once
a minute a falling star crosses the high sky and is gone inside a second; each one
draws its own start point and heading, and most fall outside the dome entirely,
which is what makes catching one feel like luck rather than a scheduled effect.

The grade is the other half of it. Six biomes on a strict rotation means the same
biome returns every six days, and a hue wobble was not enough to make those two days
feel like different places, so each day also draws one of six named grades —
*daybreak*, *gloaming*, *hazy*, *reverie*, *deep*, *clear* — which rotates the sky and
the ground in **opposite** directions. Complementary sky and ground is most of why
dawn photographs look the way they do, and it is the difference between a scene that
is tinted and a scene that has a light in it. The name shows on the start screen, so
the day gets called something.

Two things that look like grading but are not: the terrain's aspect tint is a
multiply by a mean-1 chroma, not a blend toward the light's colour — a light is
nearly white by construction, and lerping toward it turned every sunlit slope grey —
and the vignette is two CSS gradients over the canvas rather than a post chain,
because an EffectComposer plus two render targets is a lot to spend on a phone that
has to hold 60fps to do what a `radial-gradient` already does.

**Ground cover.** Trees only stand where the forest mask is high, which by design
leaves every scree slope, playa, cliff top and beach empty — most of the ground on
four of the six biomes. Each biome now has an understory placed by the rules trees
are placed *against*: boulders want the steep ground the spruce cannot hold, palms
want the shoreline the forest is explicitly held back from. It rides the same scatter
cells as the trees, so it costs one more instanced draw call and nothing else.

Above that, the terrain mesh paints three more fields into its vertex colours, all
free because they run once at world build: mineral strata banded on *absolute*
altitude, so a cliff reads as cut through something layered while the face itself is
not level; meadow patches on the open gentle ground between the woods; and a snowline
that wanders on the same noise as everything else instead of drawing a ring around
the peak.

**The score, the par, and the landing.** Three mechanics decisions, made together
because they are one decision about what kind of game this is.

The score is now *path distance flown*. Displacement — the original metric — was
resolved as a known gap: it was hard-capped by the map radius, and worse, it froze
while the player circled in a thermal, so the scoring actively told them the most
satisfying thing in the game was wasted time. Path distance counts the journey the
way Tiny Wings and Alto's do. Measured over the 21-day sweep, hands-off flights
barely change (they fly straight) while the thermal-chaining autopilot now scores
1.1–5.0× hands-off, always above it — under displacement it frequently scored
*below* hands-off despite flying four times longer, which said everything about the
old metric. The ground track is what accumulates: a climb scores the circles it
flies, and the height it banks pays out as track when it is spent.

Par is the day's completable goal, for the player who wants to win and stop rather
than grind — Wordle works because six rows is *done*, and a pure distance chase has
no done. The paper pilot (the same chase autopilot the harness uses) flies the day
once at world build: one honest 150-second flight, floored at the hands-off glide,
rounded to 50 m, about 60 ms of compute, deterministic from the seed with no server
involved. It was first given the full 300 s the harness allows and came back with
5.4 km pars — a goal most players can never reach is a stressor, which is the
opposite of this mechanic's job. Capped, pars land at 2.2–4.1 km against a ~2 km
hands-off floor: you must use the air to beat the pilot, but you need not move in.
Par also normalises days against each other, which raw distance never did.

And a flared, level touchdown on gentle ground (or water — the surface is flat even
where the seabed is not) now ends the flight as a **landing** rather than a crash.
No score change, deliberately: a quiet line on the results screen, not a bonus to
optimise. Trim sink is 2.1 m/s and the landing threshold is 2.0, so gliding
passively into the ground does not qualify — the flare that converts the last of
the speed into a soft arrival is the game's core energy trade, asked for one final
time. Alto's made the smooth landing its signature feel-good beat; this is that,
sized for a game where every previous flight ended in a wall of flat green.

**Own ghosts.** The client half of the ghost system is in: every finished attempt
stays on screen as a faint white line, the last five plus the personal best, which
draws brighter because it is the line being flown against. Additive-blended `Line`
strips off the recorded 10 Hz path — the same visual language as the live wake —
with depth-test on, so a route behind a hill reads as behind the hill. White on
purpose: the cyan/purple/pink bands are reserved for other players' trails, so the
two layers will never fight when the backend lands. Paths live in memory only, per
the persistence table; six extra draw calls, no new materials science.

**The alive pass.** Three changes with one aim: ground that something happens on.

Cloud shadows drift across terrain and water, the single cheapest thing that makes
a landscape read as living from the air. One two-octave noise field at cumulus
scale, scrolled with the day's wind, multiplied in *before* the fog in both
shaders — shade applied after fog would mottle the horizon where everything must
converge on one colour — and shared through `atmosphere.ts` with one seed and one
clock, so a patch of shade crosses a shoreline in one piece.

Animals, one species per biome, in herds rather than sprinkled: sheep in the
hedgerow pastures, deer at the clearing edges, ibex strung along the ledges,
flamingos in a pink crescent on the playa, seals hauled out under the headlands,
turtles up the tropical beaches. Volcanic days get nothing, which says more than
an eighth species would. Each animal drifts around its home on two incommensurate
sines — no AI, no state, and from altitude it reads as grazing. Placement rides
the same deterministic scatter cells as the trees. Two lessons came out of the
filters: shore species must not also be gated by height band, because the
waterline's *fraction* of the height range moves with the day's water roll, and
their herd centres need several candidate darts per cell — a habitat that is a
ten-metre ribbon is never hit by one throw at a 384 m square.

And the field biome got its farmland quilt: cells warped by the terrain's own
noises, each field a hair lighter or darker, some cut for hay gold, the seams
between them darkened into hedgerows. A patchwork of worked fields is *the*
iconic view from a glider, and it was free — vertex colours, once, at build.

**Music.** Synthesised in the browser, not streamed — same reasoning as the terrain.
Rule 5 forbids third-party requests and the load budget is three seconds; a few minutes
of ambient piano is a megabyte and a round trip, whereas this is a few kilobytes of code
that never repeats and never fetches anything.

An original composition in the idiom rather than of it: a slow I–V–vi–iii–IV–I–IV–V at
~66 bpm, a music-box voice over a detuned pad, through a generated convolution reverb,
lowpassed so it can never get bright enough to demand attention. The key and every
bar's ornament derive from the day's seed, so the music is part of the day exactly like
the terrain — everyone hears the same piece, tomorrow is a different one — and bar 400
is reproducible without storing any state. Rests are seeded too, because a line that
never stops stops being background.

**It cannot autoplay, and no implementation can.** Browsers require a user gesture
before audio. It starts on the first click, tap, or key, which is the same gesture that
launches the first flight, so in practice it begins when the game does. Measured output
is −29 dBFS RMS / −14 dBFS peak: present, but under conversation level.

**Known gaps in the current build**
- **60 fps on a mid-tier Android is still unverified**, and the dream pass has not
  helped: the sky is now a four-octave fbm over a full-screen dome, and the
  understory added a third instanced species to the rescatter burst. Desktop had a
  10 ms worst frame before it, so there is headroom, but nothing here has been
  measured on a phone. Terrain has no LOD, and the rescatter is a burst of a few
  thousand terrain samples every ~200 m of travel — the first thing to amortise if it
  hitches. The cirrus octave count is the cheapest thing to give back.
- **The understory has no collision either.** Same as the trees: flying through a
  boulder is free.
- The bundle is 302 kB gzipped, nearly all Three.js.
- Trees have no collision. Clipping a treetop is free, which is forgiving but wrong.
- Terracing on the mesa biome is subtler than intended at 32 m cells.
- **The music has never been listened to by anyone.** It is verified to produce signal
  at the right level and to mute cleanly, and it is consonant by construction, but
  whether it is actually pleasant over ten minutes is unmeasured. Voicing, tempo and
  the melody's rest density are the knobs.

---

## Build order

1. ~~**Flight model + debug terrain + instant restart.**~~ Done. Iterate until flying is genuinely fun and retrying is frictionless. *Stop here until it is* — everything downstream is worthless if the flight model isn't, and with unlimited retries the restart loop is part of the flight model.
2. ~~**Procedural terrain, palettes, fog, camera.**~~ Mostly done — six biomes, seeded palettes, distance fog, chase camera with roll. Still no clouds.
3. **Daily seeding and determinism.** Seeding is in and the harness verifies a rebuild is byte-identical; still need the two-browsers check.
4. **Flight recording, own-attempt ghosts, backend, other players' ghosts.**
   Recording and own-attempt ghosts are done — the remaining half of this step is
   the backend and everyone else's trails.
5. **Share card, streak, best-and-attempts screen.**

---

## Definition of done for v1

A stranger opens the link on a phone, understands what to do without being told, flies,
immediately wants another go, beats their own distance, gets a number and a shareable
card, and comes back tomorrow.

---

## Out of scope

Accounts, realtime multiplayer, chat, friend lists, named leaderboards, achievements,
cosmetics, monetisation, level editor.

---

## Open design questions

**How much weight does the attempt count carry?** Three options, and it changes how
people play: pure flavour on the share card; a tiebreaker when distances are close; or
a separate ranking so "1,700m in 2 flights" can beat "1,850m in 40". The third makes
the game much deeper and much more stressful. Decide before the share card ships,
because the format sets the expectation.

**Unlimited retries versus daily scarcity.** The one-attempt rule was what made the
daily format feel precious and made the share card a real result rather than a grind
report. Unlimited retries trade that for a much better game to actually play, and the
attempt counter is what keeps the score honest. Worth watching after launch: if people
report 60-flight scores, the counter isn't doing enough social work and it should
graduate from flavour to tiebreaker.

**Ghosts sampled by score band vs randomly.** Current plan samples across the
distribution so the day's best lines are visible and learnable. Cost: top routes get
copied — arguably a feature for a shared-puzzle game, but a real fork.

**Streak with no server backup.** Rule 6 means a cleared browser wipes a 200-day
streak with no recourse. That's the honest cost of no accounts, and it's the right
trade, but expect complaints and decide now that the answer is "yes, that's the deal."

---

## Spec gaps to resolve before step 4

Two contradictions in the sections above, found while building. Neither affects the
current build — both land the moment the backend does.

**Nothing serves the percentile.** The share card needs "Top 12% today", but `/day` is
aggressively edge-cached, `/ghosts` is a trail bundle, and `POST /flight` has no
specified response. Cheapest fix: return the percentile from `POST /flight`. Otherwise
ship a coarse distance histogram inside the ghost bundle and compute it client-side.

**Refresh reconciliation contradicts the persistence table.** *Attempt counting* says an
unresolved attempt is logged "at its last recorded sample", but *Persistence & privacy*
keeps own-attempt trails in memory only. After a refresh there is no sample to read.
Needs a small in-flight marker — attempt-started plus last distance — written to
`localStorage` on a timer, which is a third thing in that table.
