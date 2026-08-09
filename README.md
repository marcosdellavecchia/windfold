# Windfold

> A daily paper-plane gliding game in the browser. One landscape a day, as many flights as you like, best distance is your record. *Fly windfolded.*

**Status:** the solo game is complete and the first multiplayer layer is live.
What remains from the original plan: other players' ghost trails and the share
card's percentile line, both waiting on the ghost backend. A streak was built
and cut. See [The game today](#the-game-today) for what exists and
[Built so far](#built-so-far) for how it got that way.

---

## The game today

Everything currently in the shipped build, at a glance:

**The world.** One 12 km procedural landscape per day, identical for everyone on
Earth, from a seed derived from the date. Seven biomes on rotation — alpine,
mesa, coastal, valley, volcanic, field, archipelago — each day drawing its own
relief, water, one or two structural landforms (rivers, canyons, caldera,
escarpment, dunes, terraces, buttes, glacial trough, crater field), a colour
grade, forests with per-day character and rare blossom/autumn seasons, farmland
quilts, beaches with wet sand, herds of animals, cloud shadows, swell and surf
on the sea, and a sky with sun halo, daylight stars, a moon with earthshine,
and the occasional falling star. `R` rerolls a world for testing; `?world=N`
links to any specific one.

**The flight.** Pointer-only controls (pitch and roll), arcade aerodynamics
with a real energy model: dive to build speed, flare to spend it, stall and
recover. Thermals, ridge lift, and wind-aligned thermal streets on flat days
are the lift to hunt; cumulus marks the thermals, so the sky is a map. Score is
path distance flown. A flared, level touchdown on gentle ground is a landing,
not a crash. Restart is instant.

**The day's shape.** Every world has a *par* — the distance a headless
autopilot ("the paper pilot") achieves on it, computed client-side from the
seed — so each day has a completable goal. Best distance and attempt count
persist per world in localStorage; refreshing mid-flight still burns the
attempt. A tab left open picks up the new world at midnight Pacific.

**The sharing.** One click copies a plain-text card — world name, distance,
flights, par verdict, landing badge, an altitude-profile strip of the best
flight, and a link that opens that exact world as a challenge.

**The others.** An anonymous presence layer over a tiny Redis-backed API:
every finished flight leaves its resting point, and other players' planes lie
where they came down — upright if landed, crumpled if crashed. Pilots carry a
call sign (dealt from curated word lists, rerollable, or typed — gated
server-side); a label floats above each signed dart, "Gloaming Fox · 2.7 km",
fading in as you approach. The splash counts the pooled total: "pilots have
flown 123 km here." Your own attempts also stay on screen as faint ghost
lines, your best brighter than the rest.

**The rest of the feel.** Generated ambient music, seeded per day like the
terrain, that hears the flight: bells rise with thermal lift, altitude opens
the filter, a gentle landing rings a resolved chime. A blurred veil covers
world swaps ("Imagining new worlds…"). The plane is a folded dart that sunlight
transmits through, with a ground-shadow that doubles as a landing aid.

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
chosen biome; `R` rerolls a random world from anywhere. `?world=N` loads a specific
world directly, and the URL tracks world changes so one found while testing can be
linked — which is also what makes every share card a challenge link.

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
5. **No accounts. No signup. No tracking.** No analytics scripts, no third-party requests, no email capture, no ads. Call signs are not accounts: stored locally, optional, never unique, never authenticated.
6. **No streak.** One was built and cut before launch: the world and the card are what earn the return visit, and a guilt counter that dies with cleared browser data was more stress than reward in a game whose whole promise is relaxing.
7. **Zero onboarding.** No tutorial, no modal, no cookie banner. Controls must be discoverable in about two seconds.

---

## Core loop

Land on the page → see the landscape and today's ghost trails → press to launch →
glide → crash or land → distance in metres, compared against your best → **fly again**
or stop → share card → come back tomorrow.

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

*Status: your own ghosts are built (faint white lines, best brightest); other
players' trails below are the design for the ghost backend, still unbuilt.*

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

Built. Plain text, clipboard only — one click, the button becomes "Copied to
clipboard", go paste it somewhere.

```
✈️ Windfold #142 · gloaming coastal
1,847 m · 4 flights · par ✓ 🛬

▁▂▄▆█▇▅▃▂▁▁▂

https://windfold.vercel.app/?world=142
```

The world's name is on the card, and the URL — full scheme, so every chat app
makes it clickable — opens that exact world: every card is also a challenge
link. Par gives the card a verdict the way Wordle's
X/6 does, comparable between players whose distances differ wildly; 🛬 marks a
best flight that ended in a gentle landing. The percentile line ("Top 12%
today") arrives with the backend.

- The block strip is the **altitude profile of your best flight**, derived from its recorded path. It's a picture of how you flew, which is what makes it worth sharing.
- Attempt count sits next to the distance. It's the honest context for the number, and it's the thing friends will compete on once distances converge.
- Percentile comes from today's distribution of best distances.
- Must survive pasting into WhatsApp, iMessage, and Discord as text. No image generation in v1.

---

## Persistence & privacy

| Data | Where | Lifetime |
| --- | --- | --- |
| Best distance, attempt count, best flight's altitude profile, per world | `localStorage` | Until the user clears browser data |
| Music on/off preference | `localStorage` | Until the user clears browser data |
| Call sign (dealt or typed) | `localStorage` | Until the user clears browser data |
| Resting point + metres per flight, anonymous aggregate per world | Redis (presence layer) | 14 days, then expired |
| Best distance + attempt count + opaque per-day token (planned, ghost layer) | D1 | ~7 days, then purged |
| Gzipped trail of the best flight (planned, ghost layer) | R2 | ~7 days, then purged |

Recent own-attempt trails are kept in memory only — they don't need to survive a
refresh, and keeping thirty of them in `localStorage` would be wasteful.

No IP, no user agent, no fingerprint, nothing joinable across days. There is nothing
to retain and no account to attach it to.

---

## Backend

**Built: the presence layer**, the first server the game has — two Vercel edge
functions over Redis (Vercel KV / Upstash via REST, no SDK dependency), holding
nothing but anonymous aggregates:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/flight` | One beacon per finished flight: world, resting point, metres, landed, call sign. Plausibility-checked (and the sign letters-only, capped), fire-and-forget from the client. |
| `GET /api/world?id=N` | The world's presence: total metres flown, and up to 400 resting points. Edge-cached a minute. |

Per world: one distance counter and a capped list (600) of resting points, both
expiring after 14 days. No token, no IP retained, nothing joinable — rule 5 holds
because there is nothing to join. The client degrades to silence: offline, dev,
or with no store configured, the game is exactly the solo game.

Deploy needs one thing: a Redis store attached to the Vercel project (the KV /
Upstash marketplace integration), which provides `KV_REST_API_URL` and
`KV_REST_API_TOKEN` — both names and their `UPSTASH_REDIS_REST_*` equivalents
are accepted.

**Planned: the ghost layer** — Cloudflare Workers + D1 + R2, chosen for
edge-cheap global reads (ghost fetches happen on every page load, worldwide)
and near-zero cost on a viral day. Worth revisiting whether it stays on
Cloudflare now that the presence layer lives in Vercel functions.

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
  terrain.ts      heightfield generation, per-day shape and landforms, sampling
  palette.ts      seven biome palettes in HSL, seeded hue rotation, daily grade
  air.ts          wind, thermal columns, ridge lift, thermal streets
  flight.ts       the flight model: fixed-timestep aero integrator, landings
  par.ts          the paper pilot: chase autopilot + the day's par
  tuning.ts       every tunable number, mutable for the live panel
  world.ts        day number -> seed -> biome, terrain, air, launch site, sun, moon
  flora.ts        forests, understories, per-day forest character and seasons
src/game/         the loop around the flying
  persist.ts      per-world records, the in-flight attempt marker, localStorage
  share.ts        the share card and the clipboard
  callsign.ts     dealt, rerollable, or typed pilot names
  net.ts          the presence wire: flight beacons in, world presence out
src/render/       R3F components; all transforms driven from one useFrame
  Terrain.tsx     vertex-coloured heightfield + per-pixel detail + cloud shadows
  Trees.tsx       two tree species plus two understories per biome, streamed
  Clouds.tsx      cumulus billboards, one per thermal
  Water.tsx       fresnel, glitter, swell, whitecaps, surf, soft shorelines
  Birds.tsx       flocks circling the nearest columns, and one skein passing through
  Herds.tsx       animals: sheep, deer, ibex, flamingos, seals, turtles
  RestingPlanes.tsx  other players' darts on the ground, with floating name labels
  Ghosts.tsx      your own previous attempts as faint lines, best brightest
  PaperPlane.tsx  the folded dart: crease facets, sun transmission, cloud shade
  Trail.ts        the live wake line
  Thermals.tsx    dust columns marking lift at close range
  Motes.tsx       near-field dust, wrapped around the camera
  Sky.tsx         gradient dome: sun, moon, cirrus, counter-glow, rays, ice halo,
                  daylight stars, falling stars
  Scene.tsx       the simulation loop, camera, ground shadow, persistence hooks
  atmosphere.ts   the fog constant and the cloud-shadow field every shader shares
src/audio/        Web Audio synthesis; no React inside music.ts
  music.ts        the day's generated score, coupled to lift and altitude
  useMusic.ts     owns the one instance, feeds it the flight
src/ui/           HUD, vario, results, share, signature, tuning panel
src/dev/          headless flight-model harness
api/              Vercel edge functions: the presence layer over Redis
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

The sea got its state in a later pass, all of it in the one fragment shader. A
long swell train runs along the day's wind — ~310 m crest to crest with a weaker
harmonic — tilting the same normal the chop perturbs, plus a few percent of
travelling brightness in the bands themselves, which is what makes the swell
*visible* rather than theoretical. (The lake-pulse lesson still holds: that bug
was a basin breathing in place; these are bands moving at swell speed, scaled to
the sea biomes and dying before the horizon.) Whitecaps appear where chop and
swell crest together, close in and wind-scaled. Surf runs in two regimes split
by distance, because the failure modes differ: near, a band of foam breathes
over the last metres of depth, pulsed by the swell phase so the edge crawls
along the beach; far, the band widens with distance so it never thins below a
few pixels and its animation freezes entirely. The first build animated a thin
band at every distance and put per-pixel chop into its phase, and the coasts
shook — the shaking-shoreline bug reborn in a new suit, one pass after it was
fixed. The strip-meter now reads distant coasts at exactly the no-surf
baseline. And the outer ocean lost its phantom coasts: beyond the map border
the height texture clamps to its edge row, which extruded the last coastline
outward as streaks of shallow tint running to the horizon; past the border
everything is now simply deep.

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

**The presence layer.** The first multiplayer, and it is deliberately not people —
it is consequences. Every finished flight leaves two anonymous facts on the
server: where the plane came to rest, and how many metres it flew. The metres
pool into one quiet line on the splash ("12,402 km flown here"); the resting
points render as paper on the ground — landed darts sitting upright on the slope,
crashed ones crumpled and part-buried, placed deterministically from the world's
seed so everyone sees the same drift. A beach below a popular thermal run silts
up with pale paper; an untouched far ridge stays pristine. The world reads where
humanity flew the way snow reads footprints. Water arrivals are skipped — paper
does not float for two weeks. The whole layer is strictly decorative and fails
silently to nothing: with no network or no store, the game is exactly the solo
game. Verified against a mocked API: the beacon posts the right shape, the
odometer renders, and a low pass over the field shows the drift.

The paper is signed. Every pilot carries a call sign — dealt from curated
lists (*Quiet Heron*, *Gloaming Fox*), rerollable, or typed: "flying as …
· change ↻" sits on the splash and the results screen, and editing happens
inline right there — never a prompt, never a modal, rule 7 stands. Typing a
name into a game that binds the whole keyboard is the real work: Space
launches, R rerolls, T opens the panel, so every game key handler stands down
while a text field has focus — without that, "Mar<space>" launches the plane
mid-keystroke. What travels is gated twice server-side: letters and spaces
only, capped (digits and symbols never enter the world, which kills most
leetspeak evasion), plus a short unambiguous blocklist — a blocked name ships
as anonymous paper, flight counted, signature withheld. The sign lives in the
world itself: a small label floats above the resting dart — "Gloaming Fox ·
2.7 km" — fading in a few hundred metres out, billboarded to the camera,
occluded by hills like anything that is really there. A pooled handful of
canvas-texture planes serves the nearest darts ahead; the pool's one hard
lesson was that "nearest" fills itself with darts *behind* the camera —
rendered perfectly where nobody looks — so candidates are filtered to the
forward hemisphere first. Every piece of paper on the ground is a small story
you have to descend to read. Older, unsigned paper stays anonymous, as it
should.

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

**The plane pass.** The aircraft is the one object on screen every frame, dead
centre, and it was still three triangles with a line behind it. Now: the dart has
real fold structure, each panel its own flat-shaded facet with its own tint, left
and right deliberately not quite matching — somebody folded this. Sunlight
transmits through the paper: a wing between the eye and a low sun glows warm, the
single most paper thing paper does, done in four shader lines. A soft shadow blob
hugs the terrain below and fades in under ~70 m — part grounding, part
instrument, because when you are skimming a ridge the shadow reads your clearance
better than the HUD does. The plane even dims under the cloud shadows, via a
TypeScript twin of the shaders' field, so it belongs to the same weather as the
ground it flies over.

The wake stayed a thin line, and that was a decision, not an omission. A tapered
ribbon version was built — corkscrewing through banked climbs, width and
brightness riding the airspeed — and it photographed beautifully and was too
much: the wake is a detail behind the aircraft, not a second protagonist, and a
filled additive surface glows with its whole area where a line glows with a
pixel. Reverted on sight. What survived from the experiment is a real bug fix:
**additive materials must never participate in fog** — fog mixes *toward* its
colour, so adding fog-coloured fragments tints any additive line cream at
distance regardless of its own colour. The wake and the ghost trails both now
opt out. When the ghost bundle lands, the ribbon geometry is on the shelf if the
score-band trails want more presence than a line.

**The terrain finale.** Four strands, one aim: ground that rewards being looked at.

Per-pixel ground detail, at last: the vertex colours live 32 m apart, so up close
the terrain read as airbrushed gradients. Two static noise scales — a ~40 m mottle
and a ~4 m grain, a few percent each — now break that up in the terrain's fragment
shader, each fading out before its features go sub-pixel. The sea shook twice to
teach that discipline; this field never animates at all, so what remains is
texture, not shimmer.

Beaches earned their keep: width scales by biome (the sea biomes get real strands,
alpine lakes keep their shingle), broadens where the ground shelves gently and
stays narrow under cliffs, and splits into two tones — pale dry sand above a
darker wet strip that sits exactly under the surf's foam band.

The landform list grew and then multiplied. `craters` scatters a handful of small
bowls — a meteor-pocked day — and `buttes` joined the coastal list, where the ones
that land offshore rise out of the shallows as sea stacks. Then the multiplier:
one day in four draws a *second* landform, so "rivers and buttes" and "caldera and
craters" are days that exist — the list's variety, squared, for a dozen lines. The
one forbidden pair is two carvers: rivers and canyons share the same ridge field,
and carving it twice cuts channels deep enough to glide down for free. The harness
re-blessed the distribution: no free rides, the hard tail intact.

And the woods got their own days. Each day draws tree height, girth and species
lean, so two valley days grow different forests instead of resampling one; a
second understory slot puts reeds around the lakes and ponds and dry grass tufts
on the new beaches; and roughly one day in six has a season — blossom turning the
broadleaf canopy toward the bloom colour, autumn toward the sun's gold — applied
through the same helper the terrain paints its forest tint with, so the trees and
the wooded ground under them turn together.

**The ritual.** Build step 5, and the moment the game became a daily one rather
than a beautiful toy: before this, a refresh erased everything. Records now
persist per *world* in localStorage — best, attempts, the best flight's
altitude profile, whether par fell and whether it ended in a landing — because
a share-card link opens someone else's world as an expedition, and a best on it
is worth keeping. The attempt marker closes the old spec gap:
counted at launch, refreshed every two seconds in flight, reconciled on the
next load, so refreshing mid-flight burns the attempt at its last recorded
sample. A tab left open overnight picks up the new world on refocus — never
mid-flight, and never when a specific world was opened on purpose. And the
player-facing language dropped "day" for "world": `?world=N`, "World 219 ·
gloaming coastal", because nobody experiences a day number.

Changing worlds got a veil: the live frame blurs away under dark glass with
"Imagining new worlds…", the second-long build runs while it is opaque, and
it lifts slowly off the new world. Two timing lessons inside it, both
measured: a removal timer burns down *during* the main-thread block, so the
veil unmounts on `transitionend` — an event that can only fire after the fade
truly played; and the real stall is not the React commit but the scene rebuild
that follows on the frame loop, so the veil holds until the scene reports the
new world's first rendered frame rather than lifting on a clock.

One thing the harness could never have caught, found by driving the real
page: the HUD passes pointer events through to the canvas so the screen stays
steerable, which made the share button silently unclickable until it opted
back in. Sharing is clipboard-only by decision — no native share sheet; the
player is pasting into a chat, and one click that says "Copied to clipboard"
is the whole job.

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

**The music knows you are flying now.** Three couplings, fed from the same draft
the HUD reads so nothing crosses the Canvas boundary. The variometer is a voice:
high bells riding the day's own chord, scheduled on every bar like everything
else, gated by a gain the climb rate drives — you learn to hear lift the way
glider pilots do, before the eyes confirm it. Altitude opens the master lowpass a
little, so height literally sounds airier and the ground darker: subconscious
altimetry. And a gentle landing rings a resolved tonic-and-fifth in the day's key
— the crash gets nothing, which is its own kind of feedback. Two side effects of
the pass: every pluck now sits somewhere in the stereo field instead of dead
centre, and the one `Math.random()` in the whole game — a decay-length shade in
the pluck voice — became seeded, so "everyone hears the same piece" is now
literally true.

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
- ~~The music has never been listened to by anyone.~~ It has now, and the verdict
  was "I really like the vibes." What remains unmeasured is the long tail: the
  piece is statistically flat over time (minute ten draws from the same
  distributions as minute one) and every day shares one progression in one mode.
  Slow macro-envelopes over the bar index and a small family of per-day
  progressions are the next knobs, sketched but not built.

---

## Build order

1. ~~**Flight model + debug terrain + instant restart.**~~ Done. Iterate until flying is genuinely fun and retrying is frictionless. *Stop here until it is* — everything downstream is worthless if the flight model isn't, and with unlimited retries the restart loop is part of the flight model.
2. ~~**Procedural terrain, palettes, fog, camera.**~~ Mostly done — six biomes, seeded palettes, distance fog, chase camera with roll. Still no clouds.
3. **Daily seeding and determinism.** Seeding is in and the harness verifies a rebuild is byte-identical; still need the two-browsers check.
4. **Flight recording, own-attempt ghosts, backend, other players' ghosts.**
   Recording and own-attempt ghosts are done — the remaining half of this step is
   the backend and everyone else's trails.
5. ~~**Share card, best-and-attempts screen.**~~ Done, minus the percentile
   line, which needs the backend. The streak was built here and cut — see the
   design rules.

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

**Streak with no server backup — resolved by deletion.** The streak was built,
shipped to the splash and the card, and then cut: a counter that punishes a missed
day is a guilt mechanic in a game whose promise is relaxation, and one that dies
with cleared browser data would have been the top complaint forever. The card
sells the flight, not the habit; the world is the reason to come back.

---

## Spec gaps to resolve before the ghost backend

**Nothing serves the percentile.** The share card wants "Top 12% today", but `/day` is
aggressively edge-cached, `/ghosts` is a trail bundle, and the flight beacon has no
specified response. Cheapest fix: return the percentile from the flight POST. Otherwise
ship a coarse distance histogram inside the ghost bundle and compute it client-side.

~~**Refresh reconciliation contradicts the persistence table.**~~ Resolved: the
in-flight marker exists — world plus distance-so-far, refreshed every two seconds
while flying, reconciled on the next load — so an abandoned attempt is logged at
its last recorded sample, exactly as the attempt rules demand.
