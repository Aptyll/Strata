# Behaviors

A behavior is one file that implements the `Behavior` contract in
`src/core/contracts.ts`: an id, up to 8 ranged float params, and a WGSL snippet
defining `fn update(p: Particle, i: u32) -> Particle`. The engine inlines that
snippet into one compute shader per behavior.

`src/behaviors/core/` adds authoring and preset tools on top of that contract.
It is deliberately small. There is no runtime composition engine, and nothing in
it runs per particle: params stay the engine's fixed block of 8 floats, and the
WGSL blocks are plain text joined once when a behavior file loads. A behavior
that uses none of this costs exactly what it would have cost anyway.

## Writing a behavior

One file per behavior, `src/behaviors/<id>.behavior.ts`, default export:

```ts
import { defineBehavior, wgsl, CURL } from "./core";

export default defineBehavior({
  id: "flow-field",
  label: "Flow field",
  description: "Particles drift along an evolving, divergence-free noise flow.",
  tags: ["flow"],
  params: {
    scale: { default: 2.5, min: 0.5, max: 12, scale: "log", label: "Scale" },
    speed: { default: 0.25, min: 0, max: 1, label: "Speed" },
    evolve: { default: 0.1, min: 0, max: 1, label: "Evolution" },
  },
  wgsl: wgsl(CURL, /* wgsl */ `
fn update(p: Particle, i: u32) -> Particle {
  var q = p;
  let drift = vec2f(globals.time * plane.params.evolve, plane.seed * 100.0);
  q.vel = curl2(q.pos * plane.params.scale + drift) * plane.params.speed;
  q.pos = wrap(q.pos + q.vel * globals.dt);
  return q;
}`),
});
```

`defineBehavior` returns a plain `Behavior`. It throws when the file loads if the
behavior breaks the contract: more than 8 params, a param name that is not a valid
WGSL field, a default outside its range, a missing `fn update`, or a
`plane.params.<name>` that was never declared. Those mistakes otherwise show up
as a shader error at runtime.

Gravity, as a second example:

```ts
import { defineBehavior, wgsl, ORBITERS, DAMP, LIMIT_SPEED } from "./core";

export default defineBehavior({
  id: "orbit-gravity",
  label: "Gravity",
  params: {
    bodies: { default: 3, min: 1, max: 8, step: 1, label: "Bodies", randomize: false },
    mass: { default: 0.15, min: 0.01, max: 1, scale: "log", label: "Mass" },
    radius: { default: 0.45, min: 0, max: 0.9, label: "Orbit radius" },
    spin: { default: 0.3, min: -2, max: 2, label: "Orbit speed" },
    soft: { default: 0.08, min: 0.02, max: 0.4, scale: "log", label: "Softening" },
    drag: { default: 0.05, min: 0, max: 2, label: "Drag" },
  },
  wgsl: wgsl(ORBITERS, DAMP, LIMIT_SPEED, /* wgsl */ `
fn update(p: Particle, i: u32) -> Particle {
  var q = p;
  let pr = plane.params;
  q.vel += orbiters(q.pos, pr.bodies, pr.radius, pr.spin, pr.mass, pr.soft) * globals.dt;
  q.vel = limitSpeed(damp(q.vel, pr.drag), 0.0, 4.0);
  q.pos = wrap(q.pos + q.vel * globals.dt);
  return q;
}`),
});
```

`label` and `description` are what people see, so write them for a viewer, not
for the code. The label must be unique: the Esc menu groups a behavior's
sliders under it, and two behaviors with one label show up as one (the
registry warns in the console). The description is one plain sentence saying
what the sheet looks like, in the style of the ones in `src/behaviors`.

## Params

The contract's `ParamSpec` is `default, min, max, step?, label?`. `RichParamSpec`
adds optional fields that only the tools and UI read:

| field | meaning |
| --- | --- |
| `scale: "log"` | slider and randomizer work in log space. Needs `min > 0`. |
| `description` | tooltip text |
| `randomize: false` | keep fixed when randomizing (counts, anything costly) |
| `randomRange: [lo, hi]` | narrower range for the randomizer |

Tools in `core/params.ts`, all pure functions:

| function | use |
| --- | --- |
| `resolveParams(behavior, overrides?)` | all values: defaults, then overrides, clamped |
| `diffParams(behavior, values)` | only non-default values, for `PlaneDesc.params` |
| `packParams(behavior, overrides?, out?)` | the 8-float uniform block, in declaration order |
| `toUnit(spec, value)` / `fromUnit(spec, t)` | value to slider position 0..1 and back |
| `randomizeParams(behavior, { seed, amount, base })` | seeded random preset; `amount < 1` mutates `base` |
| `lerpParams(behavior, a, b, t)` | blend two value sets in slider space |

## Presets

A `BehaviorPreset` is `{ name, behaviorId, params }`, plain JSON. Apply one by
assigning `preset.params` to `PlaneDesc.params` and calling `app.updatePlane`.

- `makePreset`, `randomPreset`, `blendPresets` build them.
- `encodePreset` gives a short readable string such as
  `orbit-gravity?mass=0.5&spin=-1.25#Slow%20orbit`. `decodePreset` reads it back,
  clamps values and drops unknown params, so old strings keep loading.
- Presets of two different behaviors run different shaders, so they cannot be
  blended by value. Cross-fade two planes instead.

## WGSL blocks

`core/wgsl.ts` exports one function per constant. `wgsl(...blocks, body)` joins
them and drops duplicates.

| block | function |
| --- | --- |
| `ROTATE` | `rotate2(v, angle)` |
| `CURL` | `curl2(p)`, divergence-free flow from `noise2` (3 noise calls) |
| `ATTRACT` | `attract(pos, center, mass, soft)` |
| `ORBITERS` | `orbiters(pos, count, radius, speed, mass, soft)`, up to 8 circling masses |
| `VORTEX` | `vortex(pos, strength, tightness)` |
| `DAMP` | `damp(vel, rate)`, frame-rate independent drag |
| `LIMIT_SPEED` | `limitSpeed(vel, lo, hi)` |
| `JITTER` | `jitter2(i, salt)`, random vector in [-1, 1]^2 |
| `BOUNCE` | `bounce(p, restitution)`, reflect off the sheet edges |

To add a block, export another constant holding one WGSL function that uses only
the scope listed in `docs/architecture.md`.

## Not covered yet: particles that see each other

Particle Life, boids and physarum need each particle to read its neighbors or a
shared trail. The engine contract rules that out on purpose (a behavior updates
one particle in place), because neighbor search is the most expensive thing a
particle sim can do and the current goal is particle count.

When that changes, the cheap route is a per-plane density or trail grid built in
the `interplane` stage and sampled from `update`. That gives physarum directly
and flocking-like motion from density gradients, at a fixed cost per particle.
True pairwise rules (Particle Life, classic boids) need a spatial hash and cost
roughly 50 to 200 neighbor reads per particle, so they belong on small planes.
Both would be additions to the contract, sent as their own PR.

## Verification

The tools were checked with assertions outside the repo (the project has no test
runner yet). The two examples above and every WGSL block were compiled and run
for 240 frames on WebGPU in headless Chromium, against a stand-in for the engine
prelude written from `docs/architecture.md`, with no shader errors and no
non-finite values. They have not been run against the real engine prelude.
