# Trillion proof shots

Thin wrappers around the offline renderer (`src/offline`) for the short
version of `prompts/trillion-believability.md`. Open `/src/proof/web/` under
`npm run dev`, pick a shot, choose a folder (one per shot), render, export mp4.

| shot | what it shows | cost at 1T |
| --- | --- | --- |
| count-up | one frozen frame built from 1 particle to all, 3 stages per decade | about 1.7 trillion-frames |
| pull-back | from one particle to the whole world, count growing log-uniformly | about frames / 27.6 trillion-frames (10 s at 30 fps: about 11) |
| loupe | one dice-chosen pixel, its exact 64-bit count, then that pixel opened up | 1 trillion-frame plus 1 |
| dive | unbroken log zoom, whole world to a few dots, 1.5 s per decade | every frame is a full trillion-frame: run at a lower count or short |
| find | fly to particle #N (default #999,999,999,999) and hold, with a ring | every frame full: same as dive |

Every number burned in comes from the GPU: `landed` (the in-frame tally) and
the evaluated count of the frame's own job, or the exact pixel counter for the
loupe. All shots use `weighting: "count"` and `splat: "point"`, so one
particle adds exactly one unit. Wording: rendered, never simulated.

Particle #N is indexed sheet by sheet: sheet = how many whole sheets fit
before N, index = the rest. The find shot computes its position with the CPU
copy of the same law (`offline/core/laws.ts`); f32 vs f64 drift is far below
the final dot spacing but was not measured.
