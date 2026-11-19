// TrillionKernel: evaluate stateless particles in batches and count hits
// per pixel, exactly, with nothing stored per particle. See docs/trillion.md.

import { FOLD_WGSL, LAW_PRELUDE, SLOT_BYTES, WORKGROUP, splatWgsl } from './wgsl';

/** A stateless motion law: WGSL defining `fn <fn>(key: Key, t: f32, p: array<f32, 8>) -> vec2f` (Key = vec2u, src/stateless). */
export interface TrillionLaw {
  id: string;
  /** Name of the WGSL function. */
  fn: string;
  /** WGSL source. May call pcg, u01, tri, draw, strat and TAU. Must return a sheet-local position in [-1, 1]^2. */
  wgsl: string;
  /**
   * True when the law takes its two main coordinates from `strat(key)`, so
   * neighbouring ids land near each other. Such planes use the strata path:
   * a shared memory tile per workgroup, whatever the plane's size on screen.
   */
  coherent?: boolean;
}

export interface TrillionPlane {
  /** Law id. */
  law: string;
  /** Particles on this plane, at most 2^32 (the per-plane index is a u32). */
  count: number;
  /** u32. Different seeds give different particles. */
  seed: number;
  /** Up to 8 law params. */
  params?: ArrayLike<number>;
  /**
   * Sheet [-1, 1]^2 to pixels, 9 numbers row-major:
   * (px*w, py*w, w) = rows * (sx, sy, 1), pixel (0, 0) at the top left.
   * Use `planeHomography()` to build it from a model and a view-projection matrix.
   */
  homography: ArrayLike<number>;
  /** Smallest accepted w (the near plane). Default 1e-4. */
  near?: number;
  /** Probability 0..1 that a landed particle is counted (brightness). Default 1. */
  keep?: number;
  /**
   * Stratified grid of patches for coherent laws, [gu, gv]; gu * gv patches,
   * one workgroup each. Default: square, about 2^17 particles per patch.
   */
  strata?: [number, number];
}

/** Plane-local particle ids [start, start + count). */
export interface TrillionBatch {
  plane: TrillionPlane;
  start: number;
  count: number;
}

export interface TrillionKernelOptions {
  width: number;
  height: number;
  laws: readonly TrillionLaw[];
  /** Replace the helper WGSL (pcg, u01, tri, draw, TAU). */
  prelude?: string;
  /** Shared memory counters per workgroup. Default: what the device allows, at most 8192. */
  tileBins?: number;
}

/** Per frame settings, read at encode time. */
export interface TrillionFrameSettings {
  /** Seconds, passed to the law. */
  time: number;
  /** Exposure in seconds; each particle gets its own time inside it (motion blur). */
  shutter: number;
  /** Changes the sub-pixel and shutter jitter. Use the frame number. */
  salt: number;
  /** Stochastic bilinear sub-pixel splat (default) or plain point. */
  stochastic: boolean;
  /**
   * Skip planes that are entirely off screen (counted as culled). Off by
   * default: the record claim is that every particle is evaluated.
   */
  cull: boolean;
  /**
   * Bench modes. 'full' (default) renders. 'math' evaluates and projects
   * every particle but writes no counters (plain path). 'noTile' runs the
   * strata path with run merging but without the shared memory tile.
   */
  mode: 'full' | 'math' | 'noTile';
}

export interface TrillionTally {
  /** Particles whose position was computed, counted on the host at encode time. */
  evaluated: number;
  /** The same, counted on the GPU (one atomic per workgroup). Must equal `evaluated`. */
  evaluatedGpu: number;
  /** Particles skipped as whole batches because their plane is out of view (only with settings.cull). */
  culled: number;
  /** Evaluated particles that fell inside the frame. */
  inView: number;
  /** Particles counted: equals the sum of all pixel counters. */
  landed: number;
  /** Strata path only: workgroups (patches) run, and how many found a shared memory tile. Tells whether a law is coherent enough. */
  patches: number;
  tiledPatches: number;
}

