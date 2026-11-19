# Agent briefs

Short, self-contained work orders distilled from the project's research: the
rendering field guide (`docs/explainers/rendering.html`), `docs/render.md`,
`docs/perf.md`, `docs/gpu-scale.md`, `src/challenge/README.md`,
`src/offline/README.md`, and the reflection and skeptic reviews of 2026-11-19.

Each brief has the same five parts: context, the research conclusion, concrete
steps, files to touch, and done criteria. An agent should be able to start from
the brief alone. Numbers are arithmetic unless marked "estimate". Each brief
has a "state on main" note as of PR #51; check `git log` for anything newer.

## Priority order for the 1 trillion particle video

| # | brief | why it is here | owner (2026-11-19) |
| --- | --- | --- | --- |
| 1 | [throughput-math-2070](throughput-math-2070.md) | Nothing can be scheduled until one real particles/second number exists. It fixes clip length and fps. | unowned |
| 2 | [64-bit-ids](64-bit-ids.md) | If identity is 32 bits in any one distribution, "1T" is 4.29B particles drawn 233 times. The claim fails. | done for `src/offline` (PRs #45, #47); open: `src/trillion` still on 32-bit keys |
| 3 | [honest-counting](honest-counting.md) | The video is only as strong as its proof: exact tally, manifest, wording. | mostly done (PRs #43, #48, #49); open: GPU-counted `evaluated`, manifest, `npm run record` |
| 4 | [video-scale-ladder](video-scale-ladder.md) | The deliverable: 1M to 1T on one shot, ending with 1T collapsed into one pixel. | unowned; builds on `src/proof` |
| 5 | [accumulation-and-tonemap](accumulation-and-tonemap.md) | Where 1T looks different from 1B, and how not to hide it. | cleanup threads own `src/render`, `src/depth` |
| 6 | [unify-rasterizers](unify-rasterizers.md) | Realtime app quality. Off the 1T critical path. | unowned (coordinate with the cleanup threads) |

Rule for all of them: Noah asked for speed over verification. Type check
(`npx tsc --noEmit`) and a quick build (`npm run build`) only; real testing is
on Noah's RTX 2070 at the end. Work through a PR rebased on latest main. Add
files rather than editing shared ones.

## Facts every brief relies on

| fact | value | source |
| --- | --- | --- |
| 4K pixels | 3840 x 2160 = 8,294,400 | arithmetic |
| 1T at 4K, mean hits per pixel | 120,563 | arithmetic |
| distinct values of a u32 | 4,294,967,296; 1T / 2^32 = 232.8 | arithmetic |
| f16 additive target | stops counting near 2048 x (weight per add) | 11-bit significand; `docs/gpu-scale.md` rule 8 |
| u32 counter | 4,294,967,295 per pixel | arithmetic |
| shot noise | relative wobble 1 / sqrt(n) | Poisson statistics |
| RTX 2070 | 2304 lanes, ~1.62 GHz boost, 448 GB/s, 4 MB L2, 8 GB | spec sheet |
| RTX 2070, measured | `PerfEngine` brute force at 1080p: about 11.6 G particles/s | `docs/perf.md` (PR #44) |
| 1T stateless kernel at 4K | **not measured** | run `npx tsx node/cli.mjs bench` in `src/offline` |

## More agents worth starting

Beyond the brief executors, ideas that came out of this distillation:

1. **Collapse-shot kernel tuner.** The final frame puts 10^12 atomic adds on one
   pixel. Same-address atomics serialize, so this one frame can take far longer
   than the rest. Adds per-thread write combining to `src/offline/core/shaders.ts`
   (see [video-scale-ladder](video-scale-ladder.md)).
2. **Grain prover.** Renders one frame at 1B, 10B and 1T with exposure locked,
   and outputs a per-pixel noise map. Shows where 1T is visibly different (the
   faint regions) and where it is not (the dense cores).
3. **Coherent-id experiment.** Orders particle ids so that consecutive ids land
   near each other on screen, then measures the atomic speedup on the 2070.
4. **Claims fact-checker.** Reads the video script, title and description and
   checks every number against the manifest and `docs/briefs`.
5. **Export quality tester.** Encodes the same graded frames as 8-bit and
   10-bit, uploads privately to YouTube, and compares banding in the faint
   regions after YouTube's transcode.
