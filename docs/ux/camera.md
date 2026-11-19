# Moving through the void: camera design

Status: first version, implemented in `src/ux/camera/`. Not yet wired into the engine and not yet felt on a real device. Every number below is a starting value chosen by reasoning, and should be tuned by hand once particles are on screen.

## What the camera is for

Strata is a black void holding many flat sheets of particles. Each sheet runs its own behavior, and the interesting moments come from how sheets relate in depth: one seen through another, a sheet seen edge-on as a thin line of light, a sheet filling the screen. The camera is the only tool the viewer has, so it carries the whole experience. Three goals follow from that.

1. **The world should feel heavy and calm.** Nothing snaps. Motion starts and stops with easing, a flick carries on and settles. The sim is the show, the camera should never draw attention to itself.
2. **Getting to a sheet should take one action.** Double click it, or press a key. Free navigation is for exploring, focus is for looking.
3. **It should be worth watching with hands off.** After a few seconds idle, the camera starts to drift on its own so the void is never a still image.

## The rig

One model covers every way of moving: a **pivot** point, an **orientation**, and a **distance**. The eye sits `distance` behind the pivot along the view direction.

- Orbit rotates the orientation, the eye swings around the pivot.
- Pan slides the pivot in the view plane.
- Zoom changes the distance.
- Fly pushes the pivot along the camera axes, and looking around keeps the eye fixed and swings the pivot instead.
- Focus is a flight to a computed pivot, orientation and distance.

Because all modes share one state, there is never a conversion step or a visible hitch when the viewer switches between them.

The pivot is also the ruler: pan, zoom and orbit are all measured against the distance to it. So the pivot has to sit on what the viewer is dealing with, or the controls feel wrong, a hundred times too fast or too slow. See "Scaled to the sheets" below.

Every input writes to a **goal pose**. The pose on screen chases the goal with an exponential ease (time constant 70 ms), computed from the frame time so it feels the same at 30, 60 and 144 Hz. 70 ms is short enough that dragging still feels attached to the hand, and long enough to hide the steps of a mouse wheel and the jitter of touch input.

## Controls

| Action | Mouse | Trackpad | Touch | Keyboard |
| --- | --- | --- | --- | --- |
| Orbit | Left drag | Two-finger scroll | One-finger drag | |
| Pan | Right drag, middle drag, or Shift + left drag | Shift + two-finger scroll | Two-finger drag | |
| Zoom | Wheel, toward what is under the cursor | Pinch | Pinch | |
| Fly | | | | W A S D or arrows, Q down, E up, Shift to go faster |
| Look around in place | Alt + left drag (or any drag while flying) | | | |
| Focus a sheet | Double click it | Double click it | Double tap it | F for the one nearest the center of view |
| Next / previous sheet | | | | `.` and `,` |
| Home view | Double click open space | Double click open space | Double tap open space | Home (and H outside the app, where H is the stats key) |
| Toggle idle drift | | | | Space |

Decisions behind the table:

- **Grab the world, in every mode.** Dragging always moves the scene with the hand. When orbiting, a drag of one viewport height is half a turn. When looking around in place, a drag of one viewport height sweeps exactly one field of view, so the point under the pointer stays under it.
- **Zoom is multiplicative and aims at what is under the cursor.** Each wheel notch covers about 14 percent of the way to the sheet under the cursor (and backs away by 16 percent), so zoom feels the same next to a sheet as it does far out in the void. The point under the cursor stays put, which lets the viewer steer with the wheel alone.
- **Fly speed scales with the room around the camera.** Far out you cover ground, among the sheets you slow down. One speed setting works across the whole world, which matters because the world is much larger than the view. Fly mode starts when a move key is pressed and ends on zoom, focus or home.
- **Open space sends you home.** A double click on a sheet frames it; a double click on nothing flies back to the view the scene opened on. That is the way out of any spot where nothing is in sight, and it needs no key.
- **Level horizon by default.** The default "turntable" mode yaws around world up and limits pitch to 85 degrees, so the viewer cannot get lost upside down. A focus flight is allowed to break this (looking straight down at a floor sheet, or matching a sheet that is rolled). When the viewer takes over again, leftover roll eases back to level over about a third of a second. A free trackball mode exists as an option.
- **A focused control keeps its keys.** In the app, keys reach the camera through the router in `src/app/keys.ts`. Arrows and Home or End on a focused slider move the slider, and Space or Enter on a focused button or switch presses it; the camera does not also act on them. Key releases always reach the camera, so a key is never left held. A mouse or touch press does not focus the die or the menu dot, so Space after clicking them still toggles the idle drift.
- **Two-finger scroll orbits.** On a trackpad this matches Blender and Sketchfab and keeps pinch for zoom. Browsers do not say whether a wheel event came from a mouse or a trackpad, so this is a guess based on the size and shape of the deltas. See open questions.