export interface PixelRect { x: number; y: number; w: number; h: number }

const MAX_DISPATCH = 2 ** 31;
const U32_LIMIT = 2 ** 32;
const RING_SLOTS = 4096;

export class TrillionKernel {
  readonly device: GPUDevice;
  width = 0;
  height = 0;
  readonly tileBins: number;
  /** 32 bit hot counters, one per pixel. Folded into `counts`. */
  acc!: GPUBuffer;
  /** Exact 64 bit counters, CountToneMapper words = 2 layout (lo at 2i, hi at 2i + 1). Valid after `fold`. */
  counts!: GPUBuffer;
  /** Landed and in-view totals as 64 bit (lo, hi) pairs, strata patches run and tiled (u32), evaluated (64 bit). */
  readonly tallyBuffer: GPUBuffer;
  readonly settings: TrillionFrameSettings = { time: 0, shutter: 0, salt: 0, stochastic: true, cull: false, mode: 'full' };
  /** CPU side tally since the last `clear`. GPU side counts come from `readTally`. */
  evaluated = 0;
  culled = 0;

  private pipelines = new Map<string, { direct: GPUComputePipeline; tiled: GPUComputePipeline; strata: GPUComputePipeline; coherent: boolean }>();
  private layout: GPUBindGroupLayout;
  private ring: GPUBuffer;
  private slot = 0;
  private slotsSinceSubmit = 0;
  private bind!: GPUBindGroup;
  private foldPipeline: GPUComputePipeline;
  private foldUniform: GPUBuffer;
  private foldBind!: GPUBindGroup;
  private unfolded = 0;
  private scratch = new ArrayBuffer(SLOT_BYTES);

  static async create(device: GPUDevice, opts: TrillionKernelOptions): Promise<TrillionKernel> {
    const k = new TrillionKernel(device, opts);
    await k.compile(opts.laws, opts.prelude ?? LAW_PRELUDE);
    return k;
  }

