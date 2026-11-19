# Strata architecture

Strata is a 3D void filled with flat sheets ("planes"). Each sheet holds
particles that follow their own 2D rule (a "behavior"), simulated on the GPU.
Particles are drawn as one-pixel additive points, so density reads as
brightness, and a rotating camera reveals sheet after sheet.

The shared types live in `src/core/contracts.ts`. Build against those.

## Working in parallel

- Add files, do not edit shared ones. A behavior, a pass or a panel is one new
  file that implements a contract. Behaviors (`src/behaviors/*.behavior.ts`),
  passes (`src/passes/*.pass.ts`, default export `(gpu) => Pass`) and panels
  (`src/ui/*.panel.ts`) are picked up automatically by filename.
- If a contract must change, send that as its own small PR first.
- Visuals: white on black only. Use `TOKENS` for every font, opacity and easing.

## Data model

- `Behavior`: id, ranged param schema (max 8 floats), WGSL `update` snippet.
- `PlaneDesc`: transform, half size, `behaviorId`, seed, particle count, param overrides. Plain JSON.
- `Scene`: planes + camera + render settings + seed. Plain JSON, reproducible.
- `PlaneInstance`: the live GPU side of a plane (particle buffer, uniform, bind groups, `activeCount`).

## GPU layout

Particle: 16 bytes, `pos: vec2f, vel: vec2f`, plane-local, sheet spans [-1, 1]^2.
A plane's particle buffer is both compute storage and a vertex buffer.

Bind group 0, every pipeline:

```wgsl
struct Globals {
  viewProj: mat4x4f,
  time: f32,       // seconds since start
  dt: f32,         // seconds simulated this frame (clamped)
  frame: u32,
  brightness: f32, // light added per particle per pixel
}
@group(0) @binding(0) var<uniform> globals: Globals;
```

Bind group 1, per plane (112 bytes):

```wgsl
struct Plane {
  model: mat4x4f,  // plane-local to world, includes half size as scale
  params: Params,  // 8 x f32, named after the behavior's params
  count: u32,      // active particles this frame
  seed: f32,
  brightness: f32, // per-plane multiplier, PlaneDesc.brightness, default 1
}
@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>; // compute only
```

## Behavior WGSL scope

A behavior defines `fn update(p: Particle, i: u32) -> Particle`. Available:

| name | meaning |
| --- | --- |
| `globals.time`, `globals.dt`, `globals.frame` | clock |
| `plane.params.<name>` | the behavior's params |
| `plane.seed`, `plane.count` | per-plane seed in [0, 1), active count |
| `rand(i, salt) -> f32` | uniform [0, 1), new every frame, vary `salt` for independent draws |
| `noise2(p: vec2f) -> f32` | gradient noise, about [-0.7, 0.7] |
| `outside(pos) -> bool` | off the sheet |
| `wrap(pos) -> vec2f` | wrap around the sheet edges |
| `respawn(i) -> Particle` | fresh particle at a random spot, at rest |

Behaviors update particles in place and cannot read other particles directly.
Interaction between particles or planes goes through fields built in the
`interplane` stage.

## Frame graph

Each frame runs passes grouped by stage, in `PASS_ORDER`:

1. `simulate`: one compute dispatch per plane.
2. `interplane`: coupling between planes, shared fields.
3. `rasterize`: additive points into the HDR target (`rgba16float`).
4. `depth`: depth-aware effects on the HDR target.
5. `tonemap`: HDR target to canvas.
6. `ui`: in-canvas overlays.
7. `capture`: readback and recording.

A `Pass` has a `name`, a `stage`, and `execute(frame)`, which encodes into the
shared command encoder. Passes in the same stage run in registration order.

## Scaling

`ParticleBudget.allocate` picks each plane's `activeCount` every frame from
distance, visibility, screen coverage and fps. Buffers keep full capacity, so
the budget only changes how many particles are stepped and drawn.

## UI

DOM panels implement `UIPanel` and talk to the engine only through
`AppContext`. Keep the default view empty: black void, white particles, a tiny
stats readout.
