# World: layouts and streaming

`src/world/` decides which sheets exist and where. It is pure data and math: no
GPU, no DOM, no dependencies beyond the shared types in `src/core/contracts.ts`.
Import everything from `src/world/index.ts`.

Three pieces:

1. **Arrangements** lay out a group of planes (a stack, a spiral, a cathedral).
2. **The world** scatters arrangements through an endless, seeded space.
3. **The streamer** keeps a fixed number of plane slots filled with whatever
   matters most to the camera, so the endless world fits a fixed GPU budget.

## Quick start

```ts
import { createWorld, createStreamer, createWorldScene } from '../world';

const world = createWorld({ seed: 'strata' });

// Today: a fixed Scene cut from the world, for AppContext.loadScene.
const scene = createWorldScene(world, {
  behaviorIds: behaviors.map((b) => b.id),
  maxPlanes: 256,
  maxParticlesPerPlane: 1_000_000,
});

// Streaming into the running app: once at start, then once per frame.
const streaming = startStreamingWorld(app, { seed: 'strata' });
streaming.tick(dt);
```

## Plane data

Every plane is a plain object (`Plane` in `world.ts`):

| field | meaning |
| --- | --- |
| `key` | Stable unique string, e.g. `"3,-1,0:17"` (sector, then index). |
| `id` | uint32 hash of the key. |
| `position` | World-space centre, `[x, y, z]`. |
| `rotation` | Unit quaternion `[x, y, z, w]`. The sheet lies in its local XY plane, local +Z is its normal, local +Y is its "height". |
| `size` | Full extents `[width, height]` in world units. |
| `behavior` | Integer in `[0, behaviorCount)`. The world never names behaviors. |
| `seed` | uint32 seed for the plane's particles. |
| `particles` | Suggested particle capacity: area times `particleDensity`, clamped. A hint. |
| `radius` | Bounding-sphere radius. |
| `group`, `kind` | Family inside its structure, and the arrangement that made it. |

`toPlaneDesc(plane, behaviorIds)` converts to the engine's `PlaneDesc`: full
size becomes `halfSize`, the behavior index picks from `behaviorIds` (wrapping),
the uint32 seed becomes a float in `[0, 1)`, and `key` becomes `id`.

Behavior indices are assigned per *group*. In a `crossed` structure each axis
family gets its own behavior, so turning the camera 90 degrees swaps which
behavior faces you while the other two go edge-on and vanish.

## Arrangements

Recipes in `arrangements.ts` are pure functions `(rng, params) => LocalPlane[]`
working in a unit-sized local space with +Y up.

| name | shape | best seen |
| --- | --- | --- |
| `stack` | Parallel sheets like book pages, optionally tapering. | Along the stack. |
| `lattice` | 3D grid of small parallel sheets, optional jitter. | Head on, or raking. |
| `crossed` | Three interpenetrating stacks, one per axis. | Each axis shows a different family. |
| `spiral` | One to three helical arms of growing sheets. | Down the axis or from the side. |
| `cloud` | Loose swarm at random angles and sizes. | Anywhere. |
| `shell` | Sheets tiling a sphere, facing the centre. | From inside. |
| `fan` | Sheets hinged on one vertical edge. | Orbiting the hinge. |
| `cathedral` | Floor, arcade walls, transverse ribs, vault tiers, rose window, spire. Kept upright. | Down the nave, then from the side. |
| `monolith` | One enormous sheet. Rare. | For scale. |

Add a recipe by adding an entry to a registry object and passing it as
`createWorld({ arrangements })`; `localPlane(position, normal, size, group)`
builds one sheet. `buildStructure(kind, { seed, position, radius, rotation, behaviors, params })`
places a single structure for hand-made scenes, and `createStaticWorld(planes)`
makes any list of planes streamable.

## The world

Space is cut into cubic sectors (`sectorSize`, default 100 units). A sector's
contents depend only on the world seed and the sector's integer coordinates,
so nothing is stored and any sector can be rebuilt identically at any time.

Per sector:

- With probability `density` it holds one structure, sized 25% to 48% of the
  sector and placed so it stays inside.
- Sectors are grouped into regions of `regionSize`^3. Each region has a
  favourite arrangement, followed with probability `regionBias`, so the world
  has neighbourhoods (a district of cathedrals, a field of spirals).
- A few loose "stray" sheets drift between structures (`strays`).

`createWorld` options: `seed`, `sectorSize`, `density`, `behaviorCount`,
`regionSize`, `regionBias`, `strays`, `weights` (per-arrangement frequency,
`{ cathedral: 5, cloud: 0 }`), `particleDensity`, `minParticles`,
`maxParticles`, `cacheSectors`, `arrangements`.

`world.sector(cx, cy, cz)` returns one sector's planes. `world.query(center, radius)`
returns the planes of every sector touching that sphere.

