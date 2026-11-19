/**
 * GPU time of every pass in the frame graph, through `timestamp-query`.
 *
 * WebGPU writes timestamps only at the start and the end of a GPU pass, and
 * only when the pass descriptor asks for them. The app's passes know nothing
 * about timing, so this FrameObserver (src/core/frameGraph.ts) hands each of
 * them an encoder that adds the two timestamp writes to every compute and
 * render pass it begins. Nothing else about the pass changes.
 *
 * Same query set, resolve and readback steps as GpuTimer in
 * src/perf/gpuTimer.ts, which times a fixed set of passes it owns. This one
 * serves a whole graph: the number of GPU passes varies from frame to frame,
 * and every reading is tagged with the graph pass that began it, so a
 * rasterizer switch is never credited to the wrong row.
 *
 * While `enabled` is false it does nothing at all: no proxy, no queries.
 * Chrome rounds timestamps to 0.1 ms unless "WebGPU Developer Features" is
 * switched on, so single readings are coarse. Average them.
 */
import type { FrameContext, Pass, PassStage } from "../../core/contracts";
import type { FrameObserver } from "../../core/frameGraph";

/** GPU passes timed per frame. The app begins about a dozen; more than this go untimed and the result says so. */
export const MAX_TIMED_PASSES = 64;
/** Readbacks take a frame or three to come back, so a few buffers rotate. */
const READ_BUFFERS = 4;
/** One timestamp is a u64 of nanoseconds; a GPU pass has two. */
const BYTES_PER_PASS = 16;

export interface PassTime {
  /** `Pass.name` and `Pass.stage` of the graph pass. */
  name: string;
  stage: PassStage;
  /** GPU milliseconds inside the GPU passes this graph pass began. */
  ms: number;
  /** How many GPU passes it began. */
  gpuPasses: number;
}

export interface GpuFrameTime {
  /** In execution order. Graph passes that began no GPU pass are left out. */
  passes: PassTime[];
  /** Sum of `passes`: GPU time spent inside passes. */
  totalMs: number;
  /** First pass start to last pass end. Also covers the clears and copies between passes. */
  spanMs: number;
  /** True when the frame began more GPU passes than MAX_TIMED_PASSES, so some are missing. */
  truncated: boolean;
}

interface Owner {
  name: string;
  stage: PassStage;
}

/** Turns raw timestamps (begin, end per GPU pass) into per-pass times. Exported for the verify case. */
export function collectPassTimes(
  timestamps: BigUint64Array,
  owners: readonly Owner[],
  truncated: boolean,
): GpuFrameTime | null {
  const passes: PassTime[] = [];
  let first = 0n;
  let last = 0n;
  let totalMs = 0;
  for (let i = 0; i < owners.length; i++) {
    const begin = timestamps[2 * i];
    const end = timestamps[2 * i + 1];
    // Zero means the query was never written; a backwards or absurd pair is a reading to drop.
    if (begin === 0n || end < begin) continue;
    const ms = Number(end - begin) / 1e6;
    if (ms > 10_000) continue;
    const owner = owners[i];
    let row = passes[passes.length - 1];
    if (!row || row.name !== owner.name) {
      row = { name: owner.name, stage: owner.stage, ms: 0, gpuPasses: 0 };
      passes.push(row);
    }
    row.ms += ms;
    row.gpuPasses++;
    totalMs += ms;
    if (first === 0n || begin < first) first = begin;
    if (end > last) last = end;
  }
  if (passes.length === 0) return null;
  return { passes, totalMs, spanMs: Number(last - first) / 1e6, truncated };
}

export class PassTimer implements FrameObserver {
  /** Time frames only while true. Off by default. */
  enabled = false;
  /** Called with each finished measurement, a frame or three after the frame it belongs to. */
  onResult: ((time: GpuFrameTime) => void) | null = null;

  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly free: GPUBuffer[] = [];
  private created = 0;
  private failed = false;

  // State of the frame being encoded.
  private encoder: GPUCommandEncoder | null = null;
  private proxy: GPUCommandEncoder | null = null;
  private input: FrameContext | null = null;
  private timed: FrameContext | null = null;
  private current: Owner | null = null;
  private readonly owners: Owner[] = [];
  private used = 0;
  private overflow = false;
  private pending: { buffer: GPUBuffer; owners: Owner[]; truncated: boolean } | null = null;

