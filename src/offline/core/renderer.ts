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
import { ONE, totalParticles, unitsPerParticle, validateJob, type LawId, type OfflineJob, type OfflinePlane } from "./job";
import { cameraBasis, planeHomography, type CameraBasis } from "./math";
import { BATCH_UNIFORM_BYTES, WORKGROUP_SIZE, accumulateShader } from "./shaders";
import { TrillionKernel, type TrillionPlane } from "../../trillion/kernel";
import { OFFLINE_LAWS } from "../../trillion/offlineLaws";

/**
 * Which kernel adds particles to the grid.
 *   offline   this folder's accumulate shader: returning 64-bit atomics,
 *             per-particle flux weights as fine as the 64-bit grid allows,
 *             GPU-counted evaluated, landed and drawn.
 *   trillion  src/trillion's splat kernel: fire-and-forget u32 atomics folded
 *             into u64, shared-memory tiles for small sheets. Flux weighting
 *             becomes a per-sheet keep probability from the sheet center's
 *             depth, and evaluated is counted by the host from dispatch sizes.
 *             Camera motion blur is offline only: the trillion kernel projects
 *             every particle with the mid-shutter camera, so an A/B with a
 *             moving camera compares blurred against unblurred camera moves.
 * Both give exact integer grids. Run `bench --kernel both` to compare.
 */
export type KernelChoice = "offline" | "trillion";

export interface RendererOptions {
  /** Particles evaluated by one shader invocation in a loop. */
  perInvocation?: number;
  /** Aim for dispatches of about this long. */
  targetBatchMs?: number;
  /** First batch size. It adapts from there. */
  initialBatch?: number;
  /** Hard cap on particles per dispatch, at most 2^30. */
  maxBatch?: number;
  /** Default "offline". */
  kernel?: KernelChoice;
}

/** Where a partly rendered frame stopped: the next particle to evaluate. */
export interface FrameCursor {
  plane: number;
  offset: number;
}

/** The state of a frame: the light grid and the tallies. */
export interface Accumulation {
  /** Accumulation grid, low and high words, gridWidth * gridHeight each. */
  lo: Uint32Array;
  hi: Uint32Array;
  /**
   * Grid units a particle at full weight adds: ONE in count mode, finer in
   * flux mode (job.ts unitsPerParticle). develop() needs it to bring the grid
   * to ONE units; code that reads `lo` and `hi` directly must divide by it.
   */
  unitsPerParticle: number;
  /** Exact number of evaluated particles whose position fell inside the frame. */
  landed: bigint;
  /**
   * Exact number of those that added at least one unit of light, counted on
   * the GPU. Equal to `landed` in count mode. Lower in flux mode when weights
   * fall below one grid unit and are rounded to nothing at random, or with the
   * trillion kernel, which keeps a random share of a dim sheet's particles.
   */
  drawn: bigint;
  /**
   * Particles evaluated for this frame (includes work restored from a
   * checkpoint). Equals the world's total when the frame is done. Counted on
   * the GPU by the offline kernel; by the host from dispatch sizes with the
   * trillion kernel (see `evaluatedBy`).
   */
  gpuEvaluated: bigint;
}

/**
 * A grid and its tallies as a checkpoint holds them. The grid is in the units
 * of the renderer that saved it, which the job and kernel fix, so a checkpoint
 * does not carry them.
 */
export type SavedAccumulation = Omit<Accumulation, "unitsPerParticle">;

/**
 * The work a frame has cost so far. It travels with a checkpoint, so a frame
 * that was stopped and continued still reports its whole cost, not only the
 * last run's share.
 */
export interface FrameProgress {
  /** Wall seconds of rendering, summed over every run of this frame. */
  seconds: number;
  /** Dispatches, summed over every run of this frame. */
  batches: number;
  /** How many times the frame was continued from a checkpoint. */
  resumes: number;
}

export interface FrameHooks {
  /** Called after every batch. */
  onProgress?(done: number, total: number, batchSize: number, batchMs: number): void;
  /**
   * Start from a saved partial frame instead of from empty. Pass the progress
   * that was saved with it, or the frame's time and batch count start again
   * from zero and understate the frame.
   */
  resume?: { cursor: FrameCursor } & SavedAccumulation & Partial<FrameProgress>;
  /** Save a partial frame every `everyMs` so a crash loses little. */
  checkpoint?: { everyMs: number; save(cursor: FrameCursor, acc: Accumulation, progress: FrameProgress): Promise<void> };
  /**
   * Checked between batches. When aborted, renderFrame saves a checkpoint (if
   * checkpoint is set) and rejects with an AbortError.
   */
  signal?: AbortSignal;
  /** Hand the partial frame to a preview every `everyMs`. Costs one readback each time. */
  onPartial?: { everyMs: number; show(acc: Accumulation, done: number, total: number): void | Promise<void> };
}

