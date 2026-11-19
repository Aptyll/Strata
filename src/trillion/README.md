# src/trillion

A GPU kernel that evaluates stateless particles in batches and adds exactly 1 to one pixel counter per particle that lands in frame, with nothing stored per particle. This is the fast path toward rendering 1 trillion particles per frame.

- **Entry point:** `index.ts`.
- **Key files:** `kernel.ts` (`TrillionKernel`), `driver.ts` (paces a frame in short submits under the Windows GPU timeout, interleaved so a partial frame is an unbiased preview), `wgsl.ts` (the splat kernel), `offlineLaws.ts` (the offline renderer's motion laws as kernel laws), `laws.ts` (stand-in test laws).
- **`demo/`:** `/src/trillion/demo/?n=1e12` renders one frame progressively; `window.__trillion.selftest()` checks the exact tally.
- **Depends on:** `src/stateless/rng.ts` (64-bit particle keys), `src/offline/core/laws.ts`.
- **Used by:** nothing yet; intended to stand behind `StatelessRenderer` in `src/offline`.
- **Status:** standalone.
