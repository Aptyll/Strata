# Record frames

Frames from the offline renderer ([src/offline](../../src/offline/README.md)),
rendered on one RTX 2070 (8 GB) on 2026-11-19. Each is 3840x2160 with
1,000,000,000,000 stateless particles: the position of every one of them is
computed for the frame, and the ones that land in view are added into a 64-bit
accumulation grid. The label in the bottom left is burned in by the renderer
and reports how many particles landed in view. These stills were rendered with flux weighting (the default of
`/src/offline/web/`, which has no weighting control; their 26 to 52 s frame
times match flux speed, and each frame's job.json on the desktop confirms it): a far particle gets a randomly rounded weight,
often zero, so it counts as in view but is drawn only on average. The
in-view numbers are exact GPU counts of positions inside the frame, not of
units of light added. A frame takes 26 to 52 seconds
on this card, depending on how spread out the hits are.

| frame | view | particles in view |
| --- | --- | ---: |
| [trillion-key1-f0.png](trillion-key1-f0.png) | inside the field of sheets, wide | about 843 billion (two digits of the label are hidden behind a sheet) |
| [trillion-key2-f0.png](trillion-key2-f0.png) | closer, one large Kepler disc in front | 107,787,615,440 |
| [trillion-A.png](trillion-A.png) | close-up of a few big sheets: a spiral disc, a Lissajous ribbon, a ring sheet | 985,878,512,802 |
| [trillion-B.png](trillion-B.png) | a column of sheets stacked one above another, seen from the side | 927,901,560,630 |
| [trillion-C.png](trillion-C.png) | wide shot inside the field, hundreds of small sheets edge to edge | about 31% of the trillion (two digits of the label are hidden behind a sheet) |
| [trillion-still-f0.png](trillion-still-f0.png) | the first frame: the whole cluster from far away | every sheet is in frame |

These are 8-bit PNG exports of the developed frames. The particles are
rendered, not simulated: see "Rendered, not simulated" in the
[README](../../README.md#rendered-not-simulated).
