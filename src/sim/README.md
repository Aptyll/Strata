# src/sim

The main engine's per-plane simulation. `Simulation` owns each plane's particle buffer and uniform, compiles one compute pipeline per behavior with `buildSimShader`, and steps every active plane each frame. It also implements the add, remove and change-behavior operations that the world streamer and the dice roll call through `PlaneHost`.

- **Key file:** `simulation.ts` (`Simulation`).
- **Depends on:** `src/core/contracts.ts`, `src/gpu/shaderLib.ts`, `src/behaviors`.
- **Used by:** `src/main.ts`.
- **Status:** live in the app.
