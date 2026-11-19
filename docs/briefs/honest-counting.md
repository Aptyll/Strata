# Brief: honest counting

Owners (2026-11-19): the offline renderer (`src/offline` in-frame tally), the
recorder (`src/record`), the record script thread (`npm run record`), and the
proof shots thread (`src/proof`). This brief is the shared definition they all
build to, so every piece reports the same numbers.

## Context

The headline is "one trillion particles". Skeptics will check three things:
that the word is right, that every particle was really computed, and that no
particle is a copy. A reflection review on 2026-11-19 listed the proof devices:
an exact tally, a deep zoom to single dots, a count ladder, and published
seed, code and measured speed.

## Research conclusion

1. **Wording.** The 1T film is *rendered* (or "procedurally animated"), never
   "simulated". Its particles have no stored state and do not interact; motion
   is a closed-form law. Real simulations with about 2 trillion particles exist
   (for example the Uchuu cosmology run, 12800^3, about 2.1 x 10^12), so "first
   trillion particle simulation" would be false. The simulation claim belongs to
   the realtime tier: 100M particles with 8 bytes of state read, integrated and
   written every frame (`src/challenge/README.md`, "What counts").
2. **What the number means.** The claim is *evaluated per frame*: every id
   from 0 to N - 1 went through the kernel exactly once in that frame. Also
   report *landed*: how many passed the clip test (position inside the frame).
   Under `count` weighting every landed particle adds exactly one unit, so
   grid sum / 65536 = landed. Under `flux` weighting a particle adds a share
   of a unit that falls with distance, in grid units of 2^-`fluxBits`; one
   whose weight rounds to nothing is landed but not drawn. The GPU counts
   *drawn* as well: call a flux render "every particle drawn" only when its
   `drawn` equals `landed`. Flux frames from before 2026-11-19 have no `drawn`
   count and were drawn in expectation only.
3. **Weight one.** For the claim, every particle counts as exactly one. No
   level-of-detail multiplier (`PerfEngine` brightens a thinned plane by
   `count / k`, so it may never feed a record), no instancing, no copies (see
   [64-bit-ids](64-bit-ids.md)). Flux weighting (dimmer when far) changes the
   grid sum into a light total, so use `weighting: "count"` wherever a number
   is shown.
4. **Count on the GPU.** The host only knows what it dispatched.
5. **Prior art to credit.** Histogram renderers that accumulate billions of
   samples per image (fractal flames, the Buddhabrot), and compute-shader point
   rasterization (Schütz, Kerbl, Wimmer, 2021).

## State on main (2026-11-19, after PR #58)

Done: an exact 64-bit `landed` tally, aggregated per workgroup (PR #43);
`evaluated` counted on the GPU, and frames that miss any particle refused
(PR #52); 64-bit particle keys (PRs #45, #47, #58); proof shots that burn in GPU numbers with
`count` weighting and `point` splats (PR #49, `src/proof`); record renders from
the app with a tally per frame (PR #48, `src/record`).

Open:

1. **Manifest per render**: git commit, job JSON and its fingerprint
   (`jobFingerprint` exists in `src/offline/core/session.ts`), seed, GPU
   adapter string, measured particles per second, per-frame evaluated and
   landed, wall time per frame. Saved next to the frames and published with
   the video.
2. **Reproduction**: `npm run record` (record script thread) re-renders a short
   clip from a manifest and compares per-frame counts and a grid hash.
3. **Wording audit**: HUD, record labels, proof labels, video text. "Rendered",
   never "simulated", for anything stateless.

## Files to touch

- `src/record/index.ts`, `src/offline/core/session.ts` (manifest)
- root `package.json` (record script)

## Done when

- Every number on screen is read from the frame stats (GPU-counted
  `evaluated` and `landed`), never from the job.
- A manifest exists for every render, and `npm run record` reproduces a clip's
  counts and grid hash from it.
- No text in the app, video, title or description says "simulated" about a
  stateless shot.
