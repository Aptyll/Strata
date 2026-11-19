# Interplane: particles crossing between planes

Particles that reach the edge of one plane leave it, fly through 3D space as a
stream, and arrive on the neighbouring plane heading inward. That is the whole
feature. It lives in `src/interplane/` and plugs into the frame graph as two
passes built against `src/core/contracts.ts`.

## Why it is cheap

The goal of Strata is particle count, so this effect is designed to cost
nothing for particles that stay on their plane:

- Plane particles keep the engine's 16 byte layout. No extra field, no flag.
- No pass ever iterates plane particles. Work is done by a small separate pool
  of **couriers** (particles in transit), 24 bytes each.
- Cost per frame is `links x couriersPerLink` trivial shader invocations plus
  one small dispatch and one draw per link. With the default 16,384 couriers
  per link and 20 links that is about 330k couriers, independent of whether
  the world holds one million particles or a hundred million.
- Couriers are drawn as the same one-pixel additive points, so they add to the
  visible particle count.

## How it works

1. **Links** (`links.ts`, CPU, once per scene). For each of a plane's four
   edges, find the nearest edge of another plane roughly in front of it. Edges
   with nothing in front get no link and are left alone.
2. **Pick up** (`simShader`). Each idle courier reads a few random particles
   from its link's source plane. If one sits in the thin band along the exit
   edge, the courier takes its position and velocity, and that slot on the
   plane is refilled at a random spot (the same thing a behavior's `respawn`
   does). Busier edges therefore feed thicker streams.
3. **Flight**. A courier stores only the frozen exit state and a progress
   value `t`. Its 3D position is a pure function of those: a curve that leaves
   square to the source edge and arrives square to the destination edge.
   `pinch` ropes the stream together mid flight and `twist` winds it.
4. **Landing**. At `t = 1` the courier writes a particle into a random slot of
   the destination plane, at the matching spot on the entry edge, with its
   speed preserved and pointing inward. The plane's behavior takes over from
   there.

Plane populations stay constant (each buffer has a fixed capacity), so a
crossing is a pick-up on one side and an overwrite of a random particle on the
other. At these densities that swap is not visible.

## Using it

```ts
import { createInterplane } from "./interplane/interplane.pass";

const interplane = createInterplane({ couriersPerLink: 16384 });
// interplane.passes[0]: stage "interplane" (compute)
// interplane.passes[1]: stage "rasterize" (adds onto the HDR target, register after the main rasterize pass)
```

It reads only `frame.planes[i].desc`, `.particles` and `.activeCount`, plus
`gpu.layouts.globals`, `gpu.globalsBindGroup`, `gpu.hdrFormat` and
`frame.hdrView`. Links are rebuilt automatically when the set of planes
changes; call `interplane.invalidate()` after moving planes.

| param | default | meaning |
| --- | --- | --- |
| `leak` | 0.5 | chance that a particle found at a linked edge crosses; 0 turns the effect off |
| `margin` | 0.04 | width of the edge band, plane-local (the sheet is 2 wide) |
| `speed` | 1.2 | flight speed, world units per second |
| `pinch` | 0.85 | 0..1, how tightly a stream ropes together mid flight |
| `twist` | 1 | whole turns a stream winds around its spine |
| `boost` | 1 | brightness of a particle in flight relative to one at rest |
| `couriersPerLink` | 16384 | most particles one link can have in flight (fixed at creation) |
| `link.maxDistance` | Infinity | ignore neighbours further away than this |

`interplane.params` is live; change values at any time.

## Demo

`npm run dev`, then open `/src/interplane/demo/`. It fakes the minimum of the
engine (globals, per-plane buffers, three simple flows) and drives the real
passes. Keys 1 to 3 switch layout (ring, stairs, tiles). URL parameters are
listed at the top of `demo/demo.ts`, for example
`?layout=tiles&n=1000000&couriers=32768`.

Link tests: `node --test src/interplane/links.test.mjs`.

## Assumptions about the engine

- Bind group 0 is the `Globals` uniform exactly as in `docs/architecture.md`,
  visible to compute and vertex stages.
- The HDR target is additive and has no required depth attachment.
- `activeCount` particles at the front of each plane buffer are the live ones.
- Behaviors tolerate a particle being rewritten between frames (they already
  must, since `respawn` exists).

## Not included

An earlier draft also had planes pushing on each other through density fields
and dense spots erupting through a plane's face. Both need a pass over every
particle each frame, so they were cut to protect the particle count.
