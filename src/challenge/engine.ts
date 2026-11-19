/**
 * Challenge engine: the GPU side of Challenge mode.
 *
 * It owns the packed particle slabs, the atomic accumulation buffer and the
 * compute pipelines, and encodes one frame into a command encoder you give
 * it. It knows nothing about the DOM, the frame loop or the ramp, so the same
 * object serves the live page, the frame-graph passes in ./passes.ts and a
 * deterministic offline render (fixed dt, explicit frame index).
 *
 * See ./README.md for the design and the rules about what counts.
 */

import type { Mat4, PlaneDesc, Vec3 } from "../core/contracts";
import {
  COUNT_SLOTS,
  DISPATCH_STRIDE,
  GLOBALS_BYTES,
  GLOBALS_HEADER_BYTES,
  MAX_PLANES,
  MODES,
  PLANE_BYTES,
  ROW,
  WELLS,
  initWgsl,
  procWgsl,
  resolveWgsl,
  simWgsl,
} from "./shaders";

/** "sim": stored state, integrated every frame. "proc": stateless, position from id and time. */
export type ChallengeMode = "sim" | "proc";

/** Bytes of state per simulated particle. */
export const BYTES_PER_PARTICLE = 8;
/** Entries in the dispatch table, which bounds dispatches per frame. */
export const MAX_DISPATCHES = 255;

export interface EngineOptions {
  device: GPUDevice;
  width: number;
  height: number;
  planes: readonly PlaneDesc[];
  /** Compute workgroup size. Must divide 65536. Default 256, lowered to the device limit. */
  workgroupSize?: number;
  /** Particles per slab (one GPU buffer). Multiple of 65536. Default 2^24 = 128 MiB. */
  slabParticles?: number;
  /** Particles per dispatch in the stateless mode. Multiple of 65536. Default 2^26. */
  procChunk?: number;
  /** Seeds the initial particle positions. */
  seed?: number;
  /** Scale every splat by 1 / distance^2 so sheets keep their brightness at any range. Default true. */
  attenuate?: boolean;
  /** Fixed accumulation units per particle. Default: chosen from the count. */
  units?: number;
  /**
   * Merge same-pixel hits within a subgroup before the atomic add (see
   * AGG_DEPOSIT in shaders.ts). Used only when the device was created with
   * the 'subgroups' feature. Default false.
   */
  aggregate?: boolean;
}

export interface FrameInput {
  /** World to clip, column-major. */
  viewProj: Mat4;
  /** Seconds since start. Drives the wave phases and well positions. */
  time: number;
  /** Seconds to integrate this frame. */
  dt: number;
  /** Frame index. Seeds the per-frame random numbers, so runs are repeatable. */
  frame: number;
}

interface Well {
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  fx: number;
  fy: number;
  px: number;
  py: number;
  strength: number;
  soft2: number;
}

interface Mode {
  kx: number;
  ky: number;
  phase: number;
  omega: number;
  amp: number;
}

interface PlaneStyle {
  drag: number;
  noise: number;
  wells: Well[];
  flow: Mode[];
  procStyle: number;
  proc: Mode[];
}

