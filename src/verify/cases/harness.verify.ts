/** Self-tests: the harness must catch what it claims to catch. */

import { expectClose, expectEqual, expectUniform01 } from "../compare";
import { captureValidationError, compile, expectNoGpuError, output, readBuffer, runCompute } from "../gpu";
import { WEBGPU_DEFAULT_LIMITS } from "../limits";
import { VerifyError, type VerifyCase } from "../types";

async function expectThrows(fn: () => unknown, pattern: RegExp, what: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!pattern.test(message)) throw new VerifyError(`${what}: threw, but the message does not match ${pattern}: ${message}`);
    return;
  }
  throw new VerifyError(`${what}: expected an error, got none`);
}

const cases: VerifyCase[] = [
  {
    name: "device raises the buffer size limits to the adapter's",
    run(t) {
      const { maxBufferSize, maxStorageBufferBindingSize } = t.device.limits;
      if (maxBufferSize !== t.adapter.limits.maxBufferSize || maxStorageBufferBindingSize !== t.adapter.limits.maxStorageBufferBindingSize) {
        throw new VerifyError("device limits are below the adapter's");
      }
      const perPlane = Math.floor(Math.min(maxBufferSize, maxStorageBufferBindingSize) / 16);
      const byDefault = Math.floor(WEBGPU_DEFAULT_LIMITS.maxStorageBufferBindingSize / 16);
      t.note(`one 16 byte particle buffer holds up to ${perPlane.toLocaleString("en-US")} particles here (${byDefault.toLocaleString("en-US")} with default limits)`);
    },
  },
  {
    name: "compile reports WGSL errors with a line number",
    async run(t) {
      const broken = "@compute @workgroup_size(1)\nfn main() {\n  let x: u32 = 1.5;\n}\n";
      await expectThrows(() => compile(t.device, broken, "broken"), /broken does not compile[\s\S]*at 3:/, "compile");
    },
  },
  {
    name: "expectNoGpuError turns a validation error into a failure",
    async run(t) {
      // MAP_READ may only be combined with COPY_DST.
      const bad = (): GPUBuffer => t.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE });
      await expectThrows(() => expectNoGpuError(t.device, bad), /GPUValidationError/, "expectNoGpuError");
      const message = await captureValidationError(t.device, bad);
      if (!message) throw new VerifyError("captureValidationError returned null for an invalid call");
    },
  },
  {
    name: "readBuffer returns what was written",
    async run(t) {
      const data = new Uint32Array([1, 2, 3, 0xdeadbeef, 5, 6, 7]);
      const buffer = t.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      t.device.queue.writeBuffer(buffer, 0, data);
      expectEqual(new Uint32Array(await readBuffer(t.device, buffer)), data, "whole buffer");
      expectEqual(new Uint32Array(await readBuffer(t.device, buffer, 8, 12)), data.subarray(2, 5), "range");
      buffer.destroy();
    },
  },
  {
    name: "runCompute runs a shader and reads the result back",
    async run(t) {
      const input = new Float32Array(1000).map((_, i) => i * 0.25);
      const outputs = await runCompute(t.device, {
        code: /* wgsl */ `
          @group(0) @binding(0) var<uniform> scale: f32;
          @group(0) @binding(1) var<storage, read_write> data: array<f32>;
          @compute @workgroup_size(64)
          fn main(@builtin(global_invocation_id) gid: vec3u) {
            if (gid.x >= arrayLength(&data)) { return; }
            data[gid.x] = data[gid.x] * scale;
          }`,
        bindings: [
          { binding: 0, access: "uniform", data: new Float32Array([3]) },
          { binding: 1, access: "read_write", data: input },
        ],
        dispatch: [Math.ceil(input.length / 64)],
        steps: 2,
      });
      expectClose(new Float32Array(output(outputs, 1)), input.map((v) => v * 9), { what: "data" });
    },
  },
  {
    name: "runCompute fails on a shader that does not validate",
    async run(t) {
      await expectThrows(
        () =>
          runCompute(t.device, {
            // 17 * 16 = 272 invocations, above maxComputeInvocationsPerWorkgroup.
            code: "@compute @workgroup_size(17, 16) fn main() {}",
            bindings: [],
            dispatch: [1],
          }),
        /./,
        "oversized workgroup",
      );
    },
  },
  {
    name: "comparison helpers reject bad data",
    async run() {
      await expectThrows(() => expectClose([1, 2, 3], [1, 2.1, 3]), /1 of 3 differ/, "expectClose");
      await expectThrows(() => expectClose([1, NaN], [1, 2]), /differ/, "expectClose with NaN");
      await expectThrows(() => expectEqual([1, 2], [1, 3]), /1 of 2 differ/, "expectEqual");
      const ramp = Array.from({ length: 4096 }, (_, i) => i / 4096);
      await expectThrows(() => expectUniform01(ramp), /correlated/, "expectUniform01 on a ramp");
      await expectThrows(() => expectUniform01([...ramp.slice(1), 1]), /not inside \[0, 1\)/, "expectUniform01 with 1.0");
    },
  },
];

export default cases;