  private constructor(device: GPUDevice, opts: TrillionKernelOptions) {
    this.device = device;
    // Each other workgroup variable takes 16 bytes after padding; keep 128 bytes for them.
    const maxBins = Math.floor(device.limits.maxComputeWorkgroupStorageSize / 4) - 32;
    this.tileBins = Math.max(256, Math.min(opts.tileBins ?? 8192, maxBins, 8192));
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SLOT_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.ring = device.createBuffer({ size: RING_SLOTS * SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tallyBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.foldPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: FOLD_WGSL }), entryPoint: 'fold' },
    });
    this.foldUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resize(opts.width, opts.height);
  }

  private async compile(laws: readonly TrillionLaw[], prelude: string): Promise<void> {
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    await Promise.all(laws.map(async (law) => {
      const module = this.device.createShaderModule({ code: splatWgsl(law, this.tileBins, prelude), label: `trillion:${law.id}` });
      const [direct, tiled, strata] = await Promise.all([
        this.device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'direct' } }),
        this.device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'tiled' } }),
        this.device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'strata' } }),
      ]);
      this.pipelines.set(law.id, { direct, tiled, strata, coherent: !!law.coherent });
    }));
  }

  /** Reallocates the counters (cleared). */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.acc) return;
    this.width = width;
    this.height = height;
    this.acc?.destroy();
    this.counts?.destroy();
    const pixels = width * height;
    this.acc = this.device.createBuffer({ size: pixels * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.counts = this.device.createBuffer({ size: pixels * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.bind = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.ring, size: SLOT_BYTES } },
        { binding: 1, resource: { buffer: this.acc } },
        { binding: 2, resource: { buffer: this.tallyBuffer } },
      ],
    });
    this.foldBind = this.device.createBindGroup({
      layout: this.foldPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.foldUniform } },
        { binding: 1, resource: { buffer: this.acc } },
        { binding: 2, resource: { buffer: this.counts } },
      ],
    });
    const groups = Math.ceil(pixels / WORKGROUP);
    const gx = Math.min(groups, 32768);
    this.device.queue.writeBuffer(this.foldUniform, 0, new Uint32Array([pixels, gx * WORKGROUP, 0, 0]));
    this.unfolded = 0;
  }

  /**
   * Zeroes the counters and the GPU tally. With `keepCounts`, the 64 bit
   * `counts` are left as they are, for resuming from a checkpoint written
   * into them with queue.writeBuffer (fold only ever adds to them).
   */
  clear(encoder: GPUCommandEncoder, opts: { keepCounts?: boolean } = {}): void {
    encoder.clearBuffer(this.acc);
    if (!opts.keepCounts) encoder.clearBuffer(this.counts);
    encoder.clearBuffer(this.tallyBuffer);
    this.unfolded = 0;
    this.evaluated = 0;
    this.culled = 0;
  }

  /** Call after each queue.submit of an encoder that this kernel encoded into. */
  submitted(): void {
    this.slotsSinceSubmit = 0;
  }

  /**
   * Screen rectangle the plane can touch, clipped to the frame, or null when
   * none of it can be seen. Conservative: assumes the law stays on the sheet.
   */
  footprint(plane: TrillionPlane): PixelRect | null {
    const h = plane.homography;
    const near = plane.near ?? 1e-4;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let behind = 0;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const w = h[6] * sx + h[7] * sy + h[8];
      if (!(w > near)) { behind++; continue; }
      const px = (h[0] * sx + h[1] * sy + h[2]) / w;
      const py = (h[3] * sx + h[4] * sy + h[5]) / w;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    if (behind === 4) return null;
    // Part of the sheet crosses the near plane: its image is unbounded.
    if (behind > 0) return { x: 0, y: 0, w: this.width, h: this.height };
    // One pixel of margin for the stochastic splat.
    const ax = Math.max(0, Math.floor(x0 - 1)), ay = Math.max(0, Math.floor(y0 - 1));
    const bx = Math.min(this.width, Math.ceil(x1 + 1)), by = Math.min(this.height, Math.ceil(y1 + 1));
    if (bx <= ax || by <= ay) return null;
    return { x: ax, y: ay, w: bx - ax, h: by - ay };
  }

  /**
   * Encodes plane-local ids [start, start + count). With settings.cull, whole
   * batches of an unseen plane are skipped and counted as culled. Returns the
   * particles that will be evaluated.
   */
  encodeBatch(encoder: GPUCommandEncoder, batch: TrillionBatch): number {
    const { plane } = batch;
    const pipes = this.pipelines.get(plane.law);
    if (!pipes) throw new Error(`TrillionKernel: unknown law "${plane.law}"`);
    if (plane.count > U32_LIMIT) throw new Error('TrillionKernel: at most 2^32 particles per plane');
    let start = Math.max(0, Math.floor(batch.start));
    const end = Math.min(plane.count, start + Math.floor(batch.count));
    if (end <= start) return 0;
    const rect = this.footprint(plane);
    if (!rect && this.settings.cull) { this.culled += end - start; return 0; }
    const math = this.settings.mode === 'math';
    if (pipes.coherent && !math) return this.encodeStrata(encoder, plane, pipes.strata, start, end);
    const tiled = !math && !!rect && rect.w * rect.h <= this.tileBins;
    const pipe = tiled ? pipes.tiled : pipes.direct;
    // Shared memory flushes cost up to tileBins atomics: give each workgroup
    // at least 8 particles per counter. Direct: 64 per invocation.
    const perThread = tiled && rect ? Math.min(2048, Math.max(64, Math.ceil((8 * rect.w * rect.h) / WORKGROUP))) : 64;
    let total = 0;
    while (start < end) {
      const n = Math.min(end - start, MAX_DISPATCH);
      if (this.unfolded + n > U32_LIMIT - 1) this.fold(encoder);
      const groups = Math.ceil(n / (WORKGROUP * perThread));
      const gridX = Math.min(groups, 65535);
      const gridY = Math.ceil(groups / gridX);
      const offset = this.writeSlot(plane, start, n, perThread, gridX, groups, tiled ? rect : null);
      const pass = encoder.beginComputePass({ label: `trillion:${plane.law}` });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, this.bind, [offset]);
      pass.dispatchWorkgroups(gridX, gridY);
      pass.end();
      this.unfolded += n;
      this.evaluated += n;
      total += n;
      start += n;
    }
    return total;
  }

  /** Adds the hot counters into the exact 64 bit `counts`. Call before reading `counts`. */
  fold(encoder: GPUCommandEncoder): void {
    const groups = Math.ceil((this.width * this.height) / WORKGROUP);
    const gx = Math.min(groups, 32768);
    const pass = encoder.beginComputePass({ label: 'trillion:fold' });
    pass.setPipeline(this.foldPipeline);
    pass.setBindGroup(0, this.foldBind);
    pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    pass.end();
    this.unfolded = 0;
  }

  /** GPU tally (landed, inView) plus the CPU one (evaluated, culled). Waits for the queue. */
  async readTally(): Promise<TrillionTally> {
    const staging = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.tallyBuffer, 0, staging, 0, 32);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return {
      evaluated: this.evaluated,
      culled: this.culled,
      landed: u[0] + u[1] * U32_LIMIT,
      inView: u[2] + u[3] * U32_LIMIT,
      patches: u[4],
      tiledPatches: u[5],
      evaluatedGpu: u[6] + u[7] * U32_LIMIT,
    };
  }

  /** Exact per pixel counts (folds first). For checks and checkpoints, not per frame. */
  async readCounts(): Promise<Float64Array> {
    const enc = this.device.createCommandEncoder();
    this.fold(enc);
    const size = this.width * this.height * 8;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(this.counts, 0, staging, 0, size);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(staging.getMappedRange());
    const out = new Float64Array(this.width * this.height);
    for (let i = 0; i < out.length; i++) out[i] = u[2 * i] + u[2 * i + 1] * U32_LIMIT;
    staging.destroy();
    return out;
  }

  destroy(): void {
    this.acc.destroy();
    this.counts.destroy();
    this.tallyBuffer.destroy();
    this.ring.destroy();
    this.foldUniform.destroy();
  }

  /** Patch layout of a plane on the strata path. */
  strataLayout(plane: TrillionPlane): { gu: number; gv: number; patches: number; base: number; rem: number } {
    let [gu, gv] = plane.strata ?? [0, 0];
    if (!(gu >= 1 && gv >= 1)) {
      const side = Math.max(1, Math.round(Math.sqrt(plane.count / 2 ** 17)));
      gu = side;
      gv = side;
    }
    gu = Math.floor(gu);
    gv = Math.floor(gv);
    const patches = gu * gv;
    return { gu, gv, patches, base: Math.floor(plane.count / patches), rem: plane.count % patches };
  }

  private encodeStrata(encoder: GPUCommandEncoder, plane: TrillionPlane, pipe: GPUComputePipeline, start: number, end: number): number {
    const L = this.strataLayout(plane);
    // First patch holding id: the first `rem` patches hold base + 1.
    const big = L.rem * (L.base + 1);
    const patchOf = (id: number): number => (id < big ? Math.floor(id / (L.base + 1)) : L.rem + Math.floor((id - big) / L.base));
    const patchStart = (c: number): number => c * L.base + Math.min(c, L.rem);
    const perDispatch = Math.max(1, Math.floor(MAX_DISPATCH / (L.base + 1)));
    let c = patchOf(start);
    const cEnd = patchOf(end - 1) + 1;
    let total = 0;
    while (c < cEnd) {
      const groups = Math.min(cEnd - c, perDispatch, 65535 * 65535);
      const a = Math.max(start, patchStart(c));
      const b = Math.min(end, patchStart(c + groups));
      const n = b - a;
      if (this.unfolded + n > U32_LIMIT - 1) this.fold(encoder);
      const gridX = Math.min(groups, 65535);
      const gridY = Math.ceil(groups / gridX);
      const offset = this.writeSlot(plane, a, n, 0, gridX, groups, null, [c, L.base, L.rem, L.gu, L.gv]);
      const pass = encoder.beginComputePass({ label: `trillion:${plane.law}:strata` });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, this.bind, [offset]);
      pass.dispatchWorkgroups(gridX, gridY);
      pass.end();
      this.unfolded += n;
      this.evaluated += n;
      total += n;
      c += groups;
    }
    return total;
  }

  private writeSlot(plane: TrillionPlane, start: number, count: number, perThread: number,
    gridX: number, groups: number, tile: PixelRect | null, strata: number[] = [0, 0, 0, 1, 1]): number {
    if (this.slotsSinceSubmit >= RING_SLOTS) {
      throw new Error(`TrillionKernel: more than ${RING_SLOTS} dispatches in one submit; call submitted() after each submit`);
    }
    const f = new Float32Array(this.scratch);
    const u = new Uint32Array(this.scratch);
    const i = new Int32Array(this.scratch);
    const h = plane.homography;
    f.set([h[0], h[1], h[2], 0, h[3], h[4], h[5], 0, h[6], h[7], h[8], plane.near ?? 1e-4], 0);
    const p = plane.params ?? [];
    for (let k = 0; k < 8; k++) f[12 + k] = k < p.length ? p[k] : 0;
    const keep = plane.keep ?? 1;
    u[20] = start >>> 0;
    u[21] = count >>> 0;
    u[22] = perThread;
    u[23] = gridX;
    u[24] = groups;
    u[25] = plane.seed >>> 0;
    u[26] = this.settings.salt >>> 0;
    u[27] = keep >= 1 ? 0x1000000 : Math.max(0, Math.floor(keep * 0x1000000));
    u[28] = this.width;
    u[29] = this.height;
    u[30] = (this.settings.stochastic ? 1 : 0) | (this.settings.mode === 'math' ? 2 : 0) | (this.settings.mode === 'noTile' ? 4 : 0);
    u[31] = 0;
    f[32] = this.settings.time;
    f[33] = this.settings.shutter;
    f[34] = 0;
    f[35] = 0;
    i.set(tile ? [tile.x, tile.y, tile.w, tile.h] : [0, 0, 0, 0], 36);
    u.set([strata[0] >>> 0, strata[1] >>> 0, strata[2] >>> 0, strata[3] >>> 0, strata[4] >>> 0, 0, 0, 0], 40);
    const offset = this.slot * SLOT_BYTES;
    this.device.queue.writeBuffer(this.ring, offset, this.scratch, 0, 192);
    this.slot = (this.slot + 1) % RING_SLOTS;
    this.slotsSinceSubmit++;
    return offset;
  }
}