interface Slab {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const quatRotate = (q: readonly number[], v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

/** A wave vector on the torus: pi times a small nonzero integer pair. */
const waveVector = (rnd: () => number, maxN: number): [number, number] => {
  for (;;) {
    const nx = Math.round((rnd() * 2 - 1) * maxN);
    const ny = Math.round((rnd() * 2 - 1) * maxN);
    if (nx !== 0 || ny !== 0) return [nx * Math.PI, ny * Math.PI];
  }
};

/** Everything that makes one sheet look different from the next, from its seed. */
const styleFromSeed = (seed: number, index: number): PlaneStyle => {
  const rnd = mulberry32(Math.floor(seed * 4294967296) ^ Math.imul(index + 1, 0x9e3779b1));
  // 0: filaments (flow only). 1: collisionless wells, almost no drag, so the
  // cloud keeps orbiting instead of sinking to a point. 2: flow stirred by
  // moving repulsive voids.
  const kind = index % 3;

  const flowSpeed = kind === 1 ? 0.03 + rnd() * 0.04 : 0.22 + rnd() * 0.2;
  const flow: Mode[] = [];
  for (let m = 0; m < MODES; m++) {
    const [kx, ky] = waveVector(rnd, 1 + m);
    const k = Math.hypot(kx, ky);
    flow.push({
      kx,
      ky,
      phase: rnd() * Math.PI * 2,
      omega: (rnd() < 0.5 ? -1 : 1) * (0.15 + rnd() * 0.5),
      // Each mode contributes about flowSpeed / 2 of velocity.
      amp: (flowSpeed * 0.5) / k,
    });
  }

  const wellCount = kind === 0 ? 0 : 1 + Math.floor(rnd() * 3);
  const wells: Well[] = [];
  for (let k = 0; k < WELLS; k++) {
    const strength = kind === 1 ? 0.03 + rnd() * 0.05 : -(0.008 + rnd() * 0.012);
    wells.push({
      cx: (rnd() * 2 - 1) * 0.35,
      cy: (rnd() * 2 - 1) * 0.35,
      ax: 0.15 + rnd() * 0.3,
      ay: 0.15 + rnd() * 0.3,
      fx: (rnd() < 0.5 ? -1 : 1) * (0.03 + rnd() * 0.08),
      fy: (rnd() < 0.5 ? -1 : 1) * (0.03 + rnd() * 0.08),
      px: rnd() * Math.PI * 2,
      py: rnd() * Math.PI * 2,
      strength: k < wellCount ? strength : 0,
      soft2: kind === 1 ? 0.004 + rnd() * 0.006 : 0.002 + rnd() * 0.004,
    });
  }

  const proc: Mode[] = [];
  for (let m = 0; m < MODES; m++) {
    const [kx, ky] = waveVector(rnd, 1 + m);
    const k2 = kx * kx + ky * ky;
    proc.push({
      kx,
      ky,
      phase: rnd() * Math.PI * 2,
      omega: (rnd() < 0.5 ? -1 : 1) * (0.1 + rnd() * 0.35),
      // The cloud folds where amp * |k|^2 * gain exceeds 1. Gain is 0.35 to 1.35.
      amp: (0.55 + rnd() * 0.6) / k2,
    });
  }

  return {
    drag: kind === 1 ? 0.02 + rnd() * 0.04 : 1.2 + rnd() * 2.5,
    noise: 0.02,
    wells,
    flow,
    procStyle: index % 4 === 3 ? 1 : 0,
    proc,
  };
};

/**
 * Homography from sheet coordinates to pixels for one plane:
 * (px * w, py * w, w) = h[0..2] * x + h[3..5] * y + h[6..8].
 * Exported so tests can reproduce the kernel's projection on the CPU.
 */
export const planeHomography = (
  viewProj: Mat4,
  desc: PlaneDesc,
  width: number,
  height: number,
): Float64Array => {
  const ax = quatRotate(desc.rotation, [desc.halfSize[0], 0, 0]);
  const ay = quatRotate(desc.rotation, [0, desc.halfSize[1], 0]);
  const cols: [Vec3, number][] = [
    [ax, 0],
    [ay, 0],
    [desc.position, 1],
  ];
  const out = new Float64Array(9);
  const m = viewProj;
  cols.forEach(([v, w], c) => {
    const cx = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w;
    const cy = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w;
    const cw = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * w;
    out[c * 3] = (cx + cw) * 0.5 * width;
    out[c * 3 + 1] = (cw - cy) * 0.5 * height;
    out[c * 3 + 2] = cw;
  });
  return out;
};

/** Accumulation units one particle adds at the reference distance. */
export const unitsForCount = (count: number): number => {
  // Fewer units per particle as the count grows, so a pixel's u32 cannot wrap
  // unless more than half of all particles land on it at the reference weight.
  // Small weights lose nothing: the kernel dithers them.
  const raw = 2 ** 33 / Math.max(count, 1);
  const pow2 = 2 ** Math.floor(Math.log2(raw));
  return Math.min(256, Math.max(1, pow2));
};

/** The closest a particle's weight may rise above the reference weight. */
const WEIGHT_CAP = 16;

export class ChallengeEngine {
  readonly device: GPUDevice;
  readonly workgroupSize: number;
  readonly slabParticles: number;
  readonly procChunk: number;
  /** True when the kernels merge same-pixel hits per subgroup before the atomic. */
  readonly aggregate: boolean;

  mode: ChallengeMode = "sim";
  /** Exposure of the canvas resolve: light of a face-on sheet with evenly spread particles. */
  // 0.012 clips about 0.4% of pixels to flat white at every count (0.02 clipped
  // about 2%), at an 11% lower mean level. Measured by the visual QA, figure 06.
  exposure = 0.012;
  /** Shoulder of the log tonemap. Higher shows fainter structure. */
  curve = 400;
  /** Set when a slab allocation failed. The simulated count cannot grow past `capacity`. */
  memoryLimited = false;
  /** Last measured GPU time of the compute pass in milliseconds, or null without timestamp queries. */
  gpuMs: number | null = null;
  /**
   * Particles the GPU itself counted in the latest checked frame, or null
   * before the first check. Frames are checked by `afterSubmit`, one at a time.
   */
  gpuCount: number | null = null;
  /** The count the checked frame was encoded with. `gpuCount` must equal it. */
  gpuCountExpected = 0;
  /** Checked frames whose GPU count differed from the encoded count, since `resetCountCheck`. */
  countMismatches = 0;

  private width: number;
  private height: number;
  private planes: PlaneDesc[] = [];
  private styles: PlaneStyle[] = [];
  private readonly seed: number;
  private readonly attenuate: boolean;
  private readonly fixedUnits: number | null;
  private activeCount = ROW;

  private readonly g0Layout: GPUBindGroupLayout;
  private readonly g1SimLayout: GPUBindGroupLayout;
  private readonly g1ProcLayout: GPUBindGroupLayout;
  private readonly resolveLayout: GPUBindGroupLayout;
  private readonly initPipeline: GPUComputePipeline;
  private readonly simPipeline: GPUComputePipeline;
  private readonly procPipeline: GPUComputePipeline;
  private readonly resolveModule: GPUShaderModule;
  private readonly resolvePipelines = new Map<string, GPURenderPipeline>();

  private readonly globalsData = new ArrayBuffer(GLOBALS_BYTES);
  private readonly globalsF32 = new Float32Array(this.globalsData);
  private readonly globalsU32 = new Uint32Array(this.globalsData);
  private readonly globalsBuffer: GPUBuffer;
  private readonly dispatchData = new ArrayBuffer(MAX_DISPATCHES * DISPATCH_STRIDE);
  private readonly dispatchU32 = new Uint32Array(this.dispatchData);
  private readonly dispatchBuffer: GPUBuffer;
  private readonly resolveData = new ArrayBuffer(16);
  private readonly resolveBuffer: GPUBuffer;
  private readonly procBindGroup: GPUBindGroup;

  private fb!: GPUBuffer;
  private g0!: GPUBindGroup;
  private resolveBindGroup!: GPUBindGroup;
  private slabs: Slab[] = [];
  private growing: Promise<number> | null = null;
  private dispatches: number[] = [];
  private frameUnits = 256;
  private frameScale = 1;

  private readonly querySet: GPUQuerySet | null = null;
  private readonly queryResolve: GPUBuffer | null = null;
  private readonly queryRead: GPUBuffer | null = null;
  private queryState: "idle" | "copied" | "mapping" = "idle";

  private readonly countBuffer: GPUBuffer;
  private readonly countRead: GPUBuffer;
  private readonly countZeros = new Uint32Array(COUNT_SLOTS);
  private countMapping = false;
  private countGeneration = 0;
  private encodedCount = 0;

  constructor(options: EngineOptions) {
    const device = options.device;
    this.device = device;
    this.width = Math.max(1, Math.floor(options.width));
    this.height = Math.max(1, Math.floor(options.height));
    this.seed = (options.seed ?? 1) >>> 0;
    this.attenuate = options.attenuate ?? true;
    this.fixedUnits = options.units ?? null;

    let wg = options.workgroupSize ?? 256;
    wg = Math.min(wg, device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX);
    wg = 2 ** Math.floor(Math.log2(Math.max(1, wg)));
    if (ROW / wg > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new Error(`workgroup size ${wg} needs more workgroups per dimension than this device allows`);
    }
    this.workgroupSize = wg;

    const roundRow = (n: number) => Math.max(ROW, Math.floor(n / ROW) * ROW);
    const maxSlabBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    this.slabParticles = roundRow(
      Math.min(options.slabParticles ?? 2 ** 24, maxSlabBytes / BYTES_PER_PARTICLE),
    );
    // One dispatch is count / ROW rows, and rows are bounded by the device.
    const maxPerDispatch = device.limits.maxComputeWorkgroupsPerDimension * ROW;
    this.procChunk = roundRow(Math.min(options.procChunk ?? 2 ** 26, maxPerDispatch));
    if (this.slabParticles > maxPerDispatch) {
      throw new Error("slab is larger than one dispatch can cover on this device");
    }

    this.g0Layout = device.createBindGroupLayout({
      label: "challenge g0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const dispatchEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
    };
    this.g1SimLayout = device.createBindGroupLayout({
      label: "challenge g1 sim",
      entries: [dispatchEntry, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }],
    });
    this.g1ProcLayout = device.createBindGroupLayout({
      label: "challenge g1 proc",
      entries: [dispatchEntry],
    });
    this.resolveLayout = device.createBindGroupLayout({
      label: "challenge resolve",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });

    const simLayout = device.createPipelineLayout({ bindGroupLayouts: [this.g0Layout, this.g1SimLayout] });
    const procLayout = device.createPipelineLayout({ bindGroupLayouts: [this.g0Layout, this.g1ProcLayout] });
    const compute = (label: string, layout: GPUPipelineLayout, code: string) =>
      device.createComputePipeline({
        label,
        layout,
        compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" },
      });
    this.initPipeline = compute("challenge init", simLayout, initWgsl(wg));
    this.aggregate = (options.aggregate ?? false) && device.features.has("subgroups");
    this.simPipeline = compute("challenge sim", simLayout, simWgsl(wg, this.aggregate));
    this.procPipeline = compute("challenge proc", procLayout, procWgsl(wg, this.aggregate));
    this.resolveModule = device.createShaderModule({ label: "challenge resolve", code: resolveWgsl });

    this.globalsBuffer = device.createBuffer({
      label: "challenge globals",
      size: GLOBALS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dispatchBuffer = device.createBuffer({
      label: "challenge dispatch table",
      size: MAX_DISPATCHES * DISPATCH_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.resolveBuffer = device.createBuffer({
      label: "challenge resolve uniform",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.procBindGroup = device.createBindGroup({
      layout: this.g1ProcLayout,
      entries: [{ binding: 0, resource: { buffer: this.dispatchBuffer, size: 16 } }],
    });

    if (device.features.has("timestamp-query")) {
      this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
      this.queryResolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.queryRead = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }

    this.countBuffer = device.createBuffer({
      label: "challenge gpu count",
      size: COUNT_SLOTS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.countRead = device.createBuffer({
      label: "challenge gpu count readback",
      size: COUNT_SLOTS * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.setPlanes(options.planes);
    this.createFramebuffer();
  }

  // ------------------------------------------------------------- state ----

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Particles processed per frame in the current mode. Always a multiple of 65536. */
  get count(): number {
    return this.mode === "sim" ? Math.min(this.activeCount, this.capacity) : this.activeCount;
  }

  /** Simulated particles that have storage right now. */
  get capacity(): number {
    return this.slabs.length * this.slabParticles;
  }

  /** The most particles this mode can ever process per frame on this device. */
  get maxCount(): number {
    if (this.mode === "proc") return this.procChunk * MAX_DISPATCHES;
    // Simulated ids are u32 (D.base + i). Past 2^32 they would wrap, and two
    // particles with one id share their seed and every random number after.
    return Math.min(MAX_DISPATCHES, Math.floor(2 ** 32 / this.slabParticles)) * this.slabParticles;
  }

  /** Bytes of particle state on the GPU. */
  get stateBytes(): number {
    return this.capacity * BYTES_PER_PARTICLE;
  }

  get planeCount(): number {
    return this.planes.length;
  }

  /** Accumulation units per particle used by the last encoded frame. */
  get units(): number {
    return this.frameUnits;
  }

  setPlanes(planes: readonly PlaneDesc[]): void {
    if (planes.length < 1) throw new Error("challenge needs at least one plane");
    this.planes = planes.slice(0, MAX_PLANES);
    this.styles = this.planes.map((p, i) => styleFromSeed(p.seed, i));
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.fb.destroy();
    this.createFramebuffer();
  }

  /**
   * Ask for `count` particles per frame. The stateless mode takes it at once.
   * The simulated mode can only use what has storage, so this resolves after
   * any new slabs are allocated and seeded, with the count actually in use.
   */
  async setCount(count: number): Promise<number> {
    const want = Math.max(ROW, Math.min(this.maxCount, Math.floor(count / ROW) * ROW));
    if (this.mode === "sim") {
      const capacity = await this.ensureCapacity(want);
      this.activeCount = Math.max(ROW, Math.min(want, capacity));
    } else {
      this.activeCount = want;
    }
    return this.count;
  }

  /** Allocate and seed slabs until `count` simulated particles have storage, or memory runs out. */
  ensureCapacity(count: number): Promise<number> {
    const run = async (): Promise<number> => {
      const device = this.device;
      const needed = Math.min(MAX_DISPATCHES, Math.ceil(count / this.slabParticles));
      while (this.slabs.length < needed && !this.memoryLimited) {
        const index = this.slabs.length;
        device.pushErrorScope("out-of-memory");
        const buffer = device.createBuffer({
          label: `challenge slab ${index}`,
          size: this.slabParticles * BYTES_PER_PARTICLE,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const error = await device.popErrorScope();
        if (error) {
          buffer.destroy();
          this.memoryLimited = true;
          break;
        }
        const bindGroup = device.createBindGroup({
          layout: this.g1SimLayout,
          entries: [
            { binding: 0, resource: { buffer: this.dispatchBuffer, size: 16 } },
            { binding: 1, resource: { buffer } },
          ],
        });
        this.seedSlab(buffer, index);
        this.slabs.push({ buffer, bindGroup });
      }
      return this.capacity;
    };
    // Serialize growth so two callers never allocate the same slab twice.
    const next = (this.growing ?? Promise.resolve(0)).then(run, run);
    this.growing = next;
    return next;
  }

  private seedSlab(buffer: GPUBuffer, index: number): void {
    const device = this.device;
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(uniform.getMappedRange()).set([
      index * this.slabParticles,
      this.slabParticles,
      Math.imul(this.seed, 0x9e3779b1) >>> 0,
      0,
    ]);
    uniform.unmap();
    const bindGroup = device.createBindGroup({
      layout: this.g1SimLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform, size: 16 } },
        { binding: 1, resource: { buffer } },
      ],
    });
    // The init kernel declares group 0 but only touches group 1. Bind the real one.
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.initPipeline);
    pass.setBindGroup(0, this.g0);
    pass.setBindGroup(1, bindGroup, [0]);
    pass.dispatchWorkgroups(ROW / this.workgroupSize, this.slabParticles / ROW);
    pass.end();
    device.queue.submit([encoder.finish()]);
    uniform.destroy();
  }

  private createFramebuffer(): void {
    const device = this.device;
    this.fb = device.createBuffer({
      label: "challenge accumulation",
      size: this.width * this.height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.g0 = device.createBindGroup({
      layout: this.g0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuffer } },
        { binding: 1, resource: { buffer: this.fb } },
        { binding: 2, resource: { buffer: this.countBuffer } },
      ],
    });
    this.resolveBindGroup = device.createBindGroup({
      layout: this.resolveLayout,
      entries: [
        { binding: 0, resource: { buffer: this.resolveBuffer } },
        { binding: 1, resource: { buffer: this.fb } },
      ],
    });
  }

  // ------------------------------------------------------------- frame ----

  /**
   * Encode one frame of work: clear the accumulation buffer, then run the
   * kernel of the current mode over every active particle. In "sim" mode this
   * advances the simulation by `dt`. Follow with a resolve call.
   */
  encode(encoder: GPUCommandEncoder, input: FrameInput): void {
    const count = this.count;
    const units = this.fixedUnits ?? unitsForCount(count);
    this.frameUnits = units;
    this.writeGlobals(input, units, count);
    this.writeDispatches(count);
    // Zero the GPU count with a queue write, not encoder.clearBuffer: if this
    // frame's command buffer is dropped (a validation error runs none of it),
    // the count must read zero, not the previous frame's total.
    this.device.queue.writeBuffer(this.countBuffer, 0, this.countZeros);
    this.encodedCount = count;

    encoder.clearBuffer(this.fb);
    const timed = this.querySet !== null && this.queryState === "idle";
    const pass = encoder.beginComputePass({
      label: "challenge kernel",
      timestampWrites: timed
        ? { querySet: this.querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
        : undefined,
    });
    pass.setBindGroup(0, this.g0);
    pass.setPipeline(this.mode === "sim" ? this.simPipeline : this.procPipeline);
    const x = ROW / this.workgroupSize;
    this.dispatches.forEach((n, d) => {
      pass.setBindGroup(1, this.mode === "sim" ? this.slabs[d].bindGroup : this.procBindGroup, [
        d * DISPATCH_STRIDE,
      ]);
      pass.dispatchWorkgroups(x, n / ROW);
    });
    pass.end();
    if (timed) {
      encoder.resolveQuerySet(this.querySet!, 0, 2, this.queryResolve!, 0);
      encoder.copyBufferToBuffer(this.queryResolve!, 0, this.queryRead!, 0, 16);
      this.queryState = "copied";
    }
  }

  /**
   * Call after submitting the encoder from `encode`: collects the GPU timing
   * and checks the frame's GPU particle count against the encoded count.
   */
  afterSubmit(): void {
    this.checkCount();
    this.readTimestamps();
  }

  /** Forget earlier count checks, for example when a new run starts. */
  resetCountCheck(): void {
    this.countGeneration++;
    this.countMismatches = 0;
    this.gpuCount = null;
    this.gpuCountExpected = 0;
  }

  /**
   * Copy the just-submitted frame's GPU count back and compare. The copy is
   * its own submit, so it runs even when the frame's command buffer was
   * invalid, and then reads the zeros written in `encode`.
   */
  private checkCount(): void {
    if (this.countMapping) return; // the previous check is still in flight
    this.countMapping = true;
    const expected = this.encodedCount;
    const generation = this.countGeneration;
    const encoder = this.device.createCommandEncoder({ label: "challenge gpu count readback" });
    encoder.copyBufferToBuffer(this.countBuffer, 0, this.countRead, 0, COUNT_SLOTS * 4);
    this.device.queue.submit([encoder.finish()]);
    const read = this.countRead;
    read.mapAsync(GPUMapMode.READ).then(
      () => {
        const slots = new Uint32Array(read.getMappedRange());
        let sum = 0;
        for (let k = 0; k < slots.length; k++) sum += slots[k];
        read.unmap();
        this.countMapping = false;
        if (generation !== this.countGeneration) return;
        this.gpuCount = sum;
        this.gpuCountExpected = expected;
        if (sum !== expected) this.countMismatches++;
      },
      () => {
        this.countMapping = false;
      },
    );
  }

  private readTimestamps(): void {
    if (this.queryState !== "copied" || !this.queryRead) return;
    this.queryState = "mapping";
    const read = this.queryRead;
    read.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigUint64Array(read.getMappedRange());
        const ns = Number(t[1] - t[0]);
        if (ns > 0 && ns < 60e9) this.gpuMs = ns / 1e6;
        read.unmap();
        this.queryState = "idle";
      },
      () => {
        this.queryState = "idle";
      },
    );
  }

  /** Tonemap the accumulation buffer onto a canvas-format target. */
  resolveToCanvas(encoder: GPUCommandEncoder, view: GPUTextureView, format: GPUTextureFormat): void {
    this.writeResolve(this.frameScale * this.exposure, this.curve);
    const pass = encoder.beginRenderPass({
      label: "challenge resolve",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.resolvePipeline(format, "fs_canvas", false));
    pass.setBindGroup(0, this.resolveBindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * Add the accumulation buffer to an HDR target as linear light, leaving
   * depth effects and tonemapping to later passes. `brightness` is the light
   * one particle adds to its pixel at the reference distance.
   */
  resolveToHdr(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    format: GPUTextureFormat,
    brightness: number,
    clear: boolean,
  ): void {
    this.writeResolve(brightness / this.frameUnits, 0);
    const pass = encoder.beginRenderPass({
      label: "challenge resolve hdr",
      colorAttachments: [
        { view, loadOp: clear ? "clear" : "load", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    });
    pass.setPipeline(this.resolvePipeline(format, "fs_hdr", true));
    pass.setBindGroup(0, this.resolveBindGroup);
    pass.draw(3);
    pass.end();
  }

  private resolvePipeline(format: GPUTextureFormat, entry: string, additive: boolean): GPURenderPipeline {
    const key = `${format}:${entry}`;
    let pipeline = this.resolvePipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `challenge resolve ${key}`,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.resolveLayout] }),
        vertex: { module: this.resolveModule, entryPoint: "vs" },
        fragment: {
          module: this.resolveModule,
          entryPoint: entry,
          targets: [
            additive
              ? {
                  format,
                  blend: {
                    color: { srcFactor: "one", dstFactor: "one" },
                    alpha: { srcFactor: "one", dstFactor: "one" },
                  },
                }
              : { format },
          ],
        },
        primitive: { topology: "triangle-list" },
      });
      this.resolvePipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private writeResolve(scale: number, curve: number): void {
    const u32 = new Uint32Array(this.resolveData);
    const f32 = new Float32Array(this.resolveData);
    u32[0] = this.width;
    u32[1] = this.height;
    f32[2] = scale;
    f32[3] = curve;
    this.device.queue.writeBuffer(this.resolveBuffer, 0, this.resolveData);
  }

  private writeGlobals(input: FrameInput, units: number, count: number): void {
    const f = this.globalsF32;
    const u = this.globalsU32;
    const planeCount = this.planes.length;
    u[0] = this.width;
    u[1] = this.height;
    u[2] = input.frame >>> 0;
    u[3] = planeCount;
    f[4] = input.dt;
    f[5] = input.time;

    const vp = input.viewProj;
    // Reference distance for brightness: mean clip w of the sheet centres.
    let ref = 0;
    let area = 0;
    for (const p of this.planes) {
      const [x, y, z] = p.position;
      ref += Math.max(1e-3, vp[3] * x + vp[7] * y + vp[11] * z + vp[15]);
      area += p.halfSize[0] * p.halfSize[1];
    }
    ref /= planeCount;
    area /= planeCount;
    // Projection scale 1 / tan(fovY / 2): the length of the view-projection's second row.
    const focal = Math.hypot(vp[1], vp[5], vp[9]);
    const perPlane = Math.max(count, 1) / planeCount;
    // With this scale, a face-on sheet whose particles are spread evenly has
    // light 1.0 per pixel at any distance (before `exposure`).
    this.frameScale = (area * this.height * this.height * focal * focal) / (perPlane * units * ref * ref);

    const sqrtDt = Math.sqrt(Math.max(input.dt, 0));
    const t = input.time;
    const TAU = Math.PI * 2;
    for (let i = 0; i < planeCount; i++) {
      const desc = this.planes[i];
      const style = this.styles[i];
      const o = (GLOBALS_HEADER_BYTES + i * PLANE_BYTES) / 4;
      const h = planeHomography(vp, desc, this.width, this.height);
      for (let c = 0; c < 3; c++) {
        f[o + c * 4] = h[c * 3];
        f[o + c * 4 + 1] = h[c * 3 + 1];
        f[o + c * 4 + 2] = h[c * 3 + 2];
        f[o + c * 4 + 3] = 0;
      }
      // a: weight numerator, weight cap, drag, kick
      f[o + 12] = this.attenuate ? units * ref * ref : 1e30;
      f[o + 13] = this.attenuate ? units * WEIGHT_CAP : units;
      f[o + 14] = style.drag;
      f[o + 15] = style.noise * sqrtDt;
      // b: well count, procedural style, seed
      const wells = style.wells.filter((w) => w.strength !== 0).length;
      f[o + 16] = wells;
      f[o + 17] = style.procStyle;
      f[o + 18] = desc.seed;
      f[o + 19] = 0;
      for (let k = 0; k < WELLS; k++) {
        const w = style.wells[k];
        const q = o + 20 + k * 4;
        f[q] = w.cx + w.ax * Math.sin(TAU * w.fx * t + w.px);
        f[q + 1] = w.cy + w.ay * Math.sin(TAU * w.fy * t + w.py);
        f[q + 2] = w.strength;
        f[q + 3] = w.soft2;
      }
      const modes = this.mode === "sim" ? style.flow : style.proc;
      for (let m = 0; m < MODES; m++) {
        const md = modes[m];
        const q = o + 20 + WELLS * 4 + m * 4;
        f[q] = md.kx;
        f[q + 1] = md.ky;
        // Phase is advanced in double precision here, so it stays exact for hours.
        f[q + 2] = (md.phase + md.omega * t) % TAU;
        f[q + 3] = md.amp;
      }
    }
    this.device.queue.writeBuffer(this.globalsBuffer, 0, this.globalsData, 0, GLOBALS_HEADER_BYTES + planeCount * PLANE_BYTES);
  }

  private writeDispatches(count: number): void {
    const chunk = this.mode === "sim" ? this.slabParticles : this.procChunk;
    const u = this.dispatchU32;
    this.dispatches = [];
    let left = count;
    for (let d = 0; left > 0 && d < MAX_DISPATCHES; d++) {
      const n = Math.min(chunk, left);
      const o = (d * DISPATCH_STRIDE) / 4;
      u[o] = this.mode === "sim" ? (d * chunk) >>> 0 : 0;
      u[o + 1] = n;
      // Keys for the stateless ids: distinct per dispatch, see procWgsl.
      u[o + 2] = Math.imul(d + 1, 0x9e3779b1) >>> 0;
      u[o + 3] = Math.imul(d + 1, 0x85ebca6b) >>> 0;
      this.dispatches.push(n);
      left -= n;
    }
    this.device.queue.writeBuffer(this.dispatchBuffer, 0, this.dispatchData, 0, this.dispatches.length * DISPATCH_STRIDE);
  }

  // ----------------------------------------------------------- readback ----

  /** Copy of the accumulation buffer, one u32 per pixel, row-major. For tests and capture. */
  async readAccumulation(): Promise<Uint32Array> {
    return new Uint32Array(await this.readBuffer(this.fb, 0, this.width * this.height * 4));
  }

  /** Copy of the first `particles` packed particles of a slab, two u32 each. For tests. */
  async readSlab(slab: number, particles: number): Promise<Uint32Array> {
    const s = this.slabs[slab];
    if (!s) throw new Error(`no slab ${slab}`);
    const n = Math.min(particles, this.slabParticles);
    return new Uint32Array(await this.readBuffer(s.buffer, 0, n * BYTES_PER_PARTICLE));
  }

  private async readBuffer(source: GPUBuffer, offset: number, size: number): Promise<ArrayBuffer> {
    const device = this.device;
    const read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset, read, 0, size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = read.getMappedRange().slice(0);
    read.unmap();
    read.destroy();
    return out;
  }

  dispose(): void {
    this.fb.destroy();
    for (const s of this.slabs) s.buffer.destroy();
    this.slabs = [];
    this.globalsBuffer.destroy();
    this.dispatchBuffer.destroy();
    this.resolveBuffer.destroy();
    this.querySet?.destroy();
    this.queryResolve?.destroy();
    this.queryRead?.destroy();
    this.countBuffer.destroy();
    this.countRead.destroy();
  }
}
