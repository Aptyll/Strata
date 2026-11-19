# Auto camera tour

`src/ux/autocam/`. The camera flies itself through the world: it picks sheets
and clusters worth seeing and moves between them with slow, eased shots.

**Use it:** press **C**, flip "auto camera tour" in the Esc menu, or open the
app with `?autocam=1`. Any camera input (click or drag on the canvas, the
wheel, a camera key such as WASD, arrows, `,` `.`, Home, Space, G) hands the
camera straight back, left exactly where the tour had it. Keys that do not
move the view (Esc, H, F, ?, P, V, T, R, M, `[` `]` `-` `=`) leave the tour
running, so you can record it (V) or change the look while it plays. In the
app the camera keys are the ones the key router (`src/app/keys.ts`) forwards
to the camera, plus rows marked `camera` in its `KEYS` table (G), so a new
app key leaves the tour running without an edit here.

Standalone demo with no WebGPU: `/src/ux/autocam/demo/` under `npm run dev`
(`?planes=64&seed=3`).

## How it works

- **Director** (`director.ts`): a sequence of shots. Each new shot blends in
  over 3.5 to 8 seconds while the outgoing one keeps moving (it eases to a
  stop past its end), so motion never stops dead and never cuts. Pivot and
  rotation ease in and out, distance eases in log space, and a pull-back arc
  lifts the camera out mid-move. Rotation is blended with a slerp whose
  quaternion signs are tracked frame to frame, so the blend cannot flip when
  the two ends pass 180 degrees apart.
- **Shots** (`shots.ts`), all steady-paced orbits on a sphere around a pivot:
  - `wide`: the whole world small in frame, turning slowly (the "open wide"
    opening; the tour starts here and comes back every 6 shots).
  - `pullback`: close on one sheet's face, slowly pulling back until its
    neighbours come into frame.
  - `orbit`: a three-quarter view circling a sheet.
  - `edge`: a slanted view swinging to nearly edge-on, so the sheet folds
    into a line of light.
  - `inside`: the pivot in a dense cluster, turning among the sheets (the
    "key1" framing).
- **Interest**: half how densely lit a sheet is (particles x brightness over
  area; capacity, not the budget's active count, since off-screen sheets get
  zero), half how much light surrounds it (a Gaussian neighbourhood). Sheets
  seen in the last 6 shots and behaviors seen in the last 2 are pushed down;
  nearby targets are mildly preferred so moves stay short. Weighted random,
  seeded, so the same world and seed give the same tour.
- **No clipping through sheets**: before a shot is accepted, its whole eye path
  and the blend into it are sampled and tested against every sheet rectangle
  (8 percent margin). A crossing blend gets a bigger pull-back arc; a crossing
  shot is dropped for another candidate; wide shots are the fallback. When the
  camera is boxed in, the current shot drifts on and the director looks again,
  and as a last resort backs out the way the shot came in (a path already
  checked).
- **Applying it**: a `beforeCamera` frame hook calls `mountAutoCam().step(dt)`, which calls
  `rig.steer(pose, 1)` before the rig updates, so the rig's own smoothing
  still rounds off the motion and taking over is seamless.

## Checks

`npm test -- autocam` plays 10-minute tours over five seeded
worlds (12 to 128 sheets) through the real `CameraRig` and asserts the eye
never crosses a sheet, never jumps more than 10 percent of its distance in a
frame, and uses at least three kinds of shot. About a second. `SEEDS=1,2,3`
tries other 32-sheet worlds.

## Not done / open

- Never seen on a real GPU. Speeds, shot lengths and framing are first guesses.
- Streaming worlds (`?world=`) are handled (sheets are re-read at every shot),
  but a sheet streamed in mid-shot is not avoided until the next shot.
- `prefers-reduced-motion` is not special-cased; the tour only runs when asked.
