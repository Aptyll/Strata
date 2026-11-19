/**
 * Stateless frame renderer. Platform neutral: give it a GPUDevice from a
 * browser or from Dawn in Node.
 *
 * A frame is a sequence of short compute dispatches. Each one evaluates a
 * range of particles and adds them to the 64-bit accumulation grid. Batches
 * are sized to a time target so a single dispatch never runs long enough to
 * trip a GPU watchdog, and the frame can be checkpointed between batches.
 */
import { CameraPath } from "./camera";
import { ONE, totalParticles, validateJob, type LawId, type OfflineJob } from "./job";
import { cameraBasis, planeHomography } from "./math";
import { BATCH_UNIFORM_BYTES, WORKGROUP_SIZE, accumulateShader } from "./shaders";

export interface RendererOptions {
  /** Particles evaluated by one shader invocation in a loop. */
  perInvocation?: number;
  /** Aim for dispatches of about this long. */
  targetBatchMs?: number;
  /** First batch size. It adapts from there. */
  initialBatch?: number;
  /** Hard cap on particles per dispatch, at most 2^30. */
  maxBatch?: number;
}

/** Where a partly rendered frame stopped: the next particle to evaluate. */
export interface FrameCursor {
  plane: number;
  offset: number;
}

/** The state of a frame: the light grid and the in-frame tally. */
export interface Accumulation {
  /** Accumulation grid, low and high words, gridWidth * gridHeight each. */
  lo: Uint32Array;
  hi: Uint32Array;
  /** Exact number of evaluated particles whose position fell inside the frame. */
  landed: bigint;
  /**
   * Particles evaluated for this frame, counted on the GPU (includes work
   * restored from a checkpoint). Equals the world's total when the frame is done.
   */
  gpuEvaluated: bigint;
}

export interface FrameHooks {
  /** Called after every batch. */
  onProgress?(done: number, total: number, batchSize: number, batchMs: number): void;
  /** Start from a saved partial frame instead of from empty. */
  resume?: { cursor: FrameCursor } & Accumulation;
  /** Save a partial frame every `everyMs` so a crash loses little. */
  checkpoint?: { everyMs: number; save(cursor: FrameCursor, acc: Accumulation): Promise<void> };
  /** Checked between batches. When aborted, renderFrame rejects with an AbortError. */
  signal?: AbortSignal;
}

export interface FrameResult extends Accumulation {
  frame: number;
  /** Particles evaluated in this call (excludes work restored by a resume). */
  evaluated: number;
  batches: number;
  /** Wall seconds spent in this call. */
  seconds: number;
}

const now = (): number => performance.now();

export class StatelessRenderer {
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly total: number;
  /** Set when the device is lost. Every later call rejects. */
  lost: string | null = null;

  private readonly path: CameraPath;
  private readonly uniform: GPUBuffer;
  private readonly accLo: GPUBuffer;
  private readonly accHi: GPUBuffer;
  private readonly readLo: GPUBuffer;
  private readonly readHi: GPUBuffer;
  private readonly tally: GPUBuffer;
  private readonly readTally: GPUBuffer;
  private readonly pipelines = new Map<LawId, GPUComputePipeline>();
  private readonly bindGroups = new Map<LawId, GPUBindGroup>();
  private readonly perInvocation: number;
  private readonly targetBatchMs: number;
  private readonly maxBatch: number;
  /** Adaptive batch size, carried from frame to frame. */
  private batch: number;

