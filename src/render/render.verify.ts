/**
 * Verify cases for src/render: `npm run verify -- render`.
 *
 * Builds every render pipeline on a real device (so each shader compiles and
 * each layout validates), runs the chains once, and checks the integer counter
 * path with exact numbers: fixed point splatting and the counters -> density
 * resolve that SplatAccumulator and CountToneMapper share.
 */

import { expectClose, expectEqual } from "../verify/compare";
import { expectNoGpuError } from "../verify/gpu";
import { VerifyError, type VerifyCase } from "../verify/types";
import { CountToneMapper } from "./counts";
import { DensityPost } from "./post";
import { SplatAccumulator, type SplatMode } from "./splat";

const W = 8;
const H = 8;

/** Copies an r32float texture of W x H to the CPU. */
async function readR32(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const bytesPerRow = 256; // copyTextureToBuffer needs rows padded to 256 bytes
  const staging = device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, [W, H]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) out.set(padded.subarray((y * bytesPerRow) / 4, (y * bytesPerRow) / 4 + W), y * W);
  return out;
}

/** NDC of a point at pixel coordinates (x, y), where integers are pixel centres. */
const ndc = (x: number, y: number): [number, number] => [((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const cases: VerifyCase[] = [
  {
    name: "density post chain (trails, bloom, every curve and display) encodes cleanly",
    async run(t) {
      const device = t.device;
      await expectNoGpuError(device, async () => {
        const post = new DensityPost(device, { format: "rgba8unorm" });
        post.resize(64, 32);
        const density = device.createTexture({
          size: [64, 32],
          format: "r16float",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const target = device.createTexture({ size: [64, 32], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
        for (const [curve, display] of [["log", "soft"], ["power", "filmic"], ["linear", "clip"]] as const) {
          post.settings.tone.curve = curve;
          post.settings.tone.display = display;
          const encoder = device.createCommandEncoder();
          post.encode(encoder, density.createView(), target.createView(), 1 / 60);
          device.queue.submit([encoder.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
        post.destroy();
        density.destroy();
        target.destroy();
      });
    },
  },
  {
    name: "splat accumulator encodes in point, quad and compute mode",
    async run(t) {
      const device = t.device;
      await expectNoGpuError(device, async () => {
        const particles = new Float32Array([...ndc(1, 1), 0, 0, ...ndc(4.5, 2.25), 0, 0]);
        const buffer = device.createBuffer({
          size: particles.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, particles);
        // r16float blends on every device, so all three modes can share it.
        const splat = new SplatAccumulator(device, { format: "r16float" });
        splat.resize(W, H);
        for (const mode of ["point", "quad", "compute"] as SplatMode[]) {
          splat.mode = mode;
          const encoder = device.createCommandEncoder();
          splat.encode(encoder, [{ buffer, count: 2, mvp: IDENTITY, stride: 16, dims: 2 }], 0);
          device.queue.submit([encoder.finish()]);
        }
        await device.queue.onSubmittedWorkDone();
        splat.destroy();
        buffer.destroy();
      });
    },
  },
  {
    name: "compute splat deposits exact bilinear fixed point energy",
    async run(t) {
      const device = t.device;
      // One particle on a pixel centre, one between two columns, one a quarter
      // of the way between two rows. Every weight is a multiple of 1/256, so
      // stochastic rounding cannot change the result.
      const particles = new Float32Array([
        ...ndc(2, 5), 0, 0,
        ...ndc(5.5, 1), 0, 0,
        ...ndc(6, 3.25), 0, 0,
      ]);
      const buffer = device.createBuffer({ size: particles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, particles);
      const splat = new SplatAccumulator(device, { mode: "compute", format: "r32float", fixedScale: 256 });
      splat.resize(W, H);
      const encoder = device.createCommandEncoder();
      splat.encode(encoder, [{ buffer, count: 3, mvp: IDENTITY, stride: 16, dims: 2, energy: 2 }], 7);
      device.queue.submit([encoder.finish()]);
      const actual = await readR32(device, splat.texture!);
      const expected = new Float32Array(W * H);
      expected[5 * W + 2] = 2;
      expected[1 * W + 5] = 1;
      expected[1 * W + 6] = 1;
      expected[3 * W + 6] = 1.5;
      expected[4 * W + 6] = 0.5;
      expectEqual(actual, expected, "density after compute splat");
      splat.destroy();
      buffer.destroy();
    },
  },
  {
    name: "count tone mapper resolves u32 and u64 counters to count / scale",
    async run(t) {
      const device = t.device;
      const scale = 4;
      // Counts that fit both layouts, then one past 2^32 that only the 64 bit layout can hold.
      const shared = [0, 1, 3, 1000, 65536, 4_000_000_000];
      const big = 2 ** 32 + 5;
      for (const words of [1, 2] as const) {
        const counts = words === 2 ? [...shared, big] : shared;
        const data = new Uint32Array(W * H * words);
        counts.forEach((c, i) => {
          if (words === 1) data[i] = c;
          else {
            data[2 * i] = c % 2 ** 32;
            data[2 * i + 1] = Math.floor(c / 2 ** 32);
          }
        });
        const counters = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(counters, 0, data);
        const mapper = new CountToneMapper(device, { format: "rgba8unorm", words, scale });
        mapper.resize(W, H);
        const target = device.createTexture({ size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
        // The resolved density is private; copy it out to compare.
        const copy = device.createTexture({ size: [W, H], format: "r32float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
        await expectNoGpuError(device, async () => {
          const encoder = device.createCommandEncoder();
          mapper.encode(encoder, counters, target.createView());
          encoder.copyTextureToTexture({ texture: mapper["_density"]! }, { texture: copy }, [W, H]);
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
        });
        const actual = await readR32(device, copy);
        const expected = new Float32Array(W * H);
        counts.forEach((c, i) => (expected[i] = Math.fround(Math.fround(c) * Math.fround(1 / scale))));
        expectClose(actual, expected, { rel: 1e-6, what: `density from ${words === 1 ? "u32" : "u64"} counters` });

        const histogram = await mapper.measure(counters);
        const lit = counts.filter((c) => c > 0).length;
        if (histogram.lit !== lit) throw new VerifyError(`words ${words}: histogram has ${histogram.lit} lit pixels, expected ${lit}`);
        copy.destroy();
        target.destroy();
        mapper.destroy();
        counters.destroy();
      }
    },
  },
];

export default cases;
