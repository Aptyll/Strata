# Visual fix briefs

Each brief turns a screenshot or render into a fix that another agent can pick up without the person who took the image. Every brief says what is wrong, the likely cause in code (file and line), a proposed fix, and how to confirm the fix by looking. Line numbers are as of the main commit named at the top of each brief, so re-check them before editing. Each brief also quotes the code it points at, so `git grep` finds it after lines move (PR #97, for example, moved lines in `src/challenge` by 24 to 86).

Research briefs (what to build, from the papers and notes) live one folder up in [`docs/briefs/`](../). These briefs are the visual half: what the pictures show is wrong today.

## Index

| ID | Finding | Evidence | Severity | Owner (folder) | Status |
| --- | --- | --- | --- | --- | --- |
| [V01](V01-edge-on-sheets-saturate.md) | Sheets seen edge-on collapse into saturated white needles | `engine/first-render.png`, 1T frames (worst in `trillion-A.png`) | medium | `src/perf`, `src/challenge`, `src/render`, `src/passes`, `src/depth`, `src/offline` | look decision for Noah. Until he chooses, keep true density (no change) |
| [V02](V02-tone-curve-lifts-mid-greys.md) | The realtime tone curve lifts one particle to mid-grey and squeezes dense structure | shader arithmetic, `render/density-demo-1M.png`, `engine/first-render.png` | medium | `src/render`, `src/passes`, `src/challenge` | open |
| [V03](V03-dense-frames-come-out-flat.md) | Dense frames come out flat because auto exposure has no black floor | `render/counts-auto-exposure.png`, 1T frames | high for the 1T video, medium for the app | `src/render/counts.ts`, `src/offline/core/grade.ts` | 1T part done: contrast 256 (Noah, 01:39 UTC) in PR #67. `CountToneMapper` floor open |
| [V04](V04-depth-haze-lifts-the-void.md) | Depth cues fix the blown core but fill the void with grey haze | `docs/depth/cues-off.jpg`, `cues-on.jpg` | medium (off by default) | `src/depth` | open |
| [V05](V05-bench-stats-unreadable.md) | Bench stats are unreadable over bright particles | `perf/bench-2M-software.png` | low | `src/perf/bench` | open, one line of CSS. The challenge and perf review thread takes it after the freeze |
| [V06](V06-trillion-label-overwritten.md) | The 1T honesty label is erased where bright sheets sit behind it | `trillion-key1-f0.png`, `trillion-C.png` | high for the video | `src/offline/core/grade.ts` | fixed in PR #67, grade-only |

Evidence paths without a folder are in the project files. Each brief has a cropped, annotated image in [`img/`](img/).

## Reviewed, no brief needed

- **HUD demo screenshots** use a CPU stand-in for the particles, so their look says nothing about the renderer.
- **The world preview overlay** is demo-page chrome, not part of the app.
- **Density demo test patterns** (stripes, rings and their moiré) are deliberate stress patterns for the demo page.
- **`counts-fixed-white-64`** is an intentional comparison against auto exposure, not the shipped look.
- **The behavior preview** looks right.
- **Ring moiré in `trillion-A.png`** came from the point splat, used for speed. The exact bilinear splat already exists, and PR #67 makes it the default for the hero shots.
- **The near-sheet whip in `offline/look-test-40M-720p.mp4`** is a camera path passing close to a sheet, not the near clip. The offline renderer thread plans camera motion blur after the record.

## Per-image notes

Every render, GIF or MP4 in the project files gets a `<name>.notes.md` next to it: what it shows, what works, what's wrong, the likely code cause, and any answers from Noah. Findings that need code work become a brief here.

## Adding a brief

1. Name it `Vnn-short-finding.md` with the next free number.
2. Use the same sections: a severity line, Evidence, What is wrong, Likely cause in code (file and line, with the main commit), Proposed fix, How to confirm, and Owner.
3. Put one cropped, annotated image in `img/` as a JPG under about 250 KB.
4. Measure instead of guessing: `python3 docs/briefs/visual/image-stats.py shot.png` prints the size, mean, median and 95th percentile of lit pixels, the share of near-black and saturated pixels, and the number of distinct grey levels.
5. Add a row to the index, and tell the owning thread.
