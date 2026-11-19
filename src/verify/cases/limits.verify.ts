/** planDispatch covers every item exactly once, on the CPU and on the GPU. */

import { expectEqual } from "../compare";
import { output, runCompute } from "../gpu";
import { checkLimits, DISPATCH_INDEX_WGSL, maxParticlesPerBinding, planDispatch, WEBGPU_DEFAULT_LIMITS } from "../limits";
import { VerifyError, type VerifyCase } from "../types";

const cases: VerifyCase[] = [
  {
    name: "planDispatch is tight and within limits for counts up to 4 billion",
    run() {
      const counts = [0, 1, 63, 64, 65, 4_194_240, 4_194_241, 16_777_216, 100_000_000, 268_435_456, 1_000_000_000, 4_294_967_295];
      for (const count of counts) {
        for (const wg of [64, 128, 256]) {
          const plan = planDispatch(count, wg);
          const where = `planDispatch(${count}, ${wg})`;
          if (plan.x > 65535 || plan.y > 65535) throw new VerifyError(`${where}: ${plan.x} x ${plan.y} exceeds 65535`);
          if (plan.invocations < count) throw new VerifyError(`${where}: covers only ${plan.invocations}`);
          if (plan.invocations - count >= (plan.y + 1) * wg) throw new VerifyError(`${where}: wastes ${plan.invocations - count} invocations`);
          if (count > 0 && plan.rowStride !== plan.x * wg) throw new VerifyError(`${where}: rowStride ${plan.rowStride}`);
          // The largest index the shader computes must fit in a u32.
          if (plan.invocations - 1 > 0xffff_ffff + plan.y * wg) throw new VerifyError(`${where}: index overflow`);
        }
      }
      const one = planDispatch(4_194_240, 64);
      if (one.y !== 1) throw new VerifyError("4,194,240 particles at workgroup_size(64) should still be a 1D dispatch");
      const two = planDispatch(4_194_241, 64);
      if (two.y !== 2) throw new VerifyError("4,194,241 particles at workgroup_size(64) need a 2D dispatch");
    },
  },
  {
    name: "checkLimits flags a 16.7M particle plane against default limits",
    run() {
      const bytes = 16_777_216 * 16;
      const problems = checkLimits(
        { bufferBytes: [bytes], storageBindingBytes: [bytes], dispatches: [[Math.ceil(16_777_216 / 64)]], workgroupSizes: [[64]] },
        WEBGPU_DEFAULT_LIMITS,
      );
      const hit = problems.map((p) => p.limit).sort().join(",");
      if (hit !== "maxComputeWorkgroupsPerDimension,maxStorageBufferBindingSize") throw new VerifyError(`flagged: ${hit}`);
      if (maxParticlesPerBinding(WEBGPU_DEFAULT_LIMITS) !== 8_388_608) throw new VerifyError("default per-binding capacity should be 8,388,608");
    },
  },
  {
    name: "a 2D dispatch plan touches every item once and nothing else (GPU)",
    async run(t) {
      // A tiny per-dimension limit forces the 2D path without a huge buffer.
      const workgroupSize = 64;
      for (const [count, maxPerDim] of [[5000, 9], [500, 3], [64, 1], [100_003, 40]] as const) {
        const plan = planDispatch(count, workgroupSize, maxPerDim);
        if (plan.x > maxPerDim || plan.y > maxPerDim) throw new VerifyError(`plan ${plan.x} x ${plan.y} exceeds ${maxPerDim}`);
        const guard = 256;
        const outputs = await runCompute(t.device, {
          label: `dispatch ${count}`,
          code: /* wgsl */ `
            ${DISPATCH_INDEX_WGSL}
            struct Params { count: u32, rowStride: u32 }
            @group(0) @binding(0) var<uniform> params: Params;
            @group(0) @binding(1) var<storage, read_write> hits: array<atomic<u32>>;
            @compute @workgroup_size(${workgroupSize})
            fn main(@builtin(global_invocation_id) gid: vec3u) {
              let i = dispatchIndex(gid, params.rowStride);
              if (i >= params.count) { return; }
              atomicAdd(&hits[i], 1u);
            }`,
          bindings: [
            { binding: 0, access: "uniform", data: new Uint32Array([count, plan.rowStride]) },
            { binding: 1, access: "read_write", data: (count + guard) * 4 },
          ],
          dispatch: [plan.x, plan.y],
        });
        const expected = new Uint32Array(count + guard).fill(1, 0, count);
        expectEqual(new Uint32Array(output(outputs, 1)), expected, `hits for count ${count}`);
      }
    },
  },
];

export default cases;
