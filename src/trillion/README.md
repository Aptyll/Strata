# src/trillion

A GPU kernel that evaluates stateless particles in batches and adds exactly 1 to one pixel counter per particle that lands in frame, with nothing stored per particle. This is the fast path toward rendering 1 trillion particles per frame.

- **Entry point:** `index.ts`.
- **Key files:** `kernel.ts` (`TrillionKernel`), `driver.ts` (paces a frame in short submits under the Windows GPU timeout, interleaved so a partial frame is an unbiased preview), `wgsl.ts` (the splat kernel), `offlineLaws.ts` (the offline renderer's motion laws as kernel laws: `OFFLINE_LAWS` for the plain path, `STRATIFIED_OFFLINE_LAWS` for the fast coherent one), `laws.ts` (stand-in test laws).
- **`demo/`:** `/src/trillion/demo/?n=1e12` renders one frame progressively; `window.__trillion.selftest()` checks the exact tally, `compare()` the fast path against the plain one, `blurTest()` the camera blur; `?bench` times the paths.
- **`test/`:** CPU checks of the fixed-point rounding, the strata row limit and the `tri` rewrite (`npm test -- trillion`).
- **Depends on:** `src/stateless/rng.ts` (64-bit particle keys), `src/offline/core/laws.ts`.
- **Doc:** `docs/trillion.md` (why the kernel is shaped this way, usage, limits).
- **Used by:** `src/offline/core/renderer.ts` as the `trillion` kernel (`--kernel trillion`, with `OFFLINE_LAWS`).
- **Status:** selectable in the offline renderer; that renderer's own kernel is still the default.
