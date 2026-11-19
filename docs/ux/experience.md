# Strata: first-run experience and interaction

How Strata opens, how people find out what it is, and how they touch it.
The code lives in `src/ux/experience/` and runs today without the engine:

```
npm run dev
open http://localhost:5173/src/ux/experience/demo/index.html
```

Demo switches: `?intro=full|short|reduced`, `?fallback=no-api|no-adapter|insecure-context`,
`?planes=32&per=5000`, `?debug=1`, `?nopersist=1`. Press `r` to replay the opening.

## Principles

1. **Nothing on screen but particles.** No logo, no loader, no start button, no
   cursor ring. The only text that ever appears is one line of hint and a
   particle counter, both dim, both temporary.
2. **The reveal is the product.** People should believe they are looking at a
   pleasant 2D particle toy, and then have that belief taken away. Everything
   in the first fifteen seconds serves that turn.
3. **Never take the controls away.** Any input at any moment works immediately.
   The opening is a default camera move, not a cutscene.
4. **Move to look, hold still to touch.** One rule covers mouse, pen and finger.
5. **Every device gets something.** No WebGPU means a smaller world, not an
   error page.

## The opening

Implemented in `intro.ts` as `introState(t)`, a pure function of seconds since
the first frame. It returns brightness, how much of the first plane is visible,
how far the ignition has spread, and where the camera wants to be.

| Beat | Seconds | What happens | Why |
| --- | --- | --- | --- |
| hold | 0.0 to 0.8 | True black. | Lets the eye settle, and covers engine start-up. If start-up runs long, the hold simply lasts longer; the clock starts on the first rendered frame. |
| spark | 0.8 to 2.0 | One particle, centre screen. The counter reads `1`. | Sets the unit. Everything after this is measured against one. |
| bloom | 2.0 to 6.5 | The first plane fills in outward from the spark, face-on, edges off screen. | With no edges and no perspective, it reads as a flat 2D simulation. This is the belief we are about to break. |
| tilt | 6.5 to 11.0 | The camera swings 35 degrees off-axis. | The flat image turns out to be a sheet hanging in space. |
| pullback | 9.5 to 16.5 | The camera retreats. Other planes ignite outward from the first: neighbours one at a time, then the rest in a rush. The counter races. | The scale reveal. The eye counts the first few sheets, then gives up. Overlapping the tilt means the first neighbours appear edge-on, as thin lines of light, before they are understood as more sheets. |
| settle | 16.5 to 18.0 | Motion eases out, the camera is released, the counter dims. | Hand-over. |

After a few seconds with no input the camera begins a very slow drift, so the
world is never a still image.

**Taking over early.** The first press, scroll or key releases the camera
within 0.4 s and plays the rest of the ignition in 1.4 s. It never cuts, so
the person who grabs the camera at second three still sees the world light
up, just faster, and around their own gesture. In the app (`src/app/intro.ts`)
a press, a scroll, a camera key or G (fly to the nearest sheet) lets go of
the camera on that same frame, because easing out would overwrite the start
of the drag or cancel the flight; other keys (H, Esc, R) keep the 0.4 s ease.

**Returning visitors** get the same story at 3.2x speed (about 6 s). The hold
is kept at full length, because black still matters.

**Reduced motion** (`prefers-reduced-motion`) gets no camera travel at all: the
finished wide shot fades up over 2.5 s.

**The counter.** Bottom left, monospace, dim. It counts particles as planes
ignite and stays as the only permanent readout. It is the one place the
"more particles than pixels" claim is stated, and it is stated as a number,
not as a sentence. In the demo it is driven by a stand-in total; in the
product it should read `AppContext.stats().particles`.

## Discovering the planes

Nobody is told there are many planes. They find out four ways, in order of
how much effort each takes:

1. **The opening shows it.** The tilt and pullback above.
2. **The world shows it again.** Idle drift keeps rotating the stack, so
   sheets keep crossing from face-on to edge-on.
3. **The cursor shows it.** The sheet under the pointer brightens slightly.
   Sweeping the mouse across the stack makes sheets light up one after
   another, which says "these are separate things" without a word.
