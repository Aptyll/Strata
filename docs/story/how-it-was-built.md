# How Strata was built

*One person, one evening, more than fifty AI agent threads, and a race toward a
trillion particles. Reconstructed from the git history, the 41 pull requests and
the project chat. All times are US Central, Nov 18, 2026.*

> This was written by one of the agents: the "storyteller" thread, started at
> 7:27 PM to tell this story. It reports what the record shows, including what
> broke and what nobody has measured yet. It is a snapshot taken around 7:40 PM,
> fifteen minutes before the evening's 7:55 PM deadline, so some outcomes were
> still open when it was written. Those are marked.

## The short version

| | |
| --- | --- |
| First message to the coordinator | 6:54 PM |
| Repository created (empty) | 6:55 PM |
| First pull request merged: the shared contracts | 7:05 PM |
| Particle engine on main | 7:12 PM |
| App worth opening (camera, HUD and dice wired in) | 7:16 PM |
| Trillion-particle offline renderer on main | 7:27 PM |
| First real-GPU performance numbers | 7:31 PM: 100 million particles at about 111 fps, 800 million at about 15 fps (1080p, bench page) |
| First trillion-particle 4K still | 7:34 PM, 28.9 seconds on the RTX 2070, all 10^12 particles evaluated |
| Pull requests merged by 7:27 PM | 41, in 22 minutes 32 seconds |
| Pull requests merged by 7:36 PM | 54 |
| Longest any of the first 41 stayed open | 51 seconds (median 9) |
| Lines added | about 36,300 (code, shaders, docs, one lockfile) |
| Agent threads started by 7:28 PM | 52 |
| Threads whose code is on main | 18 |
| Code written by the human | none |
| What the human typed | 39 chat messages, plus 4 taps on decision cards |
| Real GPUs in the project | 1, an RTX 2070 with 8 GB |

The director's previous personal best was 4 million particles. The goal was
1,000,000,000,000. That is 250,000 times more.

## The cast

- **Noah**, the director. He set the goals, made the calls and wrote no code.
- **The coordinator**, a single Claude session in the project chat. It started
  threads, routed Noah's messages to the threads they concerned, turned every
  question into a tap-to-answer card, and reported status.
- **The threads.** Each is an independent Claude agent with its own cloud
  machine, its own git branch and one job. The first wave ran on a fast model at
  medium effort. Later waves added the largest model at maximum effort for the
  trillion path, for code review, and for threads that only think.
- **One real GPU.** Every cloud thread ran on CPU-emulated graphics
  (SwiftShader). The only real graphics card in this story is the RTX 2070 in
  Noah's desktop, which an agent reached through Remote Control at 7:20 PM.

## 6:54 PM: "As many particles as we can possibly imagine"

Noah opened with the brief: spend the rest of the week's usage, start many
threads, and build a particle simulation. A minimalist black void with white
particles. And the real challenge: "find a way we can visually show more pixels
on the screen moving around than we have resolution."

His idea was a 3D space full of 2D sheets of paper, each sheet running its own
particle behavior, so turning the camera reveals different emergent systems. A
world larger than the camera.

The coordinator asked for a repository. Noah created an empty one at 6:55 PM
and named it Strata, after the coordinator's suggestion: layers of particle
sheets stacked in a void. Within a minute an engine thread was running. At
6:56 PM Noah set the clock: "we have a lot of usage, and we need to spend it in
under an hour."

By 6:59 PM there were 13 threads: the engine, camera feel, the HUD, the
first-run experience, scale, density rendering, depth cues, world layout,
particles crossing between sheets, MP4 capture, a behavior system, a behavior
browser and a starter library of behaviors.

## 7:02 PM: Contracts before code

Thirteen agents writing code for a codebase that does not exist yet is a recipe
for thirteen incompatible prototypes. At 7:02 PM Noah asked the coordinator to
"start thinking abstractly as the lead architect." It answered 22 seconds later
with six rules:

1. **One contract, owned by the engine:** a few small interfaces (`Behavior`,
   `PlaneDesc`, `Pass`, `CameraController`, `UIPanel`) that every thread builds
   against, and nothing else.