export interface FrameResult extends Accumulation, FrameProgress {
  frame: number;
  /** Particles evaluated in this call (excludes work restored by a resume). */
  evaluated: number;
}

const now = (): number => performance.now();

/** The offline kernel's tally: landed, evaluated and drawn, 64 bits each. */
const TALLY_BYTES = 24;

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
  /** Set when the trillion kernel is in use. */
  private tk: TrillionKernel | null = null;
  private tkRead: GPUBuffer | null = null;
  readonly kernel: KernelChoice;
  /** Who counted `gpuEvaluated`. */
  get evaluatedBy(): "gpu" | "host" {
    return this.tk ? "host" : "gpu";
  }
  /** Grid units per full-weight particle. The trillion kernel counts whole particles, ONE each. */
  get unitsPerParticle(): number {
    return this.tk ? ONE : unitsPerParticle(this.job);
  }

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
    this.kernel = opts.kernel ?? "offline";

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
    this.tally = device.createBuffer({ label: "offline tally", size: TALLY_BYTES, usage: acc });
    this.readTally = device.createBuffer({ label: "offline readTally", size: TALLY_BYTES, usage: read });
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
    if (r.kernel === "trillion") {
      r.tk = await TrillionKernel.create(device, { width: r.gridWidth, height: r.gridHeight, laws: OFFLINE_LAWS });
      r.tkRead = device.createBuffer({
        label: "offline trillion read",
        size: r.gridWidth * r.gridHeight * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      return r;
    }
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
    // 8 bytes per grid cell covers the trillion kernel's u64 counts.
    const bytes = job.width * job.height * job.ssaa * job.ssaa * 8;
    const want = Math.max(bytes, 134217728);
    return {
      maxBufferSize: Math.min(Math.max(want, 268435456), adapter.limits.maxBufferSize),
      maxStorageBufferBindingSize: Math.min(want, adapter.limits.maxStorageBufferBindingSize),
      // The trillion kernel's shared-memory tiles.
      maxComputeWorkgroupStorageSize: Math.min(adapter.limits.maxComputeWorkgroupStorageSize, 32768 + 64),
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
    // Camera poses at shutter open and close, for camera motion blur.
    const span = job.frames > 1 ? job.shutter / (job.frames - 1) : 0;
    const tMid = job.frames > 1 ? frame / (job.frames - 1) : 0;
    const camOpen = cameraBasis(this.path.at(tMid - span / 2));
    const camClose = cameraBasis(this.path.at(tMid + span / 2));
    const time = this.frameTime(frame);
    const shutterSpan = (job.shutter / job.fps) * job.timeScale;

    let cursor: FrameCursor = { plane: 0, offset: 0 };
    const tk = this.tk;
    if (tk) {
      tk.settings.time = time;
      tk.settings.shutter = shutterSpan;
      tk.settings.salt = frame >>> 0;
      tk.settings.stochastic = job.splat === "bilinear";
      tk.settings.cull = false;
      const enc = device.createCommandEncoder();
      tk.clear(enc);
      device.queue.submit([enc.finish()]);
      tk.submitted();
      if (hooks.resume) {
        cursor = { ...hooks.resume.cursor };
        this.restoreTrillion(tk, hooks.resume);
      }
    } else if (hooks.resume) {
      cursor = { ...hooks.resume.cursor };
      device.queue.writeBuffer(this.accLo, 0, hooks.resume.lo.buffer as ArrayBuffer, hooks.resume.lo.byteOffset, hooks.resume.lo.byteLength);
      device.queue.writeBuffer(this.accHi, 0, hooks.resume.hi.buffer as ArrayBuffer, hooks.resume.hi.byteOffset, hooks.resume.hi.byteLength);
      const { landed, gpuEvaluated, drawn } = hooks.resume;
      const words = [landed, gpuEvaluated, drawn].flatMap((v) => [Number(v & 0xffffffffn), Number(v >> 32n)]);
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
    let lastPartial = now();
    // The frame's whole cost: what a checkpoint brought along plus this call.
    const before = hooks.resume;
    const progress = (): FrameProgress => ({
      seconds: (before?.seconds ?? 0) + (now() - t0) / 1000,
      batches: (before?.batches ?? 0) + batches,
      resumes: before ? (before.resumes ?? 0) + 1 : 0,
    });

    while (cursor.plane < job.planes.length) {
      if (hooks.signal?.aborted) {
        // Keep the work done so far: a cancelled frame resumes where it stopped.
        if (hooks.checkpoint && done > startDone) await hooks.checkpoint.save(cursor, await this.readAccumulation(), progress());
        throw new DOMException("Render cancelled", "AbortError");
      }
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

      const h = this.homography(cam, plane);
      if (tk) {
        const enc = device.createCommandEncoder();
        tk.encodeBatch(enc, { plane: this.trillionPlane(plane, h), start: cursor.offset, count });
        const tb = now();
        device.queue.submit([enc.finish()]);
        tk.submitted();
        await device.queue.onSubmittedWorkDone();
        if (this.lost) throw new Error(`GPU device lost: ${this.lost}`);
        const ms = now() - tb;
        cursor = { plane: cursor.plane, offset: cursor.offset + count };
        done += count;
        batches++;
        hooks.onProgress?.(done, this.total, count, ms);
        this.steer(count, ms);
        if (hooks.onPartial && now() - lastPartial >= hooks.onPartial.everyMs && done < this.total) {
          await hooks.onPartial.show(await this.readAccumulation(), done, this.total);
          lastPartial = now();
        }
        if (hooks.checkpoint && now() - lastCheckpoint >= hooks.checkpoint.everyMs && done < this.total) {
          await hooks.checkpoint.save(cursor, await this.readAccumulation(), progress());
          lastCheckpoint = now();
        }
        continue;
      }
      f32.set([h[0], h[1], h[2], 0, h[3], h[4], h[5], 0, h[6], h[7], h[8], 0], 0);
      f32.set(plane.params, 12);
      u32[20] = cursor.offset;
      u32[21] = count;
      u32[22] = plane.seed;
      u32[23] = this.perInvocation;
      u32[24] = gx * WORKGROUP_SIZE;
      u32[25] = this.gridWidth;
      u32[26] = this.gridHeight;
      f32[27] = this.unitsPerParticle;
      f32[28] = time;
      f32[29] = shutterSpan;
      f32[30] = job.weighting === "flux" ? job.fluxRef * job.fluxRef : 0;
      f32[31] = job.near;
      const ho = this.homography(camOpen, plane);
      const hc = this.homography(camClose, plane);
      const d = hc.map((v, i) => v - ho[i]);
      f32.set([d[0], d[1], d[2], 0, d[3], d[4], d[5], 0, d[6], d[7], d[8], 0], 32);
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
      this.steer(count, ms);

      if (hooks.onPartial && now() - lastPartial >= hooks.onPartial.everyMs && done < this.total) {
        await hooks.onPartial.show(await this.readAccumulation(), done, this.total);
        lastPartial = now();
      }
      if (hooks.checkpoint && now() - lastCheckpoint >= hooks.checkpoint.everyMs && done < this.total) {
        await hooks.checkpoint.save(cursor, await this.readAccumulation(), progress());
        lastCheckpoint = now();
      }
    }

    const acc = await this.readAccumulation();
    return { frame, ...acc, evaluated: done - startDone, ...progress() };
  }

  /** Steer the batch size toward the time target, at most 2x per step. */
  private steer(count: number, ms: number): void {
    const rate = count / Math.max(ms, 0.01);
    let next = this.batch;
    if (ms > this.targetBatchMs) {
      // Too slow, even for a short tail: shrink to what fits the target. This
      // keeps the watchdog margin when every batch is a sheet's tail.
      next = Math.min(this.batch, Math.floor(rate * this.targetBatchMs));
    } else if (count === this.batch) {
      // Only full-size batches are trusted to grow the batch, at most 2x.
      next = Math.min(2 * this.batch, Math.round(rate * this.targetBatchMs));
    }
    this.batch = Math.max(4096, Math.min(this.maxBatch, next));
  }

  /** One of this job's planes as the trillion kernel sees it this frame. */
  private trillionPlane(plane: OfflineJob["planes"][number], h: number[]): TrillionPlane {
    // Columns (c0, c1, c2) to rows: (px*w, py*w, w) = rows * (x, y, 1).
    const homography = [h[0], h[3], h[6], h[1], h[4], h[7], h[2], h[5], h[8]];
    // Flux: a per-sheet keep probability from the depth of the sheet's center.
    const depth = h[8];
    const keep = this.job.weighting === "flux" ? (depth > 0 ? Math.min(1, (this.job.fluxRef / depth) ** 2) : 1) : 1;
    return { law: plane.law, count: plane.particleCount, seed: plane.seed, params: plane.params, homography, near: this.job.near, keep };
  }

  /** Load a checkpoint into the trillion kernel's u64 counts and tally. */
  private restoreTrillion(tk: TrillionKernel, acc: SavedAccumulation): void {
    const cells = acc.lo.length;
    const counts = new Uint32Array(cells * 2);
    let sum = 0n;
    for (let i = 0; i < cells; i++) {
      // Grid units are ONE per particle with this kernel, so this is exact.
      const units = BigInt(acc.lo[i]) + (BigInt(acc.hi[i]) << 32n);
      const n = units / BigInt(ONE);
      counts[2 * i] = Number(n & 0xffffffffn);
      counts[2 * i + 1] = Number(n >> 32n);
      sum += n;
    }
    this.device.queue.writeBuffer(tk.counts, 0, counts);
    // Kernel tally: [0..1] counted (the grid sum), [2..3] in view.
    const split = (v: bigint) => [Number(v & 0xffffffffn), Number(v >> 32n)];
    this.device.queue.writeBuffer(tk.tallyBuffer, 0, new Uint32Array([...split(sum), ...split(acc.landed)]));
    tk.evaluated = Number(acc.gpuEvaluated);
  }

  /** The trillion kernel's u64 counts as grid units (ONE per particle). */
  private async readTrillion(tk: TrillionKernel, read: GPUBuffer): Promise<Accumulation> {
    const { device } = this;
    const cells = this.gridWidth * this.gridHeight;
    const enc = device.createCommandEncoder();
    tk.fold(enc);
    enc.copyBufferToBuffer(tk.counts, 0, read, 0, cells * 8);
    enc.copyBufferToBuffer(tk.tallyBuffer, 0, this.readTally, 0, 16);
    device.queue.submit([enc.finish()]);
    tk.submitted();
    await Promise.all([read.mapAsync(GPUMapMode.READ), this.readTally.mapAsync(GPUMapMode.READ)]);
    if (this.lost) throw new Error(`GPU device lost: ${this.lost}`);
    const c = new Uint32Array(read.getMappedRange());
    const lo = new Uint32Array(cells);
    const hi = new Uint32Array(cells);
    // units = count * 2^16, exact while a pixel holds fewer than 2^48 particles.
    for (let i = 0; i < cells; i++) {
      const clo = c[2 * i];
      const chi = c[2 * i + 1];
      lo[i] = (clo << 16) >>> 0;
      hi[i] = ((chi << 16) | (clo >>> 16)) >>> 0;
    }
    const t = new Uint32Array(this.readTally.getMappedRange());
    // Kernel tally: [0..1] particles it added to the grid, [2..3] in view.
    const drawn = BigInt(t[0]) + (BigInt(t[1]) << 32n);
    const landed = BigInt(t[2]) + (BigInt(t[3]) << 32n);
    read.unmap();
    this.readTally.unmap();
    return { lo, hi, unitsPerParticle: ONE, landed, drawn, gpuEvaluated: BigInt(tk.evaluated) };
  }

  /**
   * Sheet-to-grid homography, with the job's optional off-axis window applied
   * in doubles: px' = (px - x0) * sx, py' = (py - y0) * sy, depth unchanged.
   */
  private homography(cam: CameraBasis, plane: OfflinePlane): number[] {
    const w = this.job.window;
    if (!w) return planeHomography(cam, plane, this.gridWidth, this.gridHeight);
    const h = planeHomography(cam, plane, w.width, w.height);
    const sx = this.gridWidth / (w.x1 - w.x0);
    const sy = this.gridHeight / (w.y1 - w.y0);
    for (let c = 0; c < 9; c += 3) {
      h[c] = sx * (h[c] - w.x0 * h[c + 2]);
      h[c + 1] = sy * (h[c + 1] - w.y0 * h[c + 2]);
    }
    return h;
  }

  /** Copy the accumulation grid and tally back to the CPU. */
  async readAccumulation(): Promise<Accumulation> {
    if (this.tk && this.tkRead) return this.readTrillion(this.tk, this.tkRead);
    const { device } = this;
    const bytes = this.gridWidth * this.gridHeight * 4;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.accLo, 0, this.readLo, 0, bytes);
    enc.copyBufferToBuffer(this.accHi, 0, this.readHi, 0, bytes);
    enc.copyBufferToBuffer(this.tally, 0, this.readTally, 0, TALLY_BYTES);
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
    const drawn = BigInt(t[4]) + (BigInt(t[5]) << 32n);
    this.readLo.unmap();
    this.readHi.unmap();
    this.readTally.unmap();
    return { lo, hi, unitsPerParticle: this.unitsPerParticle, landed, drawn, gpuEvaluated };
  }

  dispose(): void {
    for (const b of [this.uniform, this.accLo, this.accHi, this.readLo, this.readHi, this.tally, this.readTally]) b.destroy();
    this.tk?.destroy();
    this.tkRead?.destroy();
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
