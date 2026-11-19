/**
 * Verify cases for src/ux/perf-hud: `npm run verify -- perf-hud`.
 *
 * - The light tally shader matches a plain CPU sum, including a carry into
 *   the high word, a ragged last strip, the peak and the lit pixel count.
 * - The pass timer's encoder proxy begins real compute and render passes with
 *   timestamp writes, without a GPU validation error, and tags every reading
 *   with the graph pass that began it. Needs `timestamp-query` (the software
 *   adapter has it). The milliseconds themselves mean nothing on a software GPU.
 */
import type { FrameContext, Pass } from "../../core/contracts";
import { expectEqual } from "../../verify/compare";
import { expectNoGpuError, readBuffer } from "../../verify/gpu";
import { shaderCase } from "../../verify/shader-case";
import { VerifyError, type VerifyCase } from "../../verify/types";
import { LIGHT_TALLY_WGSL, LightTallier, TALLY_STRIP, sumStrips, type LightTally } from "./lightTally";
import { PassTimer, collectPassTimes, type GpuFrameTime } from "./passTimer";

const NOOP_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(1) fn main() { data[0] = data[0] + 1u; }
`;

function cpuTally(light: Uint32Array): LightTally {
  let sum = 0;
  let peak = 0;
  let lit = 0;
  for (const v of light) {
    sum += v;
    if (v > peak) peak = v;
    if (v !== 0) lit++;
  }
  return { light: sum, peak, lit, pixels: light.length };
}

function expectNames(time: GpuFrameTime, names: string): void {
  const got = time.passes.map((p) => p.name).join(" ");
  if (got !== names) throw new VerifyError(`timed passes are "${got}", expected "${names}"`);
}

const cases: VerifyCase[] = [
  shaderCase("light tally shader compiles and lints", LIGHT_TALLY_WGSL),
  {
    name: "light tally matches a CPU sum (carry, ragged last strip, peak, lit pixels)",
    async run(t) {
      const { device } = t;
      // Two and a bit strips, so the last one is ragged.
      const pixels = TALLY_STRIP * 2 + 37;
      const light = new Uint32Array(pixels);
      for (let i = 0; i < pixels; i++) light[i] = i % 3 === 0 ? 0 : (i * 2654435761) >>> 20;
      // Three near-maximal values in the first strip force a carry into the high word.
      light[1] = light[2] = light[4] = 0xffff_fff0;
      const expected = cpuTally(light);
      if (expected.light <= 2 ** 32) throw new VerifyError("test data does not overflow 32 bits");

      const buffer = device.createBuffer({ size: light.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, light);
      const tallier = new LightTallier(device);
      const got = await expectNoGpuError(device, () => new Promise<LightTally>((done) => tallier.request(buffer, done)));
      expectEqual([got.light, got.peak, got.lit, got.pixels], [expected.light, expected.peak, expected.lit, expected.pixels]);

      // A second tally reuses the buffers; a busy tallier refuses instead of queueing.
      device.queue.writeBuffer(buffer, 0, new Uint32Array(pixels).fill(256));
      const again = new Promise<LightTally>((done) => {
        if (!tallier.request(buffer, done)) throw new VerifyError("an idle tallier refused a request");
      });
      if (tallier.request(buffer, () => {})) throw new VerifyError("a busy tallier accepted a second request");
      const second = await again;
      expectEqual([second.light, second.peak, second.lit], [256 * pixels, 256, pixels]);
      tallier.dispose();
      buffer.destroy();
    },
  },
  {
    name: "sumStrips adds the high word",
    run() {
      const tally = sumStrips(new Uint32Array([5, 2, 9, 1, 7, 0, 3, 4]), 10);
      expectEqual([tally.light, tally.peak, tally.lit, tally.pixels], [5 + 2 * 2 ** 32 + 7, 9, 5, 10]);
    },
  },
  {
    name: "collectPassTimes groups GPU passes by graph pass and drops bad readings",
    run() {
      const a = { name: "a", stage: "simulate" as const };
      const b = { name: "b", stage: "rasterize" as const };
      // a: 2 ms, a: 1 ms, b: never written, b: backwards, b: 0.5 ms.
      const stamps = new BigUint64Array([1_000_000n, 3_000_000n, 3_000_000n, 4_000_000n, 0n, 0n, 9_000_000n, 8_000_000n, 5_000_000n, 5_500_000n]);
      const time = collectPassTimes(stamps, [a, a, b, b, b], false);
      if (!time) throw new VerifyError("no result");
      expectNames(time, "a b");
      expectEqual(time.passes.map((p) => p.gpuPasses), [2, 1]);
      expectEqual([time.passes[0].ms, time.passes[1].ms, time.totalMs, time.spanMs], [3, 0.5, 3.5, 4.5]);
      if (collectPassTimes(new BigUint64Array(4), [a, b], false) !== null) throw new VerifyError("unwritten queries gave a result");
    },
  },
  {
    name: "pass timer times real compute and render passes through its encoder proxy",
    async run(t) {
      if (!t.adapter.features.has("timestamp-query")) t.skip("this adapter has no timestamp-query");
      // The harness device does not enable the feature, so make one that does.
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter?.features.has("timestamp-query")) t.skip("no second adapter with timestamp-query");
      const device = await adapter!.requestDevice({ requiredFeatures: ["timestamp-query"] });
      try {
        const timer = new PassTimer(device);
        if (!timer.supported) throw new VerifyError("timer reports unsupported on a device with timestamp-query");

        const data = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module: device.createShaderModule({ code: NOOP_WGSL }), entryPoint: "main" },
        });
        const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: data } }] });
        const target = device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
        const view = target.createView();

        const compute = (encoder: GPUCommandEncoder, descriptor?: GPUComputePassDescriptor) => {
          const pass = encoder.beginComputePass(descriptor);
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(1);
          pass.end();
        };
        const sim: Pass = { name: "simulate", stage: "simulate", execute: (f) => { compute(f.encoder); compute(f.encoder, { label: "second" }); } };
        const draw: Pass = {
          name: "draw",
          stage: "rasterize",
          execute: (f) => {
            f.encoder.clearBuffer(data, 8, 4); // a non-pass command must reach the real encoder too
            f.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }] }).end();
          },
        };
        const idle: Pass = { name: "idle", stage: "capture", execute: () => {} };

        /** One frame, driven the way FrameGraph.run drives its observers. */
        const frame = async (): Promise<GpuFrameTime | null> => {
          const encoder = device.createCommandEncoder();
          const ctx = { encoder } as unknown as FrameContext; // the timer only touches the encoder
          let result: GpuFrameTime | null = null;
          timer.onResult = (r) => (result = r);
          for (const pass of [sim, draw, idle]) pass.execute(timer.beforePass(pass, ctx));
          timer.beforeSubmit();
          device.queue.submit([encoder.finish()]);
          timer.afterSubmit();
          await device.queue.onSubmittedWorkDone();
          // The readback resolves on a later task than the work-done promise.
          for (let i = 0; i < 20 && !result && timer.enabled; i++) await new Promise((r) => setTimeout(r, 5));
          return result;
        };

        // Off: frames are untouched and nothing is measured.
        const untouched = { encoder: device.createCommandEncoder() } as unknown as FrameContext;
        if (timer.beforePass(sim, untouched) !== untouched) throw new VerifyError("a disabled timer replaced the frame context");
        if ((await expectNoGpuError(device, frame)) !== null) throw new VerifyError("a disabled timer produced a result");

        timer.enabled = true;
        for (let n = 0; n < 3; n++) {
          const time = await expectNoGpuError(device, frame);
          if (!time) throw new VerifyError(`frame ${n}: no timing result`);
          expectNames(time, "simulate draw");
          expectEqual(time.passes.map((p) => p.gpuPasses), [2, 1]);
          if (!(time.totalMs >= 0 && Number.isFinite(time.totalMs) && time.spanMs >= 0)) throw new VerifyError(`bad time ${time.totalMs}`);
          if (time.truncated) throw new VerifyError("three passes reported as truncated");
        }
        if (timer.stopped) throw new VerifyError("timing switched itself off");

        // The passes really ran: one frame with the timer off and three with it on, two dispatches each.
        const counter = new Uint32Array(await readBuffer(device, data, 0, 4))[0];
        expectEqual([counter], [8]);
        t.note("timestamps resolve and read back; the milliseconds mean nothing on a software GPU");
        timer.dispose();
        data.destroy();
        target.destroy();
      } finally {
        device.destroy();
      }
    },
  },
];

export default cases;
