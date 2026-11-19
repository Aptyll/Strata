# src/behaviors

The motion rules that run on each plane. A behavior is a WGSL `update` snippet plus named params (the `Behavior` type in `src/core/contracts.ts`), compiled into the engine's compute shader by `src/gpu/shaderLib.ts`. See `docs/behaviors.md` and `docs/behavior-library.md`.

- **Key files:** `index.ts` (`behaviors`, `getBehavior`; every `*.behavior.ts` file here registers itself, so adding one touches no shared file), the behaviors (`flow`, `curl-flow`, `galaxy`, `gravity-wells`, `strange-attractor`), `define.ts` (type-checking helper).
- **`core/`:** authoring helpers: richer param specs and validation (`define.ts`, `params.ts`), presets (`presets.ts`), reusable WGSL blocks (`wgsl.ts`).
- **`preview/`:** standalone page with one sheet and sliders: `npm run dev`, open `/src/behaviors/preview/`. Its harness is a stand-in; the engine is the source of truth.
- **Used by:** `src/main.ts`, `src/sim/simulation.ts`, the perf bench and the shader verify cases.
- **Status:** live in the app.
