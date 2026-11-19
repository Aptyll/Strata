# src/behaviors

The motion rules that run on each plane. A behavior is a WGSL `update` snippet plus named params (the `Behavior` type in `src/core/contracts.ts`), compiled into the engine's compute shader by `src/gpu/shaderLib.ts`. See `docs/behaviors.md` and `docs/behavior-library.md`.

- **Key files:** `index.ts` (`behaviors`, `getBehavior`; every `*.behavior.ts` file here registers itself, so adding one touches no shared file), the behaviors (`flow`, `curl-flow`, `galaxy`, `gravity-wells`, `strange-attractor`). Every behavior file wraps its object in `defineBehavior` from `core/`, which type-checks it and throws at load when it breaks the contract.
- **`core/`:** authoring helpers: `defineBehavior` and `validateBehavior` (`define.ts`), richer param specs and pure param tools (`params.ts`), presets (`presets.ts`), reusable WGSL blocks (`wgsl.ts`). The app does not call the param and preset tools today: the dice (`src/ux/behavior-ui/roll.ts`) and the Esc menu sliders (`src/ux/hud/wire.ts`) have their own.
- **`preview/`:** standalone page with one sheet and sliders: `npm run dev`, open `/src/behaviors/preview/`. It runs the engine's own compute shader (`buildSimShader`) and uniform layouts, so a behavior moves there exactly as in the app.
- **Used by:** `src/main.ts`, `src/sim/simulation.ts`, the perf bench and the shader verify cases.
- **Status:** live in the app.
