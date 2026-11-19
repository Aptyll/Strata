# Record frames

Frames from the offline renderer ([src/offline](../../src/offline/README.md)),
rendered on one RTX 2070 (8 GB) on 2026-11-19. Each is 3840x2160 with
1,000,000,000,000 stateless particles: the position of every one of them is
computed for the frame, and the ones that land in view are added into a 64-bit
accumulation grid. The label in the bottom left is burned in by the renderer
and reports how many particles landed in view. The 32-bit stills were most likely rendered with flux weighting as it was then (it was the default of
`/src/offline/web/`, which had no weighting control; each frame's job.json on
the desktop can confirm it): a far particle gets a randomly rounded weight,
often zero, so it counts as in view but is drawn only on average. That mode is
now the page's "flux, quick" choice (`fluxBits: 16`); flux frames rendered since
keep every far particle's light and say so in their label. The
in-view numbers are exact GPU counts of positions inside the frame, not of
units of light added. With that flux weighting a frame took 26 to 52
seconds on this card when the sheets cover part of the frame, and 161 to 205
seconds when they fill it (composition A). Count weighting takes about 160 to
193 seconds.

## Distinct particles and keys

**64-bit stills** (`trillion64-A`, `trillion64-B`): rendered at commit
`1e7e66e` (clean tree) with the 64-bit `particleKey` from
`src/stateless/rng.ts`, so each of the trillion particles has its own
key. Each has its render manifest beside it (`*.manifest.json`, see
`src/manifest`): GPU-counted evaluated and landed, GPU, commit, full job.
Both are flux-weighted, so far particles are drawn on average, not one by one.

Keys are exactly distinct: a key is a bijection of sheet seed and index, and
seeds are unique, so no two of the 10^12 particles share one. Paths are nearly
distinct: each law turns the key into a few 32-bit floats, so by chance two
particles on the same sheet can round to the same path (the layers of one
sheet count together). In trillion64-A, whose four sheets hold 250 billion
particles each, 99.87% of particles follow a path no other particle follows;
in trillion64-B, 99.98%. These are model estimates from the distinctness proof
thread, checked against direct counts. Say "10^12 particles, each with its own
64-bit key"; avoid an unqualified "10^12 distinct particles" or "unique paths".

**32-bit cluster stills** (`trillion-still-f0`, `key1`, `key2`, `C`, and
`trillion256-K0` and the `k068` clip in the project folder): rendered at
`41e853a` or `c42ceda` (from the desktop's git reflog; which of the two is not
recorded per still), before PR #45, on the old 32-bit `pcg` keys. All 10^12
particles were evaluated, and within a sheet no two coincide (each sheet holds
fewer than 2^32 and `pcg` is a bijection on 32 bits), but the whole frame
draws from only about 4.3 billion distinct keys: the same key values recur on
every sheet, each under its own transform. So do not call these "10^12
distinct particles"; say "10^12 particles rendered".

**Retired** (`retired/trillion-A-32bit.png`, `retired/trillion-B-32bit.png`,
and `trillion256-A` in the project folder): compositions A and B on 32-bit
keys stacked coincident sheets with identical parameters, so those sheets drew
the same particles. A held at most about 17.2 billion distinct particles
(about 58 repeats each), B at most about 137 billion (about 7). Kept only as a
record of the mistake; `trillion64-A` and `trillion64-B` replace them.

| frame | view | particles in view (GPU count) | seconds | keys, commit | distinct |
| --- | --- | ---: | ---: | --- | --- |
| [trillion64-A.png](trillion64-A.png) ([manifest](trillion64-A.manifest.json)) | close-up of a few big sheets: a spiral disc, a Lissajous ribbon, a ring sheet | 985,878,422,357 | 161.4 | 64-bit, `1e7e66e` | 10^12 distinct keys; 99.87% distinct paths |
| [trillion64-B.png](trillion64-B.png) ([manifest](trillion64-B.manifest.json)) | a column of sheets stacked one above another, seen from the side | 927,901,486,604 | 51.4 | 64-bit, `1e7e66e` | 10^12 distinct keys; 99.98% distinct paths |
| [trillion-key1-f0.png](trillion-key1-f0.png) | inside the field of sheets, wide | about 843 billion (two digits of the label are hidden behind a sheet) | 52 | 32-bit pcg, `41e853a`/`c42ceda` | ~4.3B distinct keys, reused across sheets |
| [trillion-key2-f0.png](trillion-key2-f0.png) | closer, one large Kepler disc in front | 107,787,615,440 | 26 | 32-bit pcg, `41e853a`/`c42ceda` | ~4.3B distinct keys, reused across sheets |
| [trillion-C.png](trillion-C.png) | wide shot inside the field, hundreds of small sheets edge to edge | about 31% of the trillion (two digits of the label are hidden behind a sheet) | 48 | 32-bit pcg, `41e853a`/`c42ceda` | ~4.3B distinct keys, reused across sheets |
| [trillion-still-f0.png](trillion-still-f0.png) | the first frame: the whole cluster from far away | every sheet is in frame | 28.9 | 32-bit pcg, `41e853a`/`c42ceda` | ~4.3B distinct keys, reused across sheets |
| [retired/trillion-A-32bit.png](retired/trillion-A-32bit.png) | composition A, retired | 985,878,512,802 | 172 | 32-bit pcg | **no**: at most ~17.2B distinct particles |
| [retired/trillion-B-32bit.png](retired/trillion-B-32bit.png) | composition B, retired | 927,901,560,630 | 59 | 32-bit pcg | **no**: at most ~137B distinct particles |

The 32-bit seconds are as reported by the desktop agent; the 64-bit ones come
from the manifests.

These are 8-bit PNG exports of the developed frames. The particles are
rendered, not simulated: see "Rendered, not simulated" in the
[README](../../README.md#rendered-not-simulated).

## Web-sized copies

`web/` holds half-size JPEG copies of the frames that the main README shows
inline, made by `src/site/share/make-web-frames.py`. They are there so that
page loads fast (444 kB for its two pictures, where the PNGs are 3.3 MB), and
each one links to its PNG here. A copy is a picture of a frame, not the frame:
counts, comparisons and zooming in belong to the PNGs.