/**
 * Homography for a plane: sheet (sx, sy) in [-1, 1]^2 -> pixels, from the
 * plane's model matrix (sheet to world, column-major, sheet on z = 0) and a
 * view-projection matrix (column-major, WebGPU clip space).
 */
export function planeHomography(viewProj: ArrayLike<number>, model: ArrayLike<number>, width: number, height: number): number[] {
  // A = viewProj * model, only columns 0, 1, 3 matter (sheet z = 0).
  const a = (row: number, col: number): number => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += viewProj[k * 4 + row] * model[col * 4 + k];
    return s;
  };
  const cols = [0, 1, 3];
  const rx = cols.map((c) => a(0, c));
  const ry = cols.map((c) => a(1, c));
  const rw = cols.map((c) => a(3, c));
  return [
    ...rx.map((v, k) => 0.5 * width * (v + rw[k])),
    ...ry.map((v, k) => 0.5 * height * (rw[k] - v)),
    ...rw,
  ];
}

/** Device limits the kernel benefits from. Pass to adapter.requestDevice({ requiredLimits }). */
export function trillionLimits(adapter: GPUAdapter): Record<string, number> {
  return {
    maxComputeWorkgroupStorageSize: Math.min(adapter.limits.maxComputeWorkgroupStorageSize, 32768 + 64),
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
}
