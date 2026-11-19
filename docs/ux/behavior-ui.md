# Behavior UI: the dice roll

Scope was cut to keep the particle-count challenge first. This covers only what
a press of the dice produces and how the world gets there. Code:
`src/ux/behavior-ui/roll.ts`. The dice button itself belongs to the HUD.

## What a roll is

`rollScene(scene, behaviors, seed, opts)` returns a new `Scene`. It changes each
plane's `behaviorId`, `params` and `seed`, and nothing else: transforms, particle
counts, camera and render settings pass through. It is pure and deterministic,
so a roll is fully described by its seed.

Two rules keep rolls worth looking at:

1. **Stay near what the author tuned.** A behavior's `ParamSpec.default` is the
   one value known to look right. Each param is sampled from a window around its
   default (`spread`, 30% of the full range each side, clipped to min/max, snapped
   to `step`). A behavior author can narrow a param with `randomRange` or pin it
   with `randomize: false` (the `RichParamSpec` hints from `src/behaviors/core`),
   and a caller can override both with `opts.ranges`.
2. **Compose, do not scatter.** A world is 1 to 3 "voices" (a behavior plus
   rolled params). Each plane is a slight variation of a voice, and voices are
   laid out in runs, so neighbouring sheets relate and the stack reads as one
   system. The first voice always differs from what plane 0 showed before, so a
   press never looks like nothing happened.

`opts.exclude` keeps named behaviors out of the dice.

## Getting there smoothly

`startRoll(app, target, opts)` returns a transition; call `update(dt)` once per
frame until it returns true.

- A plane that keeps its behavior **glides**: params are eased from their
  current values to the target and pushed with `app.updatePlane`. It keeps its
  seed so nothing jumps. Planes start one after another (`stagger`), so the
  change sweeps through the stack.
- A plane that changes behavior is **swapped in place** through
  `AppContext.setPlaneBehavior`: its particles stay where they are and start
  obeying the new rule, so the old pattern flows into the new one. Each plane
  swaps at its turn in the sweep. Nothing extra runs per frame.
- If an engine does not provide `setPlaneBehavior` (it is optional in the
  contracts), or `opts.swapBehavior` is `false`, changed planes go through a
  single `app.loadScene` at the start, which is a hard cut.

## Wiring the dice

```ts
import { rollScene, startRoll } from "../ux/behavior-ui/roll";

let roll: ReturnType<typeof startRoll> | null = null;
dice.onclick = () => {
  const target = rollScene(app.getScene(), app.behaviors, (Math.random() * 2 ** 31) | 0);
  roll = startRoll(app, target);
};
// in the frame loop
if (roll && roll.update(dt)) roll = null;
```

This is what `src/ux/hud/wire.ts` does, and `src/main.ts` mounts it, so the die
in the running app is the demo. Pressing again mid-flight is safe: start a new
roll and drop the old one.

## Cost

Nothing on the GPU. A press allocates one scene. During a transition each
gliding plane gets one `updatePlane` per frame for about 2.4 seconds.

## Assumptions and limits

- "Interesting" is by construction (near defaults, composed), not measured.
  If behaviors ship with defaults that are not their best look, rolls inherit
  that. Tighten with `opts.ranges`.
- Windows are linear around the default, also for params marked `scale: "log"`.
- The first time a behavior is used its compute pipeline is compiled, which can
  cost a frame during a roll.
- Checked by type check, build and unit tests against a fake `AppContext`
  (`node --test src/ux/behavior-ui/roll.test.mjs`). Not yet watched on a GPU.

## Parked

Dropped from this pass, in rough order of value if picked up later: a measured
quality filter (run a candidate briefly and reject dead, frantic or collapsed
results), an evolve grid (pick the mutant you like, repeat), a gallery of live
thumbnails, per-plane editing with sliders built from `ParamSpec`, morphing
between two behaviors, and sharing a world as a URL (a roll is already just a
seed, so this is cheap).
