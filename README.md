# Strata

A 3D void of flat sheets, each running its own 2D particle behavior on the GPU.
Black background, white particles. Turn the camera and different sheets come
into view, so the world always holds more moving particles than one view shows.

## Run

```sh
npm install
npm run dev      # then open the printed URL in a WebGPU browser (Chrome, Edge, Safari)
npm run build    # typecheck + production build
```

Controls: drag to orbit, wheel to zoom, right-drag or shift-drag to pan,
WASD/QE to fly, Space toggles auto-rotate, `[` `]` halve or double the
particle count, `-` `=` change brightness, Tab shows UI panels (when any exist).

URL options: `?particles=8000000&planes=64&behaviors=flow,galaxy&brightness=0.2&seed=1`

## Architecture

Details and the exact GPU layouts are in [docs/architecture.md](docs/architecture.md).
Shared types are in [src/core/contracts.ts](src/core/contracts.ts).

```
src/
  core/contracts.ts    shared types: Behavior, PlaneDesc, Scene, Pass, ...
  core/frameGraph.ts   runs passes in stage order, owns the HDR target
  core/budget.ts       per-plane particle budget (default: pause planes out of view)
  gpu/context.ts       device, bind group layouts, Globals uniform
  gpu/shaderLib.ts     WGSL prelude that every behavior is compiled with
  sim/simulation.ts    particle buffers + one compute dispatch per plane (simulate pass)
  passes/*.pass.ts     render passes, auto-registered (points, tonemap)
  behaviors/*.behavior.ts   particle rules, auto-registered (flow, galaxy)
  ui/*.panel.ts        DOM panels, auto-registered (none yet)
  world/layout.ts      builds the default scene (sheets scattered in a ball)
  camera.ts, math.ts, overlay.ts, main.ts
```

Each frame: write globals, ask the budget how many particles each plane runs,
then run passes by stage: `simulate`, `interplane`, `rasterize`, `depth`,
`tonemap`, `ui`, `capture`.

Particles are 16 bytes (`pos.xy`, `vel.xy`) in a per-plane buffer that is both
compute storage and a vertex buffer, updated in place. They are drawn as
one-pixel points with additive blending into an `rgba16float` target, then
tonemapped, so density reads as brightness with no sorting and no depth buffer.

## Add a behavior

Create `src/behaviors/<id>.behavior.ts`. That is the only file to touch; it is
registered by filename and the default scene cycles through all behaviors.

```ts
import { defineBehavior } from "./define";

export default defineBehavior({
  id: "drift",
  params: {
    speed: { default: 0.2, min: 0, max: 1 }, // up to 8 params
  },
  wgsl: /* wgsl */ `
fn update(pIn: Particle, i: u32) -> Particle {
  var p = pIn;
  let a = noise2(p.pos * 3.0 + globals.time * 0.1) * 6.283;
  p.vel = vec2f(cos(a), sin(a)) * plane.params.speed;
  p.pos = wrap(p.pos + p.vel * globals.dt);
  return p;
}
`,
});
```

`update` runs once per particle per frame. Positions are plane-local, the sheet
spans [-1, 1] on both axes. In scope: `globals.time`, `globals.dt`,
`globals.frame`, `plane.params.<name>`, `plane.seed`, `plane.count`, and the
helpers `rand(i, salt)`, `noise2(p)`, `outside(pos)`, `wrap(pos)`,
`respawn(i)`. Try it alone with `?behaviors=drift`.

A behavior cannot read other particles. Interaction goes through fields built
by a pass in the `interplane` stage.

## Add a pass or a panel

- Pass: `src/passes/<name>.pass.ts`, default export `(gpu: GpuContext) => Pass`.
  Its `stage` decides when it runs.
- Panel: `src/ui/<id>.panel.ts`, default export a `UIPanel`. Use `TOKENS` for
  all styling.
