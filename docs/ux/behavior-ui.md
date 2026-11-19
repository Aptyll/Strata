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
   to `step`). A behavior that needs tighter or off-centre limits gets an entry in
   `opts.ranges`, which lives outside the shared files.
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
- A plane that changes behavior needs the engine to swap the rule under live
  particles. The shared contracts cannot do that yet, so by default those planes
  go through a single `app.loadScene` at the start, which is a hard cut.

### The one open ask

For a smooth change of behavior, the engine needs a way to replace a live
plane's behavior while keeping its particle buffer. Particles then start
obeying the new rule from wherever they are, which looks like the old pattern
flowing into the new one and costs nothing extra per frame. `startRoll` already
takes this as `opts.swapBehavior(plane, targetDesc)` and, when given, never
calls `loadScene`. Suggested contract addition, as its own small PR:

```ts
// AppContext
/** Replace a live plane's behavior, params and seed, keeping its particles. */
setPlaneBehavior(plane: PlaneInstance, desc: Pick<PlaneDesc, "behaviorId" | "params" | "seed">): void;
```

## Wiring the dice

```ts
import { rollScene, startRoll } from "../ux/behavior-ui/roll";

let roll: ReturnType<typeof startRoll> | null = null;
dice.onclick = () => {
  const target = rollScene(app.getScene(), app.behaviors, (Math.random() * 2 ** 31) | 0);
  roll = startRoll(app, target /*, { swapBehavior } once the engine has it */);
};
// in the frame loop
if (roll && roll.update(dt)) roll = null;
```

Pressing again mid-flight is safe: start a new roll and drop the old one.

## Cost

Nothing on the GPU. A press allocates one scene. During a transition each
gliding plane gets one `updatePlane` per frame for about 2.4 seconds.

## Assumptions and limits

- "Interesting" is by construction (near defaults, composed), not measured.
  If behaviors ship with defaults that are not their best look, rolls inherit
  that. Tighten with `opts.ranges`.
- Not yet run against the real engine, which does not exist on main at the
  time of writing. Covered by unit tests against a fake `AppContext`:
  `node --test src/ux/behavior-ui/roll.test.mjs`.

## Parked

Dropped from this pass, in rough order of value if picked up later: a measured
quality filter (run a candidate briefly and reject dead, frantic or collapsed
results), an evolve grid (pick the mutant you like, repeat), a gallery of live
thumbnails, per-plane editing with sliders built from `ParamSpec`, morphing
between two behaviors, and sharing a world as a URL (a roll is already just a
seed, so this is cheap).
