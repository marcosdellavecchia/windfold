# Paper Trail

> A daily paper-plane gliding game in the browser. One landscape a day, as many flights as you like, best distance is your record.

**Status:** build steps 1 and 2 done. Flight model, a 12 km procedural world with six
biomes, forests, lakes and sea, cumulus, birds, seeded daily worlds, air (wind /
thermals / ridge lift), chase camera, live wake trail, generated ambient music, and the
crash → retry loop all work. Everything from step 3 onward is unbuilt: no backend, no ghost trails from other
players, no share card, no streak, no persistence of any kind.
See [Built so far](#built-so-far).

**Name:** `Paper Trail` is a working title — decide before the backend lands, since it
propagates through the whole codebase.

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
and lets you step through days; `?day=N` loads a specific day directly.

`npm run sim:check` runs `src/dev/glideTest.ts`: launch-site pressure, hands-off
distance versus a thermal-chaining autopilot, trim stability, stall entry and recovery,
the dive-and-flare energy trade, turn rate, circling sink, thermal climb rate, and a
determinism check. It is the fast way to tell whether a tuning change broke something,
since most of these are invisible in a single hand-flown flight.

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

**Score is a single number: the longest distance in metres you reached today.
Alongside it, the number of flights it took.**

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
- **Restart must be instant.** With unlimited retries, any delay between crashing and flying again is the single biggest thing that will kill the session. No loading, no fade, no confirmation — the terrain is already resident, so re-launch should be a state reset and nothing more.

Physics is plain TypeScript, outside React. No physics engine — Rapier is overkill
for one glider and one heightfield raycast.

---

## Daily generation

- `dayNumber = days since <launch date>, in America/Los_Angeles`. Seeds a deterministic PRNG (mulberry32 or similar). Same input, same world, on every device.
- The seed drives terrain heightmap, thermal placement, wind vector, colour palette, time of day, and cloud layout.
- **Everything is procedural — ship no 3D model files.** This is what keeps first load under 3 seconds, which rule 7 depends on.
- Rotate biomes by day so consecutive days feel different: alpine ridges, desert mesas, coastal cliffs, forested valleys, volcanic badlands, archipelago.
- Wind and thermals are **fixed for the day, not re-rolled per attempt.** Retries must be a test of skill against a stable world, otherwise the best score is just whoever got the luckiest roll.

Determinism is testable and should be tested: two browsers, same day, byte-identical
terrain hash.

---

## Art direction

Beautiful landscapes are as much the reason to return as the score is.

- Stylised, not realistic. Large silhouettes, strong atmospheric perspective, heavy distance fog tinted to the day's palette, a low sun.
- One striking seeded colour palette per day. Vertex-coloured or gradient-ramped terrain rather than textures.
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
✈️  Paper Trail #142
1,847 m · 4 flights

▁▂▄▆█▇▅▃▂▁▁
🟦 Top 12% today
Streak: 6 🔥

papertrail.app
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
  terrain.ts      heightfield generation, bilinear sampling, gradients
  palette.ts      six biome palettes in HSL, seeded hue rotation
  air.ts          wind, thermal columns, ridge lift
  flight.ts       the flight model: fixed-timestep aero integrator
  tuning.ts       every tunable number, mutable for the live panel
  world.ts        day number -> seed -> biome, terrain, air, launch site, sun
  flora.ts        where forest grows, and the mask the terrain and trees share
src/render/       R3F components; all transforms driven from one useFrame
  Terrain.tsx     vertex-coloured heightfield, forest painted into the colour
  Trees.tsx       two instanced species, streamed around the camera
  Clouds.tsx      cumulus billboards, one per thermal
  Water.tsx       fresnel + glitter + ripple, no render target
  Birds.tsx       flocks circling the nearest columns
  Sky.tsx         gradient dome with a sun disc
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

Cumulus is the piece of scenery that is also a mechanic. Dust columns only carry about
2 km, which is one glide; clouds carry to the fog limit, so the sky is a map of where
the lift is and "head for the next cloud" is a rule players teach themselves.

Three shaders reproduce the scene's fog by hand, so `FOG_DENSITY` lives in exactly one
place (`render/atmosphere.ts`). Any disagreement shows up as a hard line along the
horizon.

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

- **The score metric is now the binding constraint, not the tuning.** Distance is
  straight-line displacement from the launch, so it is hard-capped by the map radius
  (~5.5 km) while a hands-off flight already reaches 1.0–2.4 km. That leaves at most
  ~4× of headroom for skill to show up in the number, even though using the air already
  triples or quadruples *time aloft*. Worth resolving before the share card fixes the
  format: keep displacement and push the floor down, score path distance flown, or score
  time aloft.
- **60 fps on a mid-tier Android is still unverified.** Desktop sits at 120 fps with a
  10 ms worst frame, so there is headroom, but nothing here has been measured on a
  phone. Terrain has no LOD, and the tree rescatter is a burst of a few thousand
  terrain samples every ~200 m of travel — the first thing to amortise if it hitches.
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