4. **Diving shows it.** Scrolling or pinching moves the camera in through the
   stack. Sheets pass through the lens one at a time like turned pages, each
   with a different behaviour.

Double-clicking or double-tapping a sheet flies the camera to face it
squarely, filling 86% of the view. This is the "flat 2D sim" view from the
opening, now chosen. While a sheet is focused the cursor only touches that
sheet. A double click on empty space, the Home key, or zooming well out
returns to the wide shot. `[` and `]` step through sheets. These match the
camera module's controls in `docs/ux/camera.md`.

## Touching the particles

The pointer is a ray from the camera (`pointer-ray.ts`). It hits the nearest
lit sheet, and the hit is converted to that sheet's own coordinates, so the
simulation receives `(plane, u, v)` and never needs to know about the camera.

Three levels of force (`force-brush.ts`):

| Input | Effect |
| --- | --- |
| Move over a sheet | A faint wake: particles part around the moving pointer. Zero when the pointer is still. |
| Hold still, then drag freely | An attract well. It starts at 35% and deepens over 1.6 s, widening as it charges. |
| Release | An outward burst scaled by the charge. "Gather, then let go" is one complete gesture. |
| Right button, or Shift/Alt + hold | Repel: a pressure bubble. In the app a right drag pans the camera, so the right button also waits for the hold there. |

Details that matter for feel:

- **Brush size is constant on screen** (90 px radius), converted to plane units
  at the hit point. Zoomed in, the brush is a fingertip; zoomed out, it is a
  hand.
- **The well has a soft core.** Force falls to zero at the centre, so gathered
  particles form a ring instead of collapsing into one pixel.
- **Edge-on sheets cannot be grabbed.** When a sheet is nearly edge-on, one
  pixel of mouse travel sweeps across the whole sheet. Force fades out below
  about 17 degrees and is zero below 3.5 degrees, and the ray passes through
  to whatever is behind.
- **Changing sheets never smears.** When the hit jumps from one sheet to
  another, the brush restarts there with zero velocity.
- **Up to four brushes at once**, one per finger.
- **No forces before the first plane has bloomed.** There is nothing to push.

### Gestures

`gestures.ts`. The recogniser is a pure state machine (`GestureCore`), with a
thin Pointer Events binding.

| Intent | Mouse / trackpad | Touch | Keys |
| --- | --- | --- | --- |
| Turn the world | Press and move | One finger, drag | Arrows |
| Dive in / out | Wheel, trackpad pinch | Two-finger pinch | `+` `-` |
| Pull particles | Press, stay still 170 ms, then drag | Press, stay still 230 ms, then drag | |
| Push particles | Right button, or Shift/Alt + hold (in the app, right button + hold, since right drag pans) | (see open questions) | |
| Face a sheet | Double click it | Double tap it | `[` `]` |
| Back to wide shot | Double click empty space | Double tap empty space | Home |

A press that travels more than 5 px (10 px for a finger) before the hold
delay is a camera drag, and the travel inside that radius is not lost. A
second finger turns anything in progress into a pinch, and lifting one
finger of a pinch does not fire a tap.

### Hints

`hints.ts`. There is no tutorial. Each hint teaches one gesture, waits until
the person has had a fair chance to find it alone, and is retired for good
the moment they do it (remembered in `localStorage`).

`drag to turn` (after 6 s idle), then `hold to pull`, `scroll to dive in`,
`double-click a sheet to face it`. One line, bottom centre, small wide-set capitals
at 42% white. One at a time, never during the opening, never while a gesture
is in progress, and each is shown at most once per visit. Touch devices get
touch wording.

In the app, `app-hints.ts` (`mountAppHints`) runs the same schedule and adds
the HUD's breathing die as one more hint, right after `drag to turn`, so the
die and a text line never compete and nothing plays during the opening. It
also waits while the settings menu is open or a long job runs. The HUD's own
die timer is turned off with `diceHintMs: 0`, and the schedule starts and
stops the breathing with `hud.hintDice()`. Gestures are read from the canvas
with the same thresholds as the pointer forces and are never consumed.

