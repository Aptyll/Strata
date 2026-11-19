# src/gpu

The engine's low-level WebGPU layer: device setup and the byte layouts shared between CPU and WGSL.

- **Key files:** `context.ts` (`initGpu`, `writeGlobals`, `HDR_FORMAT`), `shaderLib.ts` (particle, globals and plane uniform layouts with offsets, their WGSL declarations, and `buildSimShader`, which wraps a behavior snippet into a compute shader), `wgsl.ts` (small shared WGSL blocks: PCG hash, `u01`, fullscreen triangle), `shaders.verify.ts` (compile check for every behavior, run by `npm run verify`).
- **Depends on:** `src/core/contracts.ts`.
- **Used by:** `src/main.ts`, `src/sim`, `src/passes`, `src/perf`.
- **Status:** live in the app.