## Scaled to the sheets

The first version measured everything against the pivot and left the pivot wherever the last gesture had put it. Scrolling in closed on an invisible point in space, and once the eye was 0.05 from it every control was scaled to 0.05: the wheel did nothing, W crept at 0.05 units a second, a 300 pixel pan moved 0.03 units, and it took 40 notches to back out. Measured in the app, this was the main way to get stuck.

The rig now knows the sheets (`setPlanes`) and keeps the ruler on them:

- **Zoom, pan and pinch grab what the pointer is on.** When one of them starts, the pivot is moved along the view axis to the depth of the sheet under the pointer (`rig.grab`, which zoom calls itself). The eye and the orientation stay where they are, so nothing moves on screen; only the ruler changes. A panned sheet then stays under the pointer exactly, and a zoom closes in on that sheet.
- **Orbit does not grab.** A drag turns around the pivot where the last zoom, pan or focus left it. From the opening view that is the middle of the world, which is what makes the world turn like an object in the hand.
- **Zoom stops for a closest look, then goes through.** Zooming in on a sheet stops `minDistance` (0.05) in front of it; one huge step cannot overshoot that. A sheet within 10 percent of that depth counts as reached, and the next step in measures against whatever lies behind it, so the eye goes through. Sheets are see-through clouds of dots, so the sheet under the cursor is not always the one the viewer is looking at; going through is how a dive carries on to the one behind. Backing out from the closest look is as fine as getting in.
- **Open space has a floor.** With no sheet under the pointer the pivot is kept at least as far out as the nearest sheet ahead, and never closer than a quarter of a typical sheet's shorter side (`openFloor`). So a notch over open space always covers ground, and a pivot left right in front of the eye cannot make pan and zoom crawl.
- **Fly along the view axis** goes one clearance per second, where the clearance is the distance to the nearest sheet in any direction, never less than 15 percent of a typical sheet's shorter side (`flyFloor`). That floor is what carries the camera through a sheet instead of toward it forever.
- **Fly across the view axis** (sideways, up, down) goes at the same speed, except when the camera is looking at a sheet from closer than the floor: then it goes at that sheet's depth, so its particles slide past at about one screen height per second however close the camera is. A sheet that is edge-on or behind the near plane is not being looked at, so the camera is never stuck in the plane of a sheet.
- **The world has limits.** `rig.limitTo(planes)` keeps the pivot within 4 radii of the ball around the sheets and the eye within 8 radii of the pivot. Zooming all the way out leaves the world a small cluster on screen instead of nothing. The app sets this for a generated scene; the streamed world (`?world`) has no fixed middle and keeps the rig's own limits.

With no sheets registered (the Challenge page, the demo before its sheets exist) everything is measured against the pivot as before.

The near plane is 0.02, well inside the closest look, because a tilted sheet reaches closer to the eye than its middle does at the edges of the view.

## Momentum