## When WebGPU is not available

`capability.ts` decides, `fallback.ts` draws.

`detectCapability()` separates four situations, because each has a different
fix: the page is not on https (`insecure-context`), the browser has no WebGPU
(`no-api`), the browser has it but cannot reach the graphics card
(`no-adapter`), and the device was lost later (`device-failed`, to be raised
by the engine).

The fallback is the same black void and the same opening, with one real sheet
of particles simulated on the CPU and drawn with Canvas 2D (24,000 on desktop,
9,000 on touch). It responds to the same hold and wake gestures. After seven
seconds two lines fade in at the bottom:

> ONE SHEET. 24,000 PARTICLES.
> The full world is hundreds of sheets and 64 million particles. This version
> of Safari does not have WebGPU yet. Safari 26 or later, or a current Chrome
> or Edge, shows the full world.

The second sentence pair comes from `explainUnsupported()` and is specific to
the browser and cause. Below it is one button: "Send link to another device"
(share sheet) or "Copy link". Most people who land here are on a phone and
will want the link on a laptop.

No error codes, no "your browser is not supported", no red.

## Mobile

- **Budget.** `detectCapability()` picks a starting tier (2M, 16M or 64M
  particles) from pointer type, OS, memory, cores and adapter limits. It is
  deliberately low: growing into the budget looks like the world filling in,
  dropping frames looks broken. The engine's `ParticleBudget` takes over from
  measured frame rate.
- **Pixel ratio** capped at 2 (1.5 on the low tier).
- **Browser gestures are switched off on the canvas** (`touch-action: none`,
  no context menu, no pull-to-refresh, no page zoom), and hints respect the
  safe-area inset.
- **No hover on touch**, so the wake only exists while a finger is down and
  the "cursor shows it" discovery path is replaced by tapping.
- **Rotation and resize** are read every frame; the opening's close-up
  distance is recomputed from the current aspect.
- **Backgrounding** should pause simulation and rendering (the fallback does
  this on `visibilitychange`; the engine should too, and should treat a lost
  device on return as a silent restart with the short intro).
- **Not done on purpose:** gyroscope parallax. On iOS it needs a permission
  prompt, and a prompt on first load breaks principle 1.

## Plugging into the engine

**Camera overlap, stated plainly.** While this was being built, a dedicated
camera module landed in `src/ux/camera/` with a richer rig (pan, fly,
momentum, flights). `camera-rig.ts` here is now a thin front for that module, so the
demo, the intro and the product share one camera. The
experience needs only three things from a camera, and the camera module's
`CameraRig` already has all of them: `setPose()` while the intro owns the
view, `focusPlane()` / `flyHome()`, and `screenRay()` for the cursor. The
gesture rule "move to look, hold still to touch" is compatible with that
module's input (left drag orbits in both); the hold detection needs to be
merged into its pointer handling so one press is not read twice. That wiring
is the next piece of work after this PR.

`createExperience()` owns input, camera, intro, brushes and hints, and knows
nothing about WebGPU. The engine calls it once per frame:

```ts
import { createExperience, planeFromDesc, gainToActiveCount } from './ux/experience';

const xp = createExperience({
  canvas, overlay,
  planes: scene.planes.map(planeFromDesc),
  heroIndex, touch: cap.touch, reducedMotion: cap.reducedMotion,
});

function tick(now: number) {
  const f = xp.frame(now);
  // camera:     xp.rig implements CameraController (FrameContext.camera)
  // brightness: scene.render.brightness * f.exposure
  // ignition:   plane.activeCount = gainToActiveCount(budgeted, f.planeGain[i])
  // forces:     f.brushes, a Float32Array(32), see below
}
```

**Using the parts without `createExperience()`.** The app has its own camera,
HUD and key map, so each part also mounts alone:

