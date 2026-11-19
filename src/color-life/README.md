# color life

Particle life with color species, simulated on the GPU. Each particle has a
color, and its color is its rule: a rolled matrix says how strongly each color
is pulled toward or pushed away from every other color. Nobody scripts the
shapes; clusters, chasing chains, cells with membranes and rotating rings come
out of the matrix.

Demo: `/src/color-life/demo/` (also in the production build).

| key | does |
| --- | --- |
| R | roll new rules (new seed, shareable as `#r=<seed>`) |
| S / Shift+S | one more / one fewer color, then roll |
| X | scatter every particle again |
| Space | pause |
| M | hide or show the rule matrix (green pulls, red pushes; row feels, column causes) |
| [ ] | exposure |
| drag, wheel, 0 | pan, zoom, reset view |

URL: `?n=1000000` particles, `?grid=<cells per side>`, `?species=2..8`,
`?style=random|symmetric|chase|cells`.

## How it works

Simulated, not stateless: 20 bytes per particle (position, velocity, species),
held twice for the sort. Per frame, all on the GPU (`shaders.ts`):

1. **bin**: count particles per grid cell (`atomicAdd`).
2. **scan**: exclusive prefix sum of the counts (block scan, then a scan of
   block totals, then add back). The last entry is the GPU's own count of
   particles binned, which is what the HUD shows.
3. **scatter**: copy each particle into its cell's range (state A to B).
4. **integrate**: one thread per sorted slot reads the 3 x 3 cells around it
   from B, sums the particle life force, integrates, writes back to A.

The interaction radius is one cell (`2 / grid`), and by default the grid has
about 12 particles per cell, so the work per particle stays about constant as
the count grows. The sheet wraps on both axes.

The force (`pairForce` in `rules.ts`, `force` in WGSL): inside `beta` of the
radius every pair repels; from `beta` to the radius the rule value sets a
triangular bump of attraction or repulsion. Rule styles: `random`,
`symmetric` (stable blobs and rings), `chase` (each color hunts the next),
`cells` (strong self attraction, membranes).

Render: each particle adds its species color into an `rgba16float` target,
then a per-channel tone map. Dense regions glow in their own hue and go
toward white at the core.

## Status and limits

- Standalone. It does not change the app's `Simulation`, the perf engine, or
  the stateless trillion path. Bringing it into the world of sheets needs a
  neighbor hook in the behavior contract (the contract forbids reading
  neighbors today), as its own PR.
- `npm run verify -- color-life` checks that the shaders compile, that the
  grid sort keeps every particle in cell order, and that one GPU step matches
  a brute-force CPU force to about 1e-7.
- Speed is unmeasured. Cost grows with how dense the clusters get: a dense
  cell makes every neighbor loop around it longer.
