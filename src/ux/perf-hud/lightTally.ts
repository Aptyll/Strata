/**
 * Counts, on the GPU, what the compute rasterizer actually put on screen.
 *
 * The rasterizer (src/perf/atomicRasterPass.ts) keeps one u32 of light per
 * pixel: every particle that lands inside the frame adds its plane's light to
 * one pixel with atomicAdd. Summing that buffer therefore gives the number of
 * particles that landed in the frame, measured from what the GPU did and not
 * from what it was asked to do. This file does the sum in a small compute
 * pass of its own and reads back a few kilobytes.
 *
 * One invocation sums one strip of pixels into its own output slot (64-bit
 * sum, peak, lit pixel count), so there are no atomics and no shared writes.
 * The strips are added up on the CPU.
 */

/** Pixels summed by one invocation. */
export const TALLY_STRIP = 2048;
/** u32 words per strip in the output: sum low, sum high, peak, lit pixels. */
const STRIP_WORDS = 4;
const WORKGROUP = 64;

export const LIGHT_TALLY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> light: array<u32>;
@group(0) @binding(1) var<storage, read_write> strips: array<vec4u>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  let pixels = arrayLength(&light);
  if (strip >= arrayLength(&strips)) { return; }
  let start = strip * ${TALLY_STRIP}u;
  if (start >= pixels) { return; }
  let end = min(start + ${TALLY_STRIP}u, pixels);
  var lo = 0u;
  var hi = 0u;
  var peak = 0u;
  var lit = 0u;
  for (var i = start; i < end; i++) {
    let v = light[i];
    let next = lo + v;
    hi += u32(next < lo); // carry into the high word
    lo = next;
    peak = max(peak, v);
    lit += u32(v != 0u);
  }
  strips[strip] = vec4u(lo, hi, peak, lit);
}
`;

export interface LightTally {
  /** Sum of the light buffer in its own units (one full-brightness hit adds LIGHT_ONE). Exact below 2^53. */
  light: number;
  /** Largest value on a single pixel, same units. */
  peak: number;
  /** Pixels holding any light at all. */
  lit: number;
  /** Pixels in the buffer. */
  pixels: number;
}

/** Adds up the per-strip results. Exported so the verify case can check it against a plain loop. */
export function sumStrips(words: Uint32Array, pixels: number): LightTally {
  let light = 0;
  let peak = 0;
  let lit = 0;
  for (let i = 0; i + STRIP_WORDS <= words.length; i += STRIP_WORDS) {
    light += words[i] + words[i + 1] * 4294967296;
    if (words[i + 2] > peak) peak = words[i + 2];
    lit += words[i + 3];
  }
  return { light, peak, lit, pixels };
}

export class LightTallier {
  private pipeline: GPUComputePipeline | null = null;
  private strips: GPUBuffer | null = null;
  private read: GPUBuffer | null = null;
  private bound: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private flying = false;

  constructor(private readonly device: GPUDevice) {}

  /** True while a tally is on its way back from the GPU. */
  get busy(): boolean {
    return this.flying;
  }

  /**
   * Sums `light` (one u32 per pixel) in a submit of its own and calls `done`
   * with the result a few frames later. Call it right after the frame that
   * filled the buffer was submitted, before the next frame clears it.
   * Returns false, and does nothing, while the previous tally is in flight.
   */
  request(light: GPUBuffer, done: (tally: LightTally) => void): boolean {
    if (this.flying) return false;
    const { device } = this;
    const pixels = Math.floor(light.size / 4);
    const stripCount = Math.ceil(pixels / TALLY_STRIP);
    if (stripCount === 0) return false;
    const bytes = stripCount * STRIP_WORDS * 4;

    this.pipeline ??= device.createComputePipeline({
      label: "perf-hud light tally",
      layout: "auto",
      compute: { module: device.createShaderModule({ label: "perf-hud light tally", code: LIGHT_TALLY_WGSL }), entryPoint: "main" },
    });
    if (!this.strips || this.strips.size !== bytes) {
      this.strips?.destroy();
      this.read?.destroy();
      this.strips = device.createBuffer({
        label: "perf-hud light tally strips",
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.read = device.createBuffer({
        label: "perf-hud light tally readback",
        size: bytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.bound = null;
    }
    if (this.bound !== light) {
      // The rasterizer makes a new light buffer whenever the drawing buffer is resized.
      this.bound = light;
      this.bindGroup = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: light } },
          { binding: 1, resource: { buffer: this.strips } },
        ],
      });
    }

    const read = this.read!;
    const encoder = device.createCommandEncoder({ label: "perf-hud light tally" });
    const pass = encoder.beginComputePass({ label: "perf-hud light tally" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup!);
    pass.dispatchWorkgroups(Math.ceil(stripCount / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(this.strips, 0, read, 0, bytes);
    device.queue.submit([encoder.finish()]);

    this.flying = true;
    read.mapAsync(GPUMapMode.READ).then(
      () => {
        const tally = sumStrips(new Uint32Array(read.getMappedRange()), pixels);
        read.unmap();
        this.flying = false;
        done(tally);
      },
      () => {
        // The device was lost, or a resize replaced the buffers before this came back.
        this.flying = false;
      },
    );
    return true;
  }

  dispose(): void {
    this.strips?.destroy();
    this.read?.destroy();
    this.strips = this.read = this.bound = null;
    this.bindGroup = null;
  }
}