Releasing a drag while moving keeps the motion going, and it decays with a time constant of 0.35 s for rotation and 0.25 s for pan. The release speed is estimated from the last ~40 ms of input, so holding still for a moment before letting go leaves the camera exactly where it is. That one detail is what separates "weighty" from "slippery": the viewer can always choose a precise stop.

Fly movement accelerates and brakes with a 0.15 s time constant, so keys feel like thrust instead of a switch.

There is deliberately no momentum on zoom. The smoothing already eases each step, and trackpads add their own scroll inertia.

## Focusing a sheet

Focus frames a sheet head-on with a 12 percent margin, fitting whichever of width or height is the tighter constraint for the current aspect ratio.

- **Stay on your side.** The camera lands on whichever face of the sheet it is already looking at, so a focus never flies through the paper. Sheets are meant to be readable from both sides.
- **The flight is one eased motion.** Pivot, orientation and distance are interpolated together with an ease-in-out curve. Distance is interpolated on a log scale so zooming in over a large range feels even.
- **Long trips pull back first.** The distance gets a hump in the middle, 30 percent of the travel, so on a long trip the viewer briefly sees where they are going in context. Short hops between neighbors barely show it.
- **Duration follows the trip.** Between 0.6 and 2.4 seconds, growing with the log of the travel distance, the turn angle and the zoom change. Short moves are quick, long ones are not rushed.
- **Any input interrupts.** Touching anything during a flight cancels it on the spot and hands over control with no jump. The viewer is never locked out.
- **Focus is a state.** While a sheet is focused the rig reports it (`rig.focused`, `onFocusChange`), so the UI can label it or the engine can give that sheet more of the budget. Any manual movement clears it.

## Idle drift

After 6 seconds without input, the drift fades in over 4 seconds:

- With nothing focused, a slow orbit around world up at 0.035 rad/s (one turn in about three minutes). This is the motion that best shows the idea of the piece, since sheets pass through edge-on and open up again.
- With a sheet focused, a sway of about 6 degrees side to side instead, so the sheet stays framed but still reads as an object in space.
- In both cases a slow nod and a 4 percent breathing dolly, on periods that do not line up, so it never visibly loops.

The drift is a separate layer on top of the pose. The moment the viewer touches anything, the layer is folded into the pose, so taking over never causes a jump.

**Tour mode** (off by default, `idle.tour`) flies to the next registered sheet every 14 seconds while idle. Tour flights run 1.8 times slower than requested ones. This is the screensaver and demo-reel mode.

## Accessibility and comfort

- `prefers-reduced-motion` turns off the idle drift and momentum and turns flights into cuts.
- Every pointer action has a keyboard path to the same places: fly keys, focus, next and previous, home.
- Pitch limit and auto-leveling keep the horizon stable, which is the main trigger for discomfort in free 3D navigation.
- A soft world boundary (a sphere, set from the sheets by `limitTo`) pulls the pivot back with a rubber-band feel instead of a hard wall.

## What the engine gets

```ts
import { attachCameraInput, createCamera, planeTargetFromDesc } from "./ux/camera";

// `camera` satisfies the CameraController contract in src/core/contracts.ts.
const camera = createCamera(scene.camera);
const detach = attachCameraInput(canvas, camera.rig);
camera.rig.setPlanes(scene.planes.map(planeTargetFromDesc));

function frame(dtSeconds: number) {
  camera.update(dtSeconds);
  const viewProj = camera.viewProjection(width / height);
}
```

`createCamera` returns an `EngineCamera`: the contract's `state`, `update`, `eye()` and `viewProjection(aspect)`, plus `rig` for everything richer (flights, focus, idle drift, picking). `state` is live. Reading it gives the pose on screen, and assigning it or one of its fields moves the camera at once. `snapshot()` gives a plain copy for saving a scene. `CameraState` has no roll, so a rolled focus view saves as its level equivalent.

For scripted moments such as the intro, `rig.steer(pose, weight)` pulls the camera toward a pose each frame, and lets go cleanly when the calls stop. The first-run experience (`src/ux/experience/camera-rig.ts`) is a thin front for this same rig, so there is one camera feel everywhere.