2. **One serializable world state:** a JSON scene plus a seed reproduces any
   moment.
3. **One frame graph** with a fixed order: simulate, interplane, rasterize,
   depth, tonemap, ui, capture. Threads plug in passes instead of fighting over
   the canvas.
4. **One shared particle budget.**
5. **One design language:** a token file, so separate hands feel like one.
6. **One integration thread** whose only job is to wire merged pieces into the
   app and keep main running.

Noah: "Go with your recommendations, but try to keep it effective."

The engine thread already had a working engine in its own workspace. Instead
of merging it, it pulled the interfaces out and merged those first:
`src/core/contracts.ts` and `docs/architecture.md`, PR #1, at 7:05 PM. The
engine itself followed seven minutes later in PR #7. Every other thread built
against the contract, not against each other.

A few mechanical rules made the parallel work hold together:

- **Add files, don't edit shared ones.** Behaviors, passes and panels register
  themselves by filename (`src/behaviors/<id>.behavior.ts`,
  `src/passes/<name>.pass.ts`, `src/ui/<id>.panel.ts`), so no two threads had to
  touch the same registry.
- **Missing hooks go in as tiny contract PRs.** PRs #9, #10 and #11 each
  changed under 100 lines, and new hooks were kept optional so nobody else's
  build broke.
- **Every feature gets its own demo page,** so it can be seen before the engine
  exists.
- **Agents merge their own PRs,** always through a pull request rebased on the
  latest main. Noah granted this at 7:01 PM.

## 7:04 PM: The goal changes, twice

At 7:04 PM Noah reset the priority. A "challenge" mode, "honestly the main thing
you work on," to get an MP4 of the most particles possible. Thirty seconds later
he cut scope so that behaviors would not get in the way.

The cuts were real:

- Six behavior families had been proposed: boids, Particle Life, slime-mold
  trails, reaction-diffusion, N-body gravity and curl-noise flow. The library
  shipped three cheap ones (curl flow, a strange attractor, gravity wells; PR
  #25). The contract forbids a particle from reading its neighbors, which keeps
  the per-particle cost flat and makes boids, Particle Life and slime molds
  impossible for now. That was a deliberate trade.
- The behavior browser (gallery, breeding, morphing) was cut to one dice button
  that rerolls the scene.
- An audio-reactive mode was proposed and never started.

By 7:06 PM the challenge had tiers: 100 million simulated particles in realtime
at 30 fps, then 1 billion offline in a 4K60 MP4, with 10 billion as a stretch.

At 7:07 PM Noah raised it: "Make an impossible goal of 1T or something crazy.
I've achieved 4 Million particles before, but that was months ago with way worse
models."

The coordinator accepted, and in the same message pointed at the wall: "Being
honest: 1T particles can't be stored anywhere, since even 1 byte each is a
terabyte." The card in Noah's desktop has 8 GB. At the 16 bytes per particle the
realtime engine uses, a trillion particles is 16 TB, about 2,000 times the
card's memory.

The only way through is **stateless** particles. Nothing is stored. A particle
is just a number, its index, and its position is a formula:
`position = f(index, seed, time)`. To draw a frame, the GPU loops over all
trillion indices, computes each position, adds a speck of light to that pixel,
and forgets the particle. Memory is just the image: tens of megabytes for a 4K
grid of counters. The cost moves from memory to compute: a trillion formula
evaluations per frame.

The price is honesty about what it is. Stateless particles cannot react to each
other, so the motion is choreographed by the formula, not emergent. The project
split its claims from then on: the 100 million and 1 billion tiers are
*simulated*; the trillion is *rendered*, reported separately and labeled.

At 7:08 PM: "Alright, our goal is 1 Trillion particles."

## 7:10 PM: "I don't see any progress"

Sixteen minutes in, Noah wrote: "What are the blockers, most threads are saying
"working", but i don't see any progress."

Nothing was blocked. Five PRs had merged (contracts, camera, dice logic,
behavior tools, HUD) and the world generator merged 23 seconds after he asked.
But there was no engine on main, so there was nothing to open. Every piece had
been tested only against stand-ins. This is the strange shape of parallel work:
plenty of finished parts and no visible whole.

His answer shaped the rest of the night. At 7:11 PM he asked whether the threads
could stop waiting and build toward the finished product in parallel, each as a
self-contained piece that plugs in when the engine arrives, and he told the
coordinator to explain the request back to him before passing it on. It did, he
confirmed, and it became a project rule.

The engine merged at 7:12 PM. By 7:13 PM the app ran on main. At 7:16 PM, with
the camera, HUD and dice wired in by the integration thread (PR #13), the
coordinator called it "worth opening."

## 7:13 PM: Speed over verification

At 7:13 PM Noah made the trade that defined the build: "Make sure these threads
don't run exhaustive tests that will stall out time, the time is ticking, so make
them work fast and in theory, we will test in the end. Just make sure they write
good code." The rule became: type check and a quick build, nothing more. Real
testing happens at the end, on his GPU.

Two minutes later he added another: every question to him arrives as a
tap-to-answer card, never an open question. Four cards decided big things that
night: where to put the strongest model, whether to send an agent to his real
GPU, how to add reviewers, and which new agents to start.

Here is what speed over verification looks like in the record. Forty-one pull
requests merged between 7:05:01 and 7:27:33 PM. None stayed open longer than 51
seconds, and more than half were merged within 9 seconds of being opened. No
pull request was open long enough for anyone else to review it: each was merged
by the agent that wrote it, after its own type check and build. Review happened
after merging, if at all.

## 7:17 PM: Thinkers, a real GPU and a stronger model

Around 7:17 PM the shape of the team changed.

- Three threads on the largest model at maximum effort were told to write no
  code at all: think about the video's cinematography, its YouTube packaging and
  how to make the trillion claim believable, and hand back a prompt within 10 to
  20 minutes.
- Three more went on the trillion push: stateless motion that looks alive, a
  trillion-particle splat kernel, and an independent reviewer of both.
- Two visual QA threads started running the app, taking screenshots and
  annotating them for the threads that own each feature.
- At 7:20 PM an agent started on Noah's own desktop through Remote Control, the
  first and only agent with a real GPU. It found the RTX 2070. Windows app
  control blocked one of Vite's native modules, so it switched to the
  WebAssembly build. Its first real-hardware result was a correctness check: the
  perf engine's self-test passed 25 of 25 on the 2070.

## 7:20 PM: The collision

At 7:19:59 PM, PR #27 (pointer forces on the GPU) merged. At 7:20:23 PM, 24
seconds later, PR #29 (screenshots and recording) merged. Each had passed its
own build. Together they broke main. PR #29 had split the frame loop into a new
function, and PR #27's new code still read a variable, `now`, that no longer
existed in that scope. `npm run build` failed with
`src/main.ts(295,47): Cannot find name 'now'`, and the app threw on every frame.

The integration thread caught it and shipped a one-line fix, PR #32, at
7:21:56 PM. Main was broken for 93 seconds.

Seventy-one seconds after the fix, the agent on Noah's desktop reported the same
bug from real hardware, saw it was already fixed on main, and dropped its own
patch.

This is the only time main broke, as far as the record shows. It is exactly the
failure the rules were built to prevent, and it shows their limit: a type check
before merging protects each pull request, not the combination of two pull
requests merged 24 seconds apart.

## 7:21 PM: Reflection

At 7:21 PM Noah asked for agents "not attached to the code" that "can see our
work from a different perspective." Five started: an architect, an artist, a
skeptic, a first-time viewer and a strategist.

Two minutes later the coordinator summarized them. Three had independently
reached the same conclusion: **the bottleneck is proof, not headcount.**

- No trillion code was on main yet.
- Not a single real-GPU performance number existed.
- Main had briefly broken.
- Effort was duplicated: the fast 8-byte-per-particle engine was not plugged
  into the app, four rasterizers excluded each other, and the 18-second intro had
  been built but never wired.

That last point was already stale. The intro had been wired into the app (PR
#36) at 7:23:25 PM, 18 seconds before the summary was posted. At this speed even
a critique has a shelf life of seconds.

The skeptic was the most useful of the five. It insisted the trillion be called
"rendered" and never "simulated," because real cosmology simulations with
trillions of particles exist and this is not one. It found a trap: if each
particle's random numbers come from chained 32-bit hashes, there are only about
4.29 billion distinct particles, repeated over and over. And it listed what a
skeptical viewer would need to see: an on-screen count that sums to exactly
10^12, zooms that resolve single dots, and a published seed and code.
The fix (64-bit keys, PR #45) landed, but the first trillion stills had already
been rendered on the old 32-bit keys: their sheets reuse about 4.3 billion key
values, each sheet under its own transform, and the stacked compositions A and
B repeated particles outright. They were re-rendered on 64-bit keys
(`docs/record/README.md`, "Distinct particles and keys").

The artist proposed the best ending for the video: collapse all trillion
particles into a single white pixel, identical to the opening frame.

The strategist suggested writing this document, on the theory that the story of
how it was built might outperform the render itself.

Noah's response was to make the largest model the default for every new thread
(7:23 PM), point new threads at the trillion critical path, and pair the fast
builders with reviewers from the stronger model that fix their PRs (7:24 PM).

## 7:27 PM: The trillion renderer lands

PR #41 merged at 7:27:33 PM: `src/offline/`, a standalone renderer for clips of
up to 10^12 particles per frame at 4K, written to MP4. 3,408 lines in 21 files.

- **Stateless, with real physics.** Each particle's position is evaluated from
  its sheet's seed, its index and the time, using closed-form solutions of real
  equations of motion: Kepler orbits with spiral density waves, tracers in a
  circular shear flow, and 2D harmonic oscillators. It is not a time-stepped
  simulation, and the label burned into the video says so: "stateless:
  closed-form motion".
- **Exact counting.** With count weighting (the proof shots; the record
  stills used flux weighting, where far particles are drawn on average), every particle in view adds one unit of light to a 64-bit integer
  grid, built from two 32-bit atomic words with an exact carry. Integer addition
  does not care about order, so a frame is bit-identical however the GPU
  schedules the work, and the grid's total divided by one unit is exactly the
  number of particles in view. That is the on-screen tally the skeptic asked
  for.
- **Built to run for hours.** Each frame is saved as a 16-bit PNG plus a stats
  file. A frame in progress is checkpointed every 5 minutes, Ctrl+C and a rerun
  continues where it stopped, and `--shard i/n` splits a clip across machines.
- **Checked on emulated hardware.** On SwiftShader it counted 937,035 of 937,035
  particles, produced identical grids from 20 batches and from 3, resumed from a
  checkpoint exactly, and agreed with a double-precision CPU reference (about
  0.086% of particles land one pixel over, from 32-bit versus 64-bit floats).

What it had not done when this was written: render a trillion-particle frame on
a real GPU. On SwiftShader it ran about 25 million particles per second, which
would make one trillion-particle frame take about 11 hours. Estimates for the
RTX 2070 in the chat ranged from roughly 20 to 100 seconds per frame. Nobody had
measured it. About a minute after the merge, the coordinator told the desktop
agent that this was its top priority: benchmark the renderer on the 2070, then
render one trillion-particle 4K still.

At 7:27 PM Noah set the deadline: finish before 7:55 PM.

## 7:28 PM: The last stretch

The final half hour moved faster than anything before it. Thirteen more pull
requests merged between 7:30 and 7:37 PM, most of them on the trillion path.
After Noah's 7:26 PM request, new branches also got readable names like
`feat/trillion-splat-kernel` and `fix/gpu-dispatch-limits`.

- **7:31 PM: the first real numbers.** The desktop agent's benchmark went into
  `docs/perf.md` (PR #44). On the RTX 2070 at 1080p, with every particle
  simulated and drawn every frame, 100 million particles took 8.99 ms per frame
  (about 111 fps), 400 million took 34.9 ms (about 29 fps) and 800 million took
  68.3 ms (about 15 fps). With culling and level of detail, which thin out
  particles that are off screen or far away, 800 million ran at 54 fps. The card
  holds about 900 million particles at 8 bytes each. These numbers come from the
  perf engine's bench page; that engine was still not wired into the main app.
- **7:32 PM: the hash trap closed.** About ten minutes after the skeptic flagged
  it, every stateless particle got its own 64-bit key (PR #45), and the offline
  renderer switched to those keys a minute later (PR #47), on top of a check
  that no two sheets share a seed (PR #43).
- **7:34 PM: one click to a trillion.** A trillion-particle 4K still or clip can
  now be launched from the Esc menu or with `?record` (PR #48). Proof shots
  followed (PR #49): a count-up from one particle, a pull-back, a pixel loupe, a
  dive, and finding particle number N. A trillion-particle splat kernel with
  exact per-pixel counts landed nine seconds after that (PR #50).
- **7:34 PM: the first trillion.** On Noah's desktop the agent benchmarked the
  offline renderer in Chrome, because Windows app control also blocked the Node
  GPU module: 3.3 billion particles per second on a frame-filling sheet. Then it
  reported the first trillion-particle 4K still, rendered in 28.9 seconds.
- **7:36 PM: public.** A GitHub Pages deploy, a rewritten README and an MIT
  license merged (PR #55).

Two of those numbers did not obviously agree. A trillion particles in 28.9
seconds is about 35 billion per second, roughly ten times the frame-filling
benchmark. This document's first version flagged it. At 7:35 PM a pull request
landed that counts evaluated particles on the GPU and refuses any frame that
misses one (PR #52), and at 7:39 PM the frame stats from Noah's desktop, as
relayed by the coordinator, showed exactly 1,000,000,000,000 particles
evaluated in every trillion frame. Every position is computed; particles that
land off screen only skip the final atomic add. The gap with the benchmark is
the cache. The first still's cluster lit only 4% of the 4K frame, so its hits
stayed in the 2070's 4 MB L2 cache, while the benchmark's single camera-filling
sheet spreads hits over the whole grid and pays a trip to video memory for most
of them. With flux weighting (far particles drawn on average), real trillion frames
took 26 to 52 seconds when the sheets covered part of the frame and 161 to 205
seconds when they filled it (composition A). Count weighting, one exact unit
per particle in view, took about 160 to 193 seconds per frame.

The first trillion frame was also honest about how it looked. The agent that
measured it wrote that it "reads as grey confetti, not as a trillion": 96% of
the pixels were exactly black, the sheets were 20 to 60 pixels across, and the
lit ones held about 3 million hits each. Framing, not counting, became the last
problem of the night.

When this was written, the desktop agent was rendering three framed
trillion-particle hero stills that Noah had picked on a decision card, to be
followed by a one-second trillion-particle clip, with no new frames started
after 7:50 PM.

## What worked

- **Contracts before code.** Publishing the interfaces seven minutes before the
  engine let a dozen threads build real pieces in parallel instead of waiting.
- **Rules that remove shared files.** Add-don't-edit plus auto-registration by
  filename meant most PRs touched only their own folder, which is a big part of
  why 41 merges in 22 minutes broke the build only once.
- **A dedicated integration thread.** Somebody owned the whole app. It wired
  pieces in and shipped the one-line fix within 93 seconds.
- **A coordinator that translates before it broadcasts.** Twice Noah asked it to
  explain his request back before telling the threads anything, and both times
  that produced a project rule that every later thread inherited.
- **Decision cards.** With dozens of agents and one human, every question became
  one tap. The human stayed the bottleneck only for real decisions.
- **Thinkers who don't code.** The skeptic, the artist and the strategist found
  the problems that builders heads-down in their folders could not see,
  including the 32-bit hash trap and the "rendered, not simulated" wording.
- **Honesty built in early.** The memory wall was named in the same message that
  accepted the trillion goal, and the renderer burns its own disclaimer into the
  video.

## What broke, and what nobody has verified

As of about 7:38 PM:

1. **Real numbers arrived late, and only for the bench.** Until 7:31 PM no
   performance number existed for any part of the system. The first ones came
   from the perf engine's bench page, not the main app. The main app, challenge
   mode, camera feel, depth cues and world streaming had not been measured or
   tuned on the 2070.
2. **The trillion counts, but it is not yet a picture.** The frame stats show
   all 10^12 particles evaluated in 26 to 52 seconds per frame for the
   wide and medium views (flux weighting; frame-filling shots took about 3 minutes). The first wide
   shot still read as grey confetti, and the framed hero stills and the moving
   clip were rendering when this was written.
3. **The trillion is choreography, not emergence.** Stateless particles follow
   formulas and cannot react to each other. The simulated tiers are the true
   simulation claim, and they had no real-GPU numbers either.
4. **Distinctness is fixed in code, not yet proven.** The 32-bit hash trap was
   addressed between 7:30 and 7:33 PM (a unique seed check, then a 64-bit key
   per particle). A dedicated thread ("Prove the trillion particles are
   distinct") was still checking statistically that no particles repeat.
5. **Nothing was reviewed before merging.** Every PR was merged by its author
   within 51 seconds of opening, after only a type check and a build. A shader
   reviewer thread (started 7:04 PM) checked code after it landed, and partner
   reviewer threads started at 7:24 PM, after 38 of the 41 PRs had merged.
6. **Duplicated effort.** Two particle engines (the realtime simulation and the
   8-byte `PerfEngine`, which runs on its bench page but is not wired into the
   main app), four rasterizers, the camera rig built twice (folded together in
   PR #37) and tone mapping written twice (one copy removed in PR #30).
7. **Main broke once,** for 93 seconds, when two PRs merged 24 seconds apart.
8. **Cloud testing was blind.** On the emulated GPU, drawing to a canvas lost
   the device, so cloud agents rendered offscreen and read the pixels back.
   Camera feel, depth cues and world streaming had never been tuned on a real
   screen.
9. **Branch names were unreadable.** Until 7:30 PM every agent pushed to a
   branch like `claude/project-thread-oa2ov6`. Noah asked for readable names at
   7:26 PM, and later branches read like `feat/trillion-proof-shots`. This
   document's branch is `docs/build-story`.

## Appendix: every merged pull request

Merge times from the git history of `main` (Central time), through 7:36 PM.
Every one came from an agent's branch.

| Merged | PR | Title |
| --- | --- | --- |
| 7:05:00 PM | #1 | Add shared contracts, architecture doc and toolchain |
| 7:07:05 PM | #2 | Add camera rig, input bindings and navigation design doc |
| 7:08:55 PM | #3 | Add dice roll: rollScene and startRoll transition |
| 7:09:33 PM | #4 | Add behavior param, preset and WGSL block tools |
| 7:10:14 PM | #5 | Add minimal HUD: randomize dice, stats on a hotkey, Esc settings menu |
| 7:11:06 PM | #6 | Add world layouts, seeded generator and plane streaming |
| 7:12:13 PM | #7 | Add the particle engine: GPU simulation, frame graph, passes, camera |
| 7:12:51 PM | #8 | Add perf path: packed 8-byte particles, compute rasterizer, culling and LOD |
| 7:14:09 PM | #9 | Contracts: optional AppContext.setRender for live render settings |
| 7:15:23 PM | #10 | Contracts: add and remove planes at runtime, per-plane brightness and pause |
| 7:15:43 PM | #12 | Add first-run experience: intro, cursor forces, gestures, hints, WebGPU fallback |
| 7:15:52 PM | #11 | Contracts: optional AppContext.setPlaneBehavior |
| 7:15:57 PM | #13 | Wire camera rig, HUD, compute rasterizer and adaptive budget into the app |
| 7:16:08 PM | #14 | HUD: settings built from the contracts, stats switch, wired standalone demo |
| 7:16:29 PM | #15 | Add depth cues: fog, depth of field, size falloff, parallax |
| 7:16:44 PM | #18 | Add shader verify harness and GPU scale guide |
| 7:16:45 PM | #17 | Dice roll: change behaviors without a hard cut |
| 7:16:57 PM | #20 | Add density render pipeline: HDR splatting, trails, bloom, log tone mapping |
| 7:17:07 PM | #16 | Add a standalone camera demo and free keys the app owns |
| 7:17:16 PM | #19 | Add capture: PNG stills, MP4 recording, offline rendering, camera paths |
| 7:17:44 PM | #21 | HUD: first-visit die hint, centred message, shareable roll link |
| 7:17:53 PM | #22 | Stream the endless world into the engine |
| 7:17:57 PM | #23 | Add interplane edge crossing as a self-contained pass |
| 7:18:11 PM | #25 | Add curl-flow, strange-attractor and gravity-wells behaviors with a preview page |
| 7:18:23 PM | #24 | Use the HUD's own settings, smooth dice rolls, and add depth sprites as a rasterizer |
| 7:18:36 PM | #26 | Use the density tone mapper in the app |
| 7:19:39 PM | #28 | Wire capture, density render passes and plane crossings into the app |
| 7:19:59 PM | #27 | Pointer forces on the GPU: brush contract, shader hook, wired into the app |
| 7:20:23 PM | #29 | Wire capture into the app: P screenshot, V record, stills and offline video in the menu |
| 7:20:42 PM | #30 | Use the tonemap pass's density look instead of a second copy |
| 7:21:35 PM | #31 | Add rendering field guide explainer |
| 7:21:55 PM | #32 | Fix main build: brush update used a variable that moved out of scope |
| 7:22:39 PM | #33 | HUD: job launcher and status line for offline renders and exports |
| 7:22:42 PM | #34 | Perf engine runs the shared behaviors and planes at 8 bytes per particle |
| 7:23:10 PM | #35 | Add Challenge mode: ramp to the largest particle count that holds the frame rate |
| 7:23:24 PM | #36 | Wire the first-run opening and the no-WebGPU fallback into the app |
| 7:23:29 PM | #37 | Fold the first-run experience camera into the shared camera rig |
| 7:24:30 PM | #38 | Add a settings entry that opens Challenge mode |
| 7:24:52 PM | #39 | Add CountToneMapper: tone mapping straight from u32 or u64 hit counters |
| 7:25:40 PM | #40 | Depth: pointer parallax in the app, lens sampling for point renderers |
| 7:27:33 PM | #41 | Add the offline stateless renderer for the 1 trillion particle video |
| 7:30:10 PM | #42 | Ship challenge, offline renderer, bench and verify pages in the production build |
| 7:30:42 PM | #43 | Offline renderer: exact in-frame tally, cancel via AbortSignal, unique seed check |
| 7:31:00 PM | #44 | Record RTX 2070 numbers, add profiling switches to the perf bench |
| 7:32:22 PM | #45 | Give every stateless particle its own 64-bit key |
| 7:33:26 PM | #46 | Depth: keep lens rim pick and angle independent |
| 7:33:33 PM | #47 | Offline renderer: use the shared 64-bit particle keys from src/stateless |
| 7:34:18 PM | #48 | Launch a 1 trillion particle 4K still or clip from the Esc menu or ?record |
| 7:34:48 PM | #49 | Add trillion proof shots: count-up, pull-back, loupe, dive, find particle #N |
| 7:34:57 PM | #50 | Add the trillion particle splat kernel with exact per-pixel counts |
| 7:35:11 PM | #51 | Fix dispatch overshoot and depth sprite brightness |
| 7:35:36 PM | #52 | Count evaluated particles on the GPU and refuse frames that miss any |
| 7:36:14 PM | #55 | Deploy to GitHub Pages, rewrite the README, add the MIT license |
| 7:36:41 PM | #53 | Share one shader prelude between the engine and the perf path |

## How this was put together

Sources: the git history of `main`, the 41 pull request descriptions on
GitHub, the project chat transcript and the list of agent threads. Times come
from GitHub merge timestamps and chat message timestamps, converted to Central
time. Line and file counts were computed from the repository at commit
`c42ceda` (PR #41). Durations such as "open for 51 seconds" are the gap between a pull
request's creation and merge timestamps. Anything described "as of 7:28 PM" was
still in progress when this was written.

The companion video script is in [video-script.md](video-script.md).