  private constructor(
    private readonly device: GPUDevice,
    readonly job: OfflineJob,
    opts: RendererOptions,
  ) {
    this.gridWidth = job.width * job.ssaa;
    this.gridHeight = job.height * job.ssaa;
    this.total = totalParticles(job);
    this.path = new CameraPath(job.camera);
    this.perInvocation = Math.max(1, Math.min(4096, Math.floor(opts.perInvocation ?? 64)));
    this.targetBatchMs = opts.targetBatchMs ?? 250;
    this.maxBatch = Math.min(opts.maxBatch ?? 2 ** 30, 2 ** 30);
    this.batch = Math.min(opts.initialBatch ?? 2 ** 20, this.maxBatch);

    const bytes = this.gridWidth * this.gridHeight * 4;
    const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (bytes > limit) {
      throw new Error(
        `Accumulation grid needs ${bytes} bytes per word buffer but the device allows ${limit}. Lower ssaa or the resolution.`,
      );
    }
    const acc = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const read = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    this.accLo = device.createBuffer({ label: "offline accLo", size: bytes, usage: acc });
    this.accHi = device.createBuffer({ label: "offline accHi", size: bytes, usage: acc });
    this.readLo = device.createBuffer({ label: "offline readLo", size: bytes, usage: read });
    this.readHi = device.createBuffer({ label: "offline readHi", size: bytes, usage: read });
    this.tally = device.createBuffer({ label: "offline tally", size: 16, usage: acc });
    this.readTally = device.createBuffer({ label: "offline readTally", size: 16, usage: read });
    this.uniform = device.createBuffer({
      label: "offline batch",
      size: BATCH_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    void device.lost.then((info) => {
      this.lost = info.message || String(info.reason) || "device lost";
    });
  }

  /** The device needs limits large enough for the grid. See requiredLimits(). */
  static async create(device: GPUDevice, job: OfflineJob, opts: RendererOptions = {}): Promise<StatelessRenderer> {
    validateJob(job);
    const r = new StatelessRenderer(device, job, opts);
    const laws = [...new Set(job.planes.map((p) => p.law))];
    await Promise.all(
      laws.map(async (law) => {
        const module = device.createShaderModule({ label: `offline ${law}`, code: accumulateShader(law, job.splat) });
        const pipeline = await device.createComputePipelineAsync({
          label: `offline ${law}`,
          layout: "auto",
          compute: { module, entryPoint: "main" },
        });
        r.pipelines.set(law, pipeline);
        r.bindGroups.set(
          law,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: r.uniform } },
              { binding: 1, resource: { buffer: r.accLo } },
              { binding: 2, resource: { buffer: r.accHi } },
              { binding: 3, resource: { buffer: r.tally } },
            ],
          }),
        );
      }),
    );
    return r;
  }

  /** Limits to request from the adapter for this job. */
  static requiredLimits(job: OfflineJob, adapter: GPUAdapter): Record<string, number> {
    const bytes = job.width * job.height * job.ssaa * job.ssaa * 4;
    const want = Math.max(bytes, 134217728);
    return {
      maxBufferSize: Math.min(Math.max(want, 268435456), adapter.limits.maxBufferSize),
      maxStorageBufferBindingSize: Math.min(want, adapter.limits.maxStorageBufferBindingSize),
    };
  }

  /** Law time (seconds) at the middle of a frame's shutter. */
  frameTime(frame: number): number {
    return this.job.timeOffset + (frame / this.job.fps) * this.job.timeScale;
  }

  async renderFrame(frame: number, hooks: FrameHooks = {}): Promise<FrameResult> {
    const { device, job } = this;
    const t0 = now();
    const cam = cameraBasis(this.path.atFrame(frame, job.frames));
    const time = this.frameTime(frame);
    const shutterSpan = (job.shutter / job.fps) * job.timeScale;

    let cursor: FrameCursor = { plane: 0, offset: 0 };
    if (hooks.resume) {
      cursor = { ...hooks.resume.cursor };
      device.queue.writeBuffer(this.accLo, 0, hooks.resume.lo.buffer as ArrayBuffer, hooks.resume.lo.byteOffset, hooks.resume.lo.byteLength);
      device.queue.writeBuffer(this.accHi, 0, hooks.resume.hi.buffer as ArrayBuffer, hooks.resume.hi.byteOffset, hooks.resume.hi.byteLength);
      const { landed, gpuEvaluated } = hooks.resume;
      const words = [landed & 0xffffffffn, landed >> 32n, gpuEvaluated & 0xffffffffn, gpuEvaluated >> 32n].map(Number);
      device.queue.writeBuffer(this.tally, 0, new Uint32Array(words));
    } else {
      const enc = device.createCommandEncoder();
      enc.clearBuffer(this.accLo);
      enc.clearBuffer(this.accHi);
      enc.clearBuffer(this.tally);
      device.queue.submit([enc.finish()]);
    }

    let done = 0;
    for (let i = 0; i < cursor.plane; i++) done += job.planes[i].particleCount;
    done += cursor.offset;
    const startDone = done;

    const data = new ArrayBuffer(BATCH_UNIFORM_BYTES);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    let batches = 0;
    let lastCheckpoint = now();

    while (cursor.plane < job.planes.length) {
      if (hooks.signal?.aborted) throw new DOMException("Render cancelled", "AbortError");
      const plane = job.planes[cursor.plane];
      const left = plane.particleCount - cursor.offset;
      if (left <= 0) {
        cursor = { plane: cursor.plane + 1, offset: 0 };
        continue;
      }
      const count = Math.min(left, this.batch);

      // Dispatch geometry: a 2D grid of workgroups covering `count` particles.
      const invocations = Math.ceil(count / this.perInvocation);
      const groups = Math.ceil(invocations / WORKGROUP_SIZE);
      const gx = Math.min(groups, 1024);
      const gy = Math.ceil(groups / gx);

      const h = planeHomography(cam, plane, this.gridWidth, this.gridHeight);
      f32.set([h[0], h[1], h[2], 0, h[3], h[4], h[5], 0, h[6], h[7], h[8], 0], 0);
      f32.set(plane.params, 12);
      u32[20] = cursor.offset;
      u32[21] = count;
      u32[22] = plane.seed;
      u32[23] = this.perInvocation;
      u32[24] = gx * WORKGROUP_SIZE;
      u32[25] = this.gridWidth;
      u32[26] = this.gridHeight;
      u32[27] = 0;
      f32[28] = time;
      f32[29] = shutterSpan;
      f32[30] = job.weighting === "flux" ? job.fluxRef * job.fluxRef : 0;
      f32[31] = job.near;
      device.queue.writeBuffer(this.uniform, 0, data);

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipelines.get(plane.law)!);
      pass.setBindGroup(0, this.bindGroups.get(plane.law)!);
      pass.dispatchWorkgroups(gx, gy);
      pass.end();
      const tb = now();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (this.lost) throw new Error(`GPU device lost: ${this.lost}`);
      const ms = now() - tb;

      cursor = { plane: cursor.plane, offset: cursor.offset + count };
      done += count;
      batches++;
      hooks.onProgress?.(done, this.total, count, ms);

      // Steer the batch size toward the time target, at most 2x per step.
      // Only full-size batches are trusted: a plane's short tail says nothing.
      if (count === this.batch) {
        const factor = Math.min(2, Math.max(0.5, this.targetBatchMs / Math.max(ms, 0.01)));
        this.batch = Math.max(4096, Math.min(this.maxBatch, Math.round(this.batch * factor)));
      }

      if (hooks.checkpoint && now() - lastCheckpoint >= hooks.checkpoint.everyMs && done < this.total) {
        await hooks.checkpoint.save(cursor, await this.readAccumulation());
        lastCheckpoint = now();
      }
    }

    const acc = await this.readAccumulation();
    return { frame, ...acc, evaluated: done - startDone, batches, seconds: (now() - t0) / 1000 };
  }

  /** Copy the accumulation grid and tally back to the CPU. */
  async readAccumulation(): Promise<Accumulation> {
    const { device } = this;
    const bytes = this.gridWidth * this.gridHeight * 4;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.accLo, 0, this.readLo, 0, bytes);
    enc.copyBufferToBuffer(this.accHi, 0, this.readHi, 0, bytes);
    enc.copyBufferToBuffer(this.tally, 0, this.readTally, 0, 16);
    device.queue.submit([enc.finish()]);
    await Promise.all([
      this.readLo.mapAsync(GPUMapMode.READ),
      this.readHi.mapAsync(GPUMapMode.READ),
      this.readTally.mapAsync(GPUMapMode.READ),
    ]);
    if (this.lost) throw new Error(`GPU device lost: ${this.lost}`);
    const lo = new Uint32Array(this.readLo.getMappedRange().slice(0));
    const hi = new Uint32Array(this.readHi.getMappedRange().slice(0));
    const t = new Uint32Array(this.readTally.getMappedRange());
    const landed = BigInt(t[0]) + (BigInt(t[1]) << 32n);
    const gpuEvaluated = BigInt(t[2]) + (BigInt(t[3]) << 32n);
    this.readLo.unmap();
    this.readHi.unmap();
    this.readTally.unmap();
    return { lo, hi, landed, gpuEvaluated };
  }

  dispose(): void {
    for (const b of [this.uniform, this.accLo, this.accHi, this.readLo, this.readHi, this.tally, this.readTally]) b.destroy();
  }
}

/** Exact sum of the accumulation grid in weight units (ONE per full particle). */
export function accumulationSum(lo: Uint32Array, hi: Uint32Array): bigint {
  let total = 0n;
  const step = 1 << 16;
  for (let i = 0; i < lo.length; i += step) {
    let a = 0;
    let b = 0;
    const end = Math.min(lo.length, i + step);
    for (let j = i; j < end; j++) {
      a += lo[j];
      b += hi[j];
    }
    total += BigInt(a) + (BigInt(b) << 32n);
  }
  return total;
}

/** In count mode the grid sum divided by ONE is the exact number of particles in view. */
export function particlesInView(lo: Uint32Array, hi: Uint32Array): bigint {
  return accumulationSum(lo, hi) / BigInt(ONE);
}
