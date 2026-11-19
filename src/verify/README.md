# verify

Fast, optional checks that a shader is correct: compile it with the real WGSL
compiler, run it, and compare the GPU result with a CPU reference. The whole
suite runs in about a second.

```
npm run verify                 # headless Chromium, software GPU
npm run verify -- behaviors    # only cases whose file or name contains "behaviors"
npm run verify -- --hardware   # real GPU, opens a window
npm run dev                    # then open /src/verify/ in any WebGPU browser
```

The headless run uses a software GPU. It proves a shader compiles, validates
and computes the right numbers. It says nothing about speed, and a data race
that shows there may hide on a real GPU or the other way round.

## Add a case

Put a `*.verify.ts` file next to your code. It is picked up by name.

```ts
import type { VerifyCase } from "../verify/types";
import { runCompute, output } from "../verify/gpu";
import { expectClose } from "../verify/compare";
import { shaderCase } from "../verify/shader-case";

const cases: VerifyCase[] = [
  // Compiles and passes the lint rules.
  shaderCase("my pass compiles", () => buildMyShader()),
  // Matches a CPU reference.
  {
    name: "my pass matches the CPU",
    async run(t) {
      const out = await runCompute(t.device, { code, bindings, dispatch: [n] });
      expectClose(new Float32Array(output(out, 1)), cpuReference(input));
    },
  },
];
export default cases;
```

Any `.wgsl` file under `src/` is linted automatically, and compiled if it has
an entry point. Start a file with `// verify: fragment` if it only compiles
after being joined with other source.

## What is here

| file | purpose |
| --- | --- |
| `gpu.ts` | `compile`, `runCompute`, `readBuffer`, `expectNoGpuError` |
| `compare.ts` | `expectClose`, `expectEqual`, `expectFinite`, `expectInRange`, `expectUniform01` |
| `limits.ts` | `planDispatch`, `particleScaleLimits`, `checkLimits` (usable from app code) |
| `lint.ts` | `lintWgsl`: static rules for mistakes that still compile |
| `reference.ts` | CPU twins of small WGSL blocks: the shared `pcg` and `u01` from `src/gpu/wgsl.ts`, sheet wrap |
| `cases/` | self-tests and worked examples |

Lint rules: `workgroup-size`, `rand-reaches-one`, `index-to-f32`,
`unguarded-dispatch`, `nonatomic-accumulate`, `vec3-array-stride`. Silence one
that was checked by hand with `// verify-ok: <rule>` on the same or previous line.
The reasons behind them are in `docs/gpu-scale.md`.