| Part | Call | Needs |
| --- | --- | --- |
| Pointer forces | `attachBrushes(canvas, camera, () => planes)` then `writeGlobals({ brushes: b.update(dt, now) })` | any `CameraController`. Wired into `src/main.ts`. |
| Opening | `createIntroRunner({ planes, aspect })`, then `step(dt)` each frame | nothing. Returns exposure, per-plane gain for `PlaneDesc.brightness`, and a camera pose with a weight. |
| Hints | `mountAppHints({ canvas, hud, isOpening })`, then `update(dt)` each frame | the HUD, created with `diceHintMs: 0`. Lower level: `new HintScheduler()` and `createHintView(root)` |
| No-WebGPU screen | `mountFallback(root, await detectCapability())` | a positioned element |

What already fits the shared contracts in `src/core/contracts.ts`:

- `CameraRig` implements `CameraController`, and its `state` is a `CameraState`.
- `planeFromDesc()` reads `PlaneDesc` (position, quaternion, half size).
- Ignition needs no new GPU state: scale each plane's `activeCount`. One
  active particle on the first plane is the opening spark.
- Exposure is a multiplier on `RenderSettings.brightness`.
- Hints and the fallback use the monochrome palette. They predate `TOKENS`
  and use their own letter-spacing; they should be moved onto `TOKENS` when
  the UI threads settle the look.

Pointer forces on the GPU (added in the follow-up PR): `Globals` ends with
four `Brush` slots, and the engine adds `brushAccel(p.pos)` to every particle
after the behavior's `update()`, so all behaviors respond without changes. A
brush names its plane by `PlaneDesc.seed`. `brushForce()` in `force-brush.ts`
is the CPU reference for the same curve.

Two things the experience wants that are not contract changes, only requests
to the renderer: a slight brightness lift on `f.hoverPlane` (25% in the demo),
and a brief lift on `f.focusedPlane` scaled by `f.focusGlow`.

## Files

| File | Role |
| --- | --- |
| `index.ts` | `createExperience()`, the per-frame contract, `gainToActiveCount()` |
| `intro.ts` | Opening timeline, ignition order, `IntroDirector` (clock and skip) |
| `camera-rig.ts` | Thin front for the shared camera in `src/ux/camera` (same feel as the app); `planeFromDesc()` |
| `pointer-ray.ts` | Cursor to ray to `(plane, u, v)` |
| `force-brush.ts` | Wake, attract, repel, release burst, GPU packing, reference force |
| `gestures.ts` | Mouse, pen and touch recogniser |
| `hints.ts` | Hint scheduling, DOM line, remembered state |
| `app-hints.ts` | The app's hint schedule: gesture hints plus the HUD die, one at a time |
| `engine-brushes.ts` | Pointer forces for the real engine, fed from any `CameraController` |
| `capability.ts` | WebGPU detection, device tier, plain-language explanations |
| `fallback.ts` | Canvas 2D single-sheet experience |
| `math.ts` | Vectors, matrices, easing |
| `demo/` | Standalone page over a CPU mock world |
| `test/` | 30 unit tests (run command is in the file header) |

## Open questions

These need a person looking at a real screen. None of them block the engine.

1. **Timing.** 18 seconds is long for a web page. The beats were chosen by
   reasoning, not by watching people. If it drags, shorten the bloom first.
2. **Repel on touch.** There is no touch gesture for it yet. Candidates: a
   two-finger hold, or making the release burst the only push. The second is
   simpler and may be enough.
3. **Hold delay.** 170 ms (mouse) and 230 ms (touch) separate "look" from
   "touch". Too short and camera drags turn into wells; too long and the
   wells feel laggy. Needs tuning by hand.
4. **Which sheet the ray picks in the wide shot.** Currently the nearest lit
   sheet under the cursor. With hundreds of mostly empty sheets, picking the
   nearest sheet that actually has particles near the hit may feel better;
   that needs density information from the engine.
5. **Force strength** has only been checked against the mock world's flow
   fields. Real behaviors will need the gain retuned, possibly per behavior.
6. **Sound.** Deliberately absent. A single low tone on ignition could be
   strong, but autoplay rules mean it could only start after the first input.
