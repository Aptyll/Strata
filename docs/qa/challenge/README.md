# Visual QA: the particle-count path

Annotated findings from rendering the record path headless and reading the
pixels back: the shared density look (`src/render`), captures and MP4
(`src/capture`), Challenge mode (`src/challenge`), the offline 1T renderer
(`src/offline`) and the trillion kernel (`src/trillion`). Each image names the
code it checks, the owner, the commit it was rendered from and how every
number was measured. The harness that made them is
[`qa/challenge/`](../../../qa/challenge/README.md).

All renders ran on a software GPU (SwiftShader) in the cloud: pixel values are
exact readbacks, but nothing here says anything about speed, and counts stay
at or below 400M particles per frame.

| # | finding | severity | owner | status |
| --- | --- | --- | --- | --- |
| [01](01-white-point-drifts-with-count.jpg) | The docs/render.md recipe washed out as counts grew (exposure 1 left the black point at one particle). Since PR #194 it sets the black point from the mean density: the same frame at 17 and 31,000 particles per pixel is 0.01 levels apart (was 16.7), and 0.5M to 32M real counts move the mean 7.8 levels (was 19.2) | fixed, verified | Render density beyond screen resolution | fixed in PR #194 |
| [02](02-supersampled-captures.jpg) | Supersampled captures: the capture gain (PR #96) and linear-light downscale (PR #99) fix most of the loss, but supersample 2 and 3 still come out 5% and 9% darker | minor | Export MP4 videos for YouTube | open; the owner agrees with the likely cause (the tone map runs on each subpixel before the average) and leaves it for now |
| [03](03-mp4-full-range.jpg) | MP4s were full-range YUV, so a tool that assumes limited range turned every pixel below 16/255 black (40% of the lit pixels in the test video). Since PR #196 the recorder writes BT.709 limited range (yuv420p, tv), the 1T web export included, and faint pixels lose no more than H.264 already took (2.7% of the lit pixels, as in full range read by its own flag) | fixed, verified | Export MP4 videos for YouTube; offline renderer (web export) | fixed in PR #196 |
| [04](04-offline-label-readable.jpg) | The burned-in particle count stays readable over bright sheets | fixed, verified | Render offline record-scale particle video | fixed in PR #67 (brief V06) |
| [05](05-offline-counts.jpg) | Offline renderer at 4M, 40M, 400M: no lattice or repetition, void exactly black. Note: the trillion shot builds its camera path and fluxRef from the particle count, so smaller previews leave the 1T framing at frame 240 | ok, with a note for previews | Render offline record-scale particle video | note |
| [06](06-challenge-counts.jpg) | Challenge mode: caustic cores clip to flat white at the default exposure, at every count | minor | Build challenge mode for record particle counts | addressed in PR #193: the default exposure is now 0.012, which this figure measured at 4M procedural (0.44% clipped, an 11% lower mean); not rendered again at the other counts |
| [07](07-temporal-stability.jpg) | No flicker between consecutive frames on any path; the frozen-scene void stays black | ok | render, challenge and offline threads (FYI) | checked |
| [08](08-tone-ramps.jpg) | No banding on smooth density ramps with dither on; the dither adds no bias | ok | Render density beyond screen resolution (FYI) | checked |
| [09](09-trillion-kernel.jpg) | Trillion kernel: counter sums equal the landed tally, the self test passes, the stochastic splat is unbiased | ok | Build the trillion-particle splat kernel | checked; tile path not exercised |
| [10](10-short-jobs-smear.jpg) | Since camera blur (PR #92), a short offline job smears the whole camera move | minor | Render offline record-scale particle video | open |
| [11](11-trillion-kernel-flux.jpg) | In the offline renderer, kernel 'trillion' turns flux weighting into a subsample: same light, but only a few percent of the particles in frame add it, at full weight (2.2% in the test frame by the GPU's own drawn count; about 2 million of 1e12 in the 1T opening) | minor | Build the trillion-particle splat kernel; FYI offline renderer | open; the film uses kernel 'offline' |

## Which code each image saw

Main moves fast, so each figure's footer names the commit it was rendered
from. Unless noted, that is `df80a27` (01 and 03 are from `31a1106`, with the
`df80a27` run as 01's before; 11 is from `cf36c3f`; the "before" captures in
02 and 04 are from `c42ceda`; and the real 1T frames in 05 are the RTX 2070
stills in `docs/record/`). Changes merged after `df80a27` that touch what a
finding looked at, up to `aa54086`:

- **01, 08** (`src/render`): PR #194 gives the docs/render.md recipe and the
  render demo a black point from the mean density. 01 was rendered again at
  `31a1106` through the new recipe (the harness look's `black: 'mean'`, now
  its default). 08 runs the tone curve on synthetic ramps at a fixed white, so
  the recipe does not reach it, and 07's render frames, from the old recipe,
  compare frames with each other, which the recipe does not change.
- **02, 03** (`src/capture`): PR #144 adds an audio track to recordings, PR
  #160 locks pages to their own address, and PR #196 converts frames to BT.709
  limited range in the recorder. 03 was rendered again at `31a1106`, recording
  the same frames with range 'limited' (the default) and 'full'. 02's
  resampling path was not checked again.
- **04, 05, 10** (`src/offline`, `src/stateless`): PR #153 hashes the seed
  before the Feistel rounds and gives `tri()` 24-bit resolution, so every
  particle moved (statistically the same). It also removed about 20.6M twin
  trajectories from the 1T preset, which a spectrum cannot see: 05's "no
  repetition" is about lattices and tiling, not duplicate particles
  (`docs/record` now gives the share of distinct paths, PR #187). PR #149
  adds new laws and presets and takes the trillion kernel's evaluated count
  from the GPU. PR #166 makes flux weights as fine as the grid allows (2^-31
  of a particle up to 4 billion particles, 2^-23 at 1T; they were 1/65,536,
  and a dimmer particle added one unit or nothing at random) and has the GPU
  count the particles that added light. 05's lattice and void checks do not
  depend on the weights; how faint far sheets look does, and was not checked
  again. The label's wording changed with it (it says whether every particle
  in frame added light), not how it is drawn, so 04 stands.
- **06** (`src/challenge`): PR #139 dropped the 1/2.2 power after the log curve
  (brief V02), so Challenge renders darker. 06 was rendered again at `1820b1d`,
  after it, and compares the two (07's Challenge panel is from `1820b1d` too).
  PR #175 changes how the count is searched on screens capped at the target
  frame rate, not the picture. PR #193 lowers the default exposure from 0.02
  to 0.012 (06's measured alternative) and adds an optional subgroup merge of
  same-pixel hits, off by default.
- **09, 11** (`src/trillion`): PR #157 keeps the partial tile inside its bins
  on very wide frames. PRs #171 and #174 add camera blur to the trillion kernel,
  keep its salt constant across frames (09's per-frame grain no longer
  changes), and add a `trillion-strata` kernel choice, which none of these
  figures ran. 11 was rendered again at `cf36c3f`, after them and after PR
  #166: the per-sheet keep probability is unchanged, and the new drawn count
  shows it.

## Related briefs

- **V02** (tone curve lifts mid-greys): done for the app and Challenge in PR
  #139. 06 records the clipping that PR left open, which PR #193 cut to about
  0.4% with a lower default exposure.
- **V03** (CountToneMapper has no black floor): PR #194 gave the docs recipe a
  black point from the mean (01). CountToneMapper's own floor is still open in
  the brief; 01 suggests setting it from percentiles, so the picture stays
  independent of the count.
- **V06** (label overwritten by bright sheets): verified fixed in 04.

## Reproduce

```sh
node qa/challenge/run.mjs --out /tmp/qa/new
python3 qa/challenge/annotate.py --in /tmp/qa/new docs/record --out docs/qa/challenge
```

The "before" panels in 01, 02 and 04 need a run from an older commit listed
after the new one in `--in` (03 records both colour ranges in one run).