## Streaming

`createStreamer(source, options)` owns `maxPlanes` slots. Each slot is:

| state | value | meaning |
| --- | --- | --- |
| `SLOT_FREE` | 0 | Empty. |
| `SLOT_AWAKE` | 1 | Draw and simulate. |
| `SLOT_ASLEEP` | 2 | Draw, do not simulate. Particle state is kept. |
| `SLOT_LEAVING` | 3 | Fading out. Freed when its fade reaches zero. |

`update(camera, dt)`:

1. Gathers planes within `loadRadius` (default 2.5 sectors).
2. Scores each by apparent size (extent over distance), doubled (`viewBias`)
   when in front of the camera if `camera.forward` is given.
3. Keeps the best `maxPlanes` that also fit `maxParticles`. Planes already
   resident get a 1.3x bonus (`hysteresis`) so nothing flickers at the margin.
4. Wakes the best `maxAwake` of those, with the same stickiness.
5. Fades planes in over `fadeTime` seconds, and also fades by distance across
   the outer `fadeBand` of `loadRadius`, so planes reach zero brightness before
   they are dropped. No popping.

Selection (steps 1 to 4) runs every `selectInterval` seconds (default 0.1);
fades run on every call. Measured in Node on the cloud container: about 0.6 ms
per call with 96 slots and 3 ms on a selection frame with 1024 slots.

Guarantees, all covered by tests:

- A plane keeps its slot index for as long as it is resident, so per-plane GPU
  buffers can be keyed by slot and never move.
- Resident planes never exceed `maxPlanes`, awake planes never exceed
  `maxAwake`, and the summed `particles` never exceeds `maxParticles`, fading
  planes included. When a new plane needs room, the faintest fading plane is
  cut short.
- Every `spawned` slot was free, every `despawned` matches an earlier spawn.
- A still camera settles and produces empty diffs.

The return value lists `spawned`, `despawned`, `woke` and `slept` as
`{ slot, plane }`. A plane that despawns and later respawns starts over from
its seed: its layout is permanent, its evolved particle state is not.

### Instance buffer

`streamer.instanceBuffer` holds 64 bytes per slot (`INSTANCE_STRIDE`), kept up
to date by `update`, for anything that wants all slots in one GPU buffer:

```wgsl
struct PlaneSlot {
  position: vec3f,  //  0
  width: f32,       // 12
  rotation: vec4f,  // 16  quaternion xyzw
  height: f32,      // 32
  behavior: u32,    // 36
  seed: u32,        // 40
  state: u32,       // 44  0 free, 1 awake, 2 asleep, 3 leaving
  fade: f32,        // 48  0..1, multiply brightness by this
  particles: u32,   // 52
  id: u32,          // 56
  _pad: u32,        // 60
}
```

## Hooking into the engine

Open the app with `?world=strata` (any seed) and it streams the endless world
instead of the fixed layout. `&particles=` sets the total particle budget
(default 8 million in this mode).

That is one call in `main.ts`, `startStreamingWorld(app, options)`, plus
`streaming.tick(dt)` each frame. Underneath, `createWorldDriver(host, source, options)`
in `driver.ts` maps the streamer onto the `PlaneHost` contract:

| streamer | engine |
| --- | --- |
| `spawned` | `host.addPlane(toPlaneDesc(plane))`, at most `maxSpawnsPerFrame` (default 2) per frame, most important first, because creating a plane allocates and fills its particle buffer. |
| `despawned` | `host.removePlane(instance)` |
| `slot.fade` | `desc.brightness`, pushed with `host.updatePlane` when it changes by 1/128 or more. |
| asleep or leaving | `instance.paused = true`: drawn, not stepped. |

`startStreamingWorld` scales the world for the engine: sectors 12 units wide,
5,000 particles per square unit, 2,000 to 2 million per plane, 192 slots with
64 awake. All of it can be overridden through its options.

The opening camera comes from `openingCamera({ seed })`: it frames the structure
nearest the origin, so the first view is never empty. The streamer's load
radius is 3.5 sectors, so that framed structure sits at full brightness.

Limits to know about:

- Loading another scene (dice roll, plane count slider) clears the streamed
  planes; the streamer then refills around the camera on top of that scene.
- "Go to nearest plane" does not know about streamed planes yet.
- None of this has been run on a GPU. The driver is tested against a fake host.

## Preview and tests

- Preview without the engine: `npm run dev`, then open
  `/src/world/demo/index.html`. It draws each resident plane as dots on a 2D
  canvas. Options: `?seed=strata&planes=400&awake=100&only=cathedral,fan&auto=0`.
  Drag to look, WASD and QE to move, shift for speed, space toggles the drift.
- Tests: `node src/world/test/run.mjs` (bundles with the esbuild that ships
  with Vite, then runs Node's test runner).