  constructor(private readonly device: GPUDevice) {
    if (!device.features.has("timestamp-query")) return;
    this.querySet = device.createQuerySet({ label: "perf-hud pass times", type: "timestamp", count: MAX_TIMED_PASSES * 2 });
    this.resolveBuffer = device.createBuffer({
      label: "perf-hud pass times",
      size: MAX_TIMED_PASSES * BYTES_PER_PASS,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    device.addEventListener("uncapturederror", this.onGpuError);
  }

  /** False without the `timestamp-query` feature, or after a GPU error turned timing off. */
  get supported(): boolean {
    return this.querySet !== null && !this.failed;
  }

  /** True when a GPU validation error arrived while timing and switched it off for the session. */
  get stopped(): boolean {
    return this.failed;
  }

  beforePass(pass: Pass, frame: FrameContext): FrameContext {
    if (!this.enabled || !this.supported) return frame;
    if (frame.encoder !== this.encoder) {
      // First pass of a new frame.
      this.encoder = frame.encoder;
      this.proxy = new Proxy(frame.encoder, this.handler);
      this.used = 0;
      this.overflow = false;
      this.input = null;
      // A frame that threw before it was submitted never used its readback buffer.
      if (this.pending) this.free.push(this.pending.buffer);
      this.pending = null;
    }
    if (frame !== this.input) {
      this.input = frame;
      this.timed = { ...frame, encoder: this.proxy! };
    }
    this.current = pass;
    return this.timed!;
  }

  beforeSubmit(): void {
    const { encoder, querySet, resolveBuffer, used } = this;
    this.current = null;
    if (!encoder || !querySet || !resolveBuffer || used === 0) return;
    encoder.resolveQuerySet(querySet, 0, used * 2, resolveBuffer, 0);
    const buffer = this.free.pop() ?? this.createReadBuffer();
    if (!buffer) return; // every readback buffer is still on its way back: skip this frame
    encoder.copyBufferToBuffer(resolveBuffer, 0, buffer, 0, used * BYTES_PER_PASS);
    this.pending = { buffer, owners: this.owners.slice(0, used), truncated: this.overflow };
  }

  afterSubmit(): void {
    const pending = this.pending;
    this.pending = null;
    this.encoder = this.proxy = null;
    this.input = this.timed = null;
    this.used = 0;
    if (!pending) return;
    const { buffer, owners, truncated } = pending;
    const bytes = owners.length * BYTES_PER_PASS;
    buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(
      () => {
        const result = collectPassTimes(new BigUint64Array(buffer.getMappedRange(0, bytes)), owners, truncated);
        buffer.unmap();
        this.free.push(buffer);
        if (result && !this.failed) this.onResult?.(result);
      },
      () => {
        // The device was lost or the buffer destroyed. Let a later frame make a fresh one.
        buffer.destroy();
        this.created--;
      },
    );
  }

  dispose(): void {
    this.enabled = false;
    this.device.removeEventListener("uncapturederror", this.onGpuError);
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    for (const b of this.free) b.destroy();
    this.free.length = 0;
  }

  /**
   * The encoder a pass sees. Every member reaches the real encoder; only the
   * two calls that begin a GPU pass get timestamp writes added on the way.
   * WebGPU objects reject calls made through a proxy, so methods are bound to
   * the real encoder, and attributes are read and written on it directly.
   */
  private readonly handler: ProxyHandler<GPUCommandEncoder> = {
    get: (target, prop) => {
      if (prop === "beginComputePass") {
        return (descriptor?: GPUComputePassDescriptor) => target.beginComputePass(this.stamp(descriptor));
      }
      if (prop === "beginRenderPass") {
        return (descriptor: GPURenderPassDescriptor) => target.beginRenderPass(this.stamp(descriptor));
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, prop, value) => Reflect.set(target, prop, value, target),
  };

  /** The descriptor plus timestamp writes into the next free pair of queries. */
  private stamp<D extends GPUComputePassDescriptor | GPURenderPassDescriptor>(descriptor: D | undefined): D {
    const { querySet, current } = this;
    // A pass that times itself keeps its own queries.
    if (!querySet || !current || descriptor?.timestampWrites) return descriptor as D;
    if (this.used >= MAX_TIMED_PASSES) {
      this.overflow = true;
      return descriptor as D;
    }
    const slot = this.used++;
    this.owners[slot] = current;
    const timestampWrites = { querySet, beginningOfPassWriteIndex: slot * 2, endOfPassWriteIndex: slot * 2 + 1 };
    return { ...descriptor, timestampWrites } as D;
  }

  private createReadBuffer(): GPUBuffer | null {
    if (this.created >= READ_BUFFERS) return null;
    this.created++;
    return this.device.createBuffer({
      label: "perf-hud pass times readback",
      size: MAX_TIMED_PASSES * BYTES_PER_PASS,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /**
   * Safety net. A wrong timestamp write would invalidate the whole frame's
   * commands, so if any validation error surfaces while timing is on, timing
   * stops for the session and frames go back to being untouched. The error
   * itself still reaches the console as usual.
   */
  private readonly onGpuError = (event: Event): void => {
    if (!this.enabled || this.failed) return;
    const error = (event as GPUUncapturedErrorEvent).error;
    if (!(error instanceof GPUValidationError)) return;
    this.failed = true;
    this.enabled = false;
    console.warn("[perf-hud] A GPU validation error arrived while pass timing was on. Pass timing is off for this session.");
  };
}
