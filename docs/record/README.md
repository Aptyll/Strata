# Record frames

Frames from the offline renderer ([src/offline](../../src/offline/README.md)),
rendered on one RTX 2070 (8 GB) on 2026-11-19. Each is 3840x2160 with
1,000,000,000,000 stateless particles: the position of every one of them is
computed for the frame, and the ones that land in view are added into a 64-bit
accumulation grid. The label in the bottom left is burned in by the renderer
and reports how many particles landed in view. These stills were rendered with flux weighting as it was then (most likely: it was the default of
`/src/offline/web/`, which had no weighting control; each frame's job.json on
the desktop can confirm it): a far particle gets a randomly rounded weight,
often zero, so it counts as in view but is drawn only on average. That mode is
now the page's "flux, quick" choice (`fluxBits: 16`); flux frames rendered since
keep every far particle's light and say so in their label. The
in-view numbers are exact GPU counts of positions inside the frame, not of
units of light added. With flux weighting a frame takes 26 to 52
seconds on this card when the sheets cover part of the frame, and 172 to 205
seconds when they fill it (composition A). Count weighting takes about 160 to
193 seconds.

## Distinct particles: read this before using A or B

Every still here was rendered at commit `41e853a` or `c42ceda` (from the
desktop's git reflog; which of the two is not recorded per still). That is
before PR #45, so the particle keys were the old **32-bit** `pcg` keys, not
the 64-bit `particleKey` from `src/stateless/rng.ts`.

- **Cluster renders** (`trillion-still-f0`, `key1`, `key2`, `C`, and
  `trillion256-K0` and the `k068` clip in the project folder): still a
  trillion **distinct** particles. Each sheet holds fewer than 2^32 particles,
  `pcg` is a bijection on 32 bits, and every sheet has its own transform, so
  no two particles coincide.
- **Compositions A and B** (`trillion-A`, `trillion-B`, and `trillion256-A`):
  **not** a trillion distinct particles. They stack coincident sheets with
  identical parameters, so on 32-bit keys those sheets draw the same
  particles. A holds at most about **17.2 billion** distinct particles (each
  repeated about 58 times); B at most about **137 billion** (about 7 times).
  The 1,000,000,000,000 in their labels is particles evaluated, not distinct
  particles. Do not use them as trillion frames. They are being re-rendered on
  64-bit keys and will replace these files.

| frame | view | particles in view | keys | 1T distinct |
| --- | --- | ---: | --- | --- |
| [trillion-key1-f0.png](trillion-key1-f0.png) | inside the field of sheets, wide | about 843 billion (two digits of the label are hidden behind a sheet) | 32-bit pcg, `41e853a`/`c42ceda` | yes |
| [trillion-key2-f0.png](trillion-key2-f0.png) | closer, one large Kepler disc in front | 107,787,615,440 | 32-bit pcg, `41e853a`/`c42ceda` | yes |
| [trillion-A.png](trillion-A.png) | close-up of a few big sheets: a spiral disc, a Lissajous ribbon, a ring sheet | 985,878,512,802 evaluated positions in frame | 32-bit pcg, `41e853a`/`c42ceda` | **no**: at most ~17.2B distinct |
| [trillion-B.png](trillion-B.png) | a column of sheets stacked one above another, seen from the side | 927,901,560,630 evaluated positions in frame | 32-bit pcg, `41e853a`/`c42ceda` | **no**: at most ~137B distinct |
| [trillion-C.png](trillion-C.png) | wide shot inside the field, hundreds of small sheets edge to edge | about 31% of the trillion (two digits of the label are hidden behind a sheet) | 32-bit pcg, `41e853a`/`c42ceda` | yes |
| [trillion-still-f0.png](trillion-still-f0.png) | the first frame: the whole cluster from far away | every sheet is in frame | 32-bit pcg, `41e853a`/`c42ceda` | yes |

These are 8-bit PNG exports of the developed frames. The particles are
rendered, not simulated: see "Rendered, not simulated" in the
[README](../../README.md#rendered-not-simulated).
