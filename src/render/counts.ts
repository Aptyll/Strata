// Tone mapping for integer hit counters, for renders where a pixel is hit
// tens of thousands to billions of times (the trillion particle render
// averages about 120,000 hits per pixel at 4K).
//
// The accumulator is a plain GPUBuffer of unsigned integers, one counter per
// pixel, as produced by an atomicAdd kernel or uploaded from the CPU:
//
//   words = 1   array<u32>, counter i at word i
//   words = 2   64 bit, low word first: counter i at words 2i (lo), 2i+1 (hi)
//
// Pixels are row major, top row first: i = y * stride + x.
//
// CountToneMapper turns that buffer into a picture in two steps.
//
//   1. resolve: counters -> r32float density (count / scale), no clamp.
//      A float has 24 bits of mantissa, so counts above 16.7 million are
//      rounded to 1 part in 16 million. Under a log curve that is far below
//      one display step.
//   2. DensityPost: trails, bloom, log tone map, as for every other render.
//
// At these counts a fixed white point is useless: the mean pixel alone would
// be 120,000 times over a white point tuned for single particles. So the
// class also measures the image. `measure()` builds a histogram of
// log2(count) on the GPU and reads back 1 KiB; `autoExpose()` places the
// black and white points at percentiles of it.

import { FULLSCREEN_VS } from './common';
import { DensityPost, type DensityPostOptions } from './post';

const BINS = 256;
/** Histogram bins per doubling of the count. 256 bins cover 2^0 to 2^63.75. */
const BINS_PER_OCTAVE = 4;
const WORKGROUP = 256;
const ROW_GROUPS = 16384;

const loadWgsl = (words: 1 | 2): string => /* wgsl */ `
struct Layout {
  width: u32,
  height: u32,
  stride: u32,     // counters per row in the buffer
  offset: u32,     // index of the first counter
  invScale: f32,   // 1 / (counts per unit of energy)
};
@group(0) @binding(0) var<uniform> lay: Layout;
@group(0) @binding(1) var<storage, read> counters: array<u32>;

fn loadCount(x: u32, y: u32) -> f32 {
  let i = lay.offset + y * lay.stride + x;
  ${words === 2
    ? 'return f32(counters[2u * i]) + f32(counters[2u * i + 1u]) * 4294967296.0;'
    : 'return f32(counters[i]);'}
}
`;

const resolveWgsl = (words: 1 | 2): string => FULLSCREEN_VS + loadWgsl(words) + /* wgsl */ `
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let c = vec2u(i.pos.xy);
  return vec4f(loadCount(c.x, c.y) * lay.invScale, 0.0, 0.0, 1.0);
}
`;