On `camera.rig`:

- `view`, `projection`, `viewProjection`: column-major `Float32Array(16)`, WebGPU clip space with depth 0 to 1. Right-handed, +Y up, camera looks down -Z.
- `eye`, `forward`, `right`, `up`, `distance`: for billboarding, sorting and level of detail.
- `speed`: eye speed in world units per second. Suggested use: thin out or dim particles while the camera moves fast, restore full density at rest.
- `idleAmount` (0 to 1) and `focused`: for UI that fades out when idle, or labels a focused sheet.
- `reverseZ` with `far: Infinity` is available as an option if a depth pass needs precision across a world this large (clear depth to 0, compare with `greater`). The default is standard depth, near 0.02 and far 10000.

The rig has no dependencies and never touches the DOM. `input.ts` is the only file that does, and it can be replaced.

Files: `math.ts` (vectors, quaternions, matrices), `rig.ts` (the camera rig), `input.ts` (DOM bindings), `engine.ts` (adapter to the shared contracts), `selftest.ts` (89 checks) and `camera.test.ts` (runs them under `npm test`), `demo/` (standalone page).

The checks run with `npm test` (through `camera.test.ts`), or on their own with `npx esbuild src/ux/camera/selftest.ts --bundle --format=esm | node --input-type=module`.

## What is verified and what is not

Verified by the self-test: matrices agree with the screen rays, orbit keeps distance and a level horizon, smoothing is frame-rate independent, flicks coast and settle, a held stop leaves no drift, pan and zoom keep the grabbed point under the pointer, grabbing a sheet moves nothing on screen and keeps that sheet under the pointer, a long scroll in reaches the closest look at a sheet, goes through it, does the same at the sheet behind and carries on over open space with every notch making progress, flying goes through a sheet and is never stuck in the plane of one, zooming out stops with the sheets still in sight, look-around does not move the eye, focus frames a sheet inside the viewport with no jumps along the way, interruption and drift takeover do not jump, tour visits every sheet, reduced motion removes animation, bad frame times do not produce NaN.

The engine in `src/main.ts` uses this camera. `[`, `]` and Esc are left alone because the engine and the HUD use them. In `CameraState`, pitch is the pitch of the view direction: negative looks down.

A standalone demo runs without the engine or WebGPU: `npm run dev`, then open `/src/ux/camera/demo/`. It draws stand-in sheets of dots on the CPU. Add `?tour=1` for the idle tour or `?free=1` for the trackball.

Not verified: anything about feel. The numbers in "Scaled to the sheets" (the closest look, the two floors, one clearance per second, the world limits) are reasoned and were driven in headless Chromium, where a 150 notch scroll that used to go dead after 38 notches now moves on every notch; nobody has held them on a real GPU yet. The demo was driven once in headless Chromium (drag, flick, wheel, right-drag pan, keys, double click, idle drift) and behaved as designed with no console errors. Touch and trackpad input are untested. The engine swap is type checked only and has not been run on a GPU.

## Open questions

1. **Trackpad detection.** Telling a two-finger scroll from a mouse wheel is a heuristic and will sometimes be wrong, most likely on high-resolution mice, which may orbit when the viewer expects zoom. If that proves annoying, the fallback is to make all scrolling zoom and leave orbit to click-drag.
2. **Scroll direction on trackpads.** The orbit direction for two-finger scroll assumes natural scrolling. It needs a check on real hardware.
3. **How the sheets are laid out.** Orbit around world up assumes the layout reads well from the side. If sheets end up stacked along the vertical axis, the idle orbit should circle a different axis.
4. **Sound and haptics on landing.** A focus flight ends silently. A faint cue might help, and is out of scope here.
5. **Depth of field or fog by distance to the pivot.** The rig exposes what is needed. Whether it suits the minimalist look is a visual decision.