const histogramWgsl = (words: 1 | 2): string => loadWgsl(words) + /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> hist: array<atomic<u32>, ${BINS}>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let p = gid.x + gid.y * ${ROW_GROUPS * WORKGROUP}u;
  if (p >= lay.width * lay.height) { return; }
  let v = loadCount(p % lay.width, p / lay.width);
  // Bin 0 is "never hit". Bin b >= 1 holds counts in [2^((b-1)/4), 2^(b/4)).
  var bin = 0u;
  if (v >= 1.0) { bin = 1u + min(u32(log2(v) * ${BINS_PER_OCTAVE}.0), ${BINS - 2}u); }
  atomicAdd(&hist[bin], 1u);
}
`;

/** Distribution of per pixel hit counts, in raw counter units. */
export interface CountHistogram {
  /** Pixels per bin. Bin 0 is never hit; bin b covers [2^((b-1)/4), 2^(b/4)). */
  bins: Uint32Array;
  /** All pixels measured. */
  pixels: number;
  /** Pixels hit at least once. */
  lit: number;
}

/**
 * Count at percentile `p` (0..1) of the pixels that were hit at least once,
 * in raw counter units. Empty pixels are left out on purpose: the picture is
 * mostly black void, and counting it would drag every percentile to zero.
 */
export function histogramPercentile(h: CountHistogram, p: number): number {
  if (!h.lit) return 0;
  const want = Math.min(Math.max(p, 0), 1) * h.lit;
  let seen = 0;
  for (let b = 1; b < h.bins.length; b++) {
    const n = h.bins[b];
    if (!n) continue;
    if (seen + n >= want) {
      // Interpolate inside the bin, in log space.
      const t = Math.min(Math.max((want - seen) / n, 0), 1);
      return 2 ** ((b - 1 + t) / BINS_PER_OCTAVE);
    }
    seen += n;
  }
  return 2 ** ((h.bins.length - 1) / BINS_PER_OCTAVE);
}

export interface AutoExposeOptions {
  /** Percentile of lit pixels that sits at the toe of the curve. Default 0.05. */
  low?: number;
  /** Percentile of lit pixels that reaches full white. Default 0.999. */
  high?: number;
  /** Multiplies the white point, leaving room above `high`. Default 1.5. */
  headroom?: number;
  /** Smallest white / black ratio. Keeps a flat image from turning into pure contrast. Default 64. */
  minRange?: number;
  /**
   * 0..1, how far to move from the current values toward the measured ones,
   * in log space. 1 jumps. Use something like 0.1 per frame in a video so
   * exposure follows the scene without flicker.
   */
  blend?: number;
}

/**
 * Black and white point for the log curve from a measured histogram, as
 * `exposure` and `white` for ToneSettings, given `scale` counts per unit of
 * density. With the log curve, luma = log(1 + count/black) / log(1 + white/black):
 * counts below `black` fall into the toe, and each doubling above it adds the
 * same brightness step up to `white`.
 */
export function exposureFromHistogram(
  h: CountHistogram,
  scale = 1,
  o: AutoExposeOptions = {},
): { exposure: number; white: number; black: number; whiteCount: number } | null {
  if (!h.lit) return null;
  const black = Math.max(histogramPercentile(h, o.low ?? 0.05), 1);
  const peak = histogramPercentile(h, o.high ?? 0.999) * (o.headroom ?? 1.5);
  const whiteCount = Math.max(peak, black * (o.minRange ?? 64));
  return { exposure: scale / black, white: whiteCount / black, black, whiteCount };
}

export interface CountToneMapperOptions extends DensityPostOptions {
  /** 1 for u32 counters, 2 for 64 bit counters stored low word first. Default 1. */
  words?: 1 | 2;
  /**
   * Counter units per unit of density: the fixed point scale of the kernel,
   * or 1 when every hit adds 1. Default 1.
   */
  scale?: number;
}

export class CountToneMapper {
  readonly device: GPUDevice;
  readonly words: 1 | 2;
  /** Counter units per unit of density. May be changed between frames. */
  scale: number;
  /** Trails, bloom and tone settings live here: `post.settings`. */
  readonly post: DensityPost;
  width = 0;
  height = 0;
  /** Counters per buffer row. Defaults to the width. */
  stride = 0;
  /** Index of the first counter in the buffer. */
  offset = 0;
  private _layout: GPUBuffer;
  private _resolve: GPURenderPipeline;
  private _histogram: GPUComputePipeline | null = null;
  private _hist: GPUBuffer | null = null;
  private _density: GPUTexture | null = null;
  private _densityView: GPUTextureView | null = null;

  constructor(device: GPUDevice, opts: CountToneMapperOptions) {
    this.device = device;
    this.words = opts.words ?? 1;
    this.scale = opts.scale ?? 1;
    this.post = new DensityPost(device, opts);
    // Counts this large need range before they need trails; a caller that
    // wants them turns them back on.
    this.post.settings.trails.enabled = false;
    this.post.settings.tone.curve = 'log';
    this._layout = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: resolveWgsl(this.words) });
    this._resolve = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
    });
  }

  /** Bytes the counter buffer must hold for the current size. */
  get byteLength(): number {
    return (this.offset + (this.stride || this.width) * this.height) * this.words * 4;
  }

  /** The resolved density texture (r32float, count / scale), after `encode`. */
  get densityView(): GPUTextureView | null {
    return this._densityView;
  }

  /** Image size in pixels. `stride` is counters per buffer row, default `width`. */
  resize(width: number, height: number, stride = 0): void {
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    this.stride = stride;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this._density?.destroy();
    this._density = this.device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this._densityView = this._density.createView();
    this.post.resize(width, height);
  }

  private _writeLayout(): void {
    const b = new ArrayBuffer(32);
    const u = new Uint32Array(b);
    u[0] = this.width;
    u[1] = this.height;
    u[2] = this.stride || this.width;
    u[3] = this.offset;
    new Float32Array(b)[4] = 1 / this.scale;
    this.device.queue.writeBuffer(this._layout, 0, b);
  }

  /**
   * Counters to picture. `counters` needs STORAGE usage and at least
   * `byteLength` bytes. `dt` only matters when trails are enabled.
   */
  encode(encoder: GPUCommandEncoder, counters: GPUBuffer, target: GPUTextureView, dt = 1 / 60): void {
    if (!this._densityView) throw new Error('CountToneMapper: call resize() before encode()');
    this._writeLayout();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this._densityView, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    pass.setPipeline(this._resolve);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this._resolve.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._layout } },
        { binding: 1, resource: { buffer: counters } },
      ],
    }));
    pass.draw(3);
    pass.end();
    this.post.encode(encoder, this._densityView, target, dt);
  }

  /**
   * Histogram of the counters. Submits its own commands and resolves after a
   * 1 KiB readback, so everything submitted before the call is included.
   */
  async measure(counters: GPUBuffer): Promise<CountHistogram> {
    if (!this.width) throw new Error('CountToneMapper: call resize() before measure()');
    const device = this.device;
    if (!this._histogram) {
      const module = device.createShaderModule({ code: histogramWgsl(this.words) });
      this._histogram = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    this._hist ??= device.createBuffer({
      size: BINS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this._writeLayout();
    const staging = device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(this._hist);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this._histogram);
    pass.setBindGroup(0, device.createBindGroup({
      layout: this._histogram.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._layout } },
        { binding: 1, resource: { buffer: counters } },
        { binding: 2, resource: { buffer: this._hist } },
      ],
    }));
    const groups = Math.ceil((this.width * this.height) / WORKGROUP);
    pass.dispatchWorkgroups(Math.min(groups, ROW_GROUPS), Math.ceil(groups / ROW_GROUPS));
    pass.end();
    encoder.copyBufferToBuffer(this._hist, 0, staging, 0, BINS * 4);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bins = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const pixels = this.width * this.height;
    return { bins, pixels, lit: pixels - bins[0] };
  }

  /**
   * Set exposure and white point from a histogram. Returns what it chose, or
   * null when no pixel was hit (settings are left alone).
   */
  autoExpose(h: CountHistogram, o: AutoExposeOptions = {}): { exposure: number; white: number; black: number; whiteCount: number } | null {
    const e = exposureFromHistogram(h, this.scale, o);
    if (!e) return null;
    const tone = this.post.settings.tone;
    const k = Math.min(Math.max(o.blend ?? 1, 0), 1);
    const ease = (from: number, to: number): number => (from > 0 && k < 1 ? Math.exp(Math.log(from) * (1 - k) + Math.log(to) * k) : to);
    tone.exposure = ease(tone.exposure, e.exposure);
    tone.white = ease(tone.white, e.white);
    return e;
  }

  /** `measure` then `autoExpose`, for the common case. */
  async measureAndExpose(counters: GPUBuffer, o: AutoExposeOptions = {}): Promise<CountHistogram> {
    const h = await this.measure(counters);
    this.autoExpose(h, o);
    return h;
  }

  destroy(): void {
    this._density?.destroy();
    this._hist?.destroy();
    this._layout.destroy();
    this.post.destroy();
  }
}
