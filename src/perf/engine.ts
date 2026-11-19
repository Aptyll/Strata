/**
 * PerfEngine: the high particle count path.
 *
 * It runs the shared engine's own data model: planes are `PlaneDesc`, rules
 * are `Behavior` (src/core/contracts.ts), unchanged. What differs is how the
 * particles are stored and drawn:
 *
 *   1. CPU: classify every plane (frustum cull, particle LOD, rate LOD) and
 *      write one uniform slot per active plane.
 *   2. GPU: clear the atomic framebuffer, then one compute pass with one
 *      dispatch per active plane that simulates and rasterizes its particles.
 *   3. GPU: one fullscreen triangle resolves the framebuffer to the target.
 *
 * Particles are 8 bytes instead of 16, live in pages that fit default WebGPU
 * limits, and are never drawn with vertex buffers or point draw calls.
 */

import { BRUSH_FLOATS, MAX_BRUSHES, type Behavior, type PlaneDesc } from '../core/contracts';
import { compileComputePipeline } from '../gpu/context';
import { dispatchSize, packGlobals, packPlane, planeParamValues, type GlobalsValues } from '../gpu/shaderLib';
import { mat4Multiply, planeModelMatrix, seededRandom } from '../math';
import { classifyPlane, DEFAULT_LOD, type LodSettings, type PlaneClass } from './culling';
import { GpuTimer } from './gpuTimer';
import { BYTES_PER_PARTICLE, packPosition, packVelocity } from './packing';
import { ParticlePool, type ParticleRange } from './particlePool';
import {
  BLOCK_ALIGN,
  buildSimRasterWGSL,
  FLAG_BILINEAR,
  FLAG_DRAW,
  FLAG_SIM,
  GLOBALS_BLOCK_SIZE,
  INIT_WGSL,
  LIGHT_ONE,
  packPerf,
  PERF_BLOCK_SIZE,
  PLANE_BLOCK_SIZE,
  RESOLVE_WGSL,
  SLOT_STRIDE,
} from './shaders';

export interface PerfEngineOptions {
  /** Format of the texture views passed to frame(). */
  format: GPUTextureFormat;
  /**
   * 'tonemap': write the finished white-on-black image (default).
   * 'hdr': add linear light to a float target, for engines that tonemap later.
   */
  output?: 'tonemap' | 'hdr';
  /** With output 'hdr': clear the target first (default true). */
  clearTarget?: boolean;
  /** Particles per storage page. Clamped to device limits. */
  pageParticles?: number;
  /**
   * Largest speed (sheet units per second) the packed velocity can hold.
   * Faster particles are clamped. Default 4, per behavior id overrides allowed.
   */
  velMax?: number;
  velMaxByBehavior?: Record<string, number>;
  lod?: Partial<LodSettings>;
}

interface PlaneRec extends ParticleRange {
  id: number;
  desc: PlaneDesc;
  behavior: Behavior;
  pipeline: GPUComputePipeline;
  model: Float32Array;
  params: Float32Array;
  velMax: number;
  /** Time not yet simulated, so LOD intervals integrate the right dt. */
  pendingDt: number;
}

export interface FrameParams {
  /** Column-major view-projection matrix (WebGPU clip space, z in [0, 1]). */
  viewProj: ArrayLike<number>;
  /** Seconds since last frame. */
  dt: number;
  /** Absolute time in seconds, for time-dependent behaviors. */
  time: number;
  /** Where the resolve pass draws. Must match the engine's size and format. */
  target: GPUTextureView;
}

export interface FrameStats {
  planes: number;
  visiblePlanes: number;
  /** Dispatches issued this frame (one per active plane). */
  dispatches: number;
  totalParticles: number;
  drawnParticles: number;
  simulatedParticles: number;
  /** Latest GPU pass times in ms (0 when timestamp-query is unavailable). */
  gpuComputeMs: number;
  gpuResolveMs: number;
}

/** Largest single step a plane will integrate, so long LOD gaps stay stable. */
const MAX_STEP_DT = 0.1;
const UPLOAD_CHUNK_PARTICLES = 1 << 20;

/**
 * Works on any GPUDevice. When the device has 'timestamp-query' (for example
 * from `requestGpuDevice({ timestamps: true })` in src/gpu/context.ts), it
 * also reports GPU pass times in `stats`.
 */
export class PerfEngine {
  readonly pool: ParticlePool;
  readonly lod: LodSettings;
  readonly stats: FrameStats = {
    planes: 0,
    visiblePlanes: 0,
    dispatches: 0,
    totalParticles: 0,
    drawnParticles: 0,
    simulatedParticles: 0,
    gpuComputeMs: 0,
    gpuResolveMs: 0,
  };

  /** Advance the simulation. When false, particles are only drawn. */
  simulate = true;
  /** Rasterize particles. When false, particles are only simulated (for profiling). */
  draw = true;
  /** 2x2 bilinear splats: smoother motion, about 4x the framebuffer writes. */
  bilinear = false;
  /** Light added per particle per pixel before tonemapping (Scene.render.brightness). */
  brightness = 0.2;
  /**
   * Pointer brushes, packed like the core Globals (MAX_BRUSHES x BRUSH_FLOATS
   * floats). All zero means no brush. Write into it before frame().
   */
  readonly brushes = new Float32Array(MAX_BRUSHES * BRUSH_FLOATS);

  private readonly planes = new Map<number, PlaneRec>();
  private nextId = 1;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly initPipeline: GPUComputePipeline;
  private readonly resolvePipeline: GPURenderPipeline;
  private readonly resolveUniform: GPUBuffer;
  private readonly timer: GpuTimer;
  private readonly clearTarget: boolean;

  /** One SLOT_STRIDE slot per dispatched plane (see ./shaders.ts), packed on the CPU into uniformData. */
  private uniformBuffer!: GPUBuffer;
  private uniformData!: ArrayBuffer;
  private uniformView!: DataView;
  private uniformSlots = 0;

  private fb!: GPUBuffer;
  private width = 1;
  private height = 1;
  private pageBindGroups: (GPUBindGroup | undefined)[] = [];
  private resolveBindGroup!: GPUBindGroup;

  private frameIndex = 0;
  private readonly mvp = new Float32Array(16);
  private readonly cls: PlaneClass = { visible: true, fraction: 1, simInterval: 1, areaPx: 0 };
  private dispatchPlanes: PlaneRec[] = [];
  private dispatchCounts: number[] = [];
  private readonly offsets = [0, 0, 0];

  constructor(
    readonly device: GPUDevice,
    private readonly options: PerfEngineOptions,
  ) {
    this.lod = { ...DEFAULT_LOD, ...options.lod };
    this.pool = new ParticlePool(device, options.pageParticles);
    this.timer = new GpuTimer(device, 2);
    this.clearTarget = options.clearTarget ?? true;

    const uniform = (binding: number, minBindingSize: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize },
    });
    this.layout = device.createBindGroupLayout({
      label: 'strata-perf plane',
      entries: [
        uniform(0, GLOBALS_BLOCK_SIZE),
        uniform(1, PLANE_BLOCK_SIZE),
        uniform(2, PERF_BLOCK_SIZE),
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.initPipeline = compileComputePipeline(device, 'strata-perf init', INIT_WGSL, this.pipelineLayout);

    const hdr = options.output === 'hdr';
    const resolveModule = device.createShaderModule({ code: RESOLVE_WGSL });
    this.resolvePipeline = device.createRenderPipeline({
      label: 'strata-perf resolve',
      layout: 'auto',
      vertex: { module: resolveModule, entryPoint: 'vs' },
      fragment: {
        module: resolveModule,
        entryPoint: hdr ? 'fsHdr' : 'fsTonemap',
        targets: [
          hdr
            ? {
                format: options.format,
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'one' },
                  alpha: { srcFactor: 'one', dstFactor: 'one' },
                },
              }
            : { format: options.format },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.resolveUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.ensureUniformSlots(64);
    this.resize(1, 1);
  }

  get planeCount(): number {
    return this.planes.size;
  }

  get particleCount(): number {
    return this.pool.particleCount;
  }

  /** GPU memory held by particle pages, in bytes. */
  get particleBytes(): number {
    return this.pool.byteSize;
  }

  get hasGpuTimer(): boolean {
    return this.timer.supported;
  }

  /** Resize the atomic framebuffer. Call with the target's pixel size. */
  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (this.fb && width === this.width && height === this.height) return;
    this.fb?.destroy();
    this.width = width;
    this.height = height;
    this.fb = this.device.createBuffer({
      label: 'strata-perf atomic framebuffer',
      size: width * height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.pageBindGroups = [];
    this.resolveBindGroup = this.device.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.resolveUniform } },
        { binding: 1, resource: { buffer: this.fb } },
      ],
    });
  }

  /**
   * Adds a plane and seeds its particles. Returns a handle for updatePlane
   * and removePlane. Planes larger than one page are capped, like the core
   * engine caps at its buffer limit.
   */
  addPlane(desc: PlaneDesc, behavior: Behavior): number {
    const count = Math.min(Math.max(1, Math.floor(desc.particleCount)), this.pool.maxRange);
    if (count < desc.particleCount) {
      console.warn(`perf: plane capped at ${count} particles by the page size (asked for ${desc.particleCount}).`);
    }
    const range = this.pool.allocate(count);
    const id = this.nextId++;
    const plane: PlaneRec = {
      ...range,
      id,
      desc,
      behavior,
      pipeline: this.pipelineFor(behavior),
      model: new Float32Array(16),
      params: new Float32Array(8),
      velMax: this.options.velMaxByBehavior?.[behavior.id] ?? this.options.velMax ?? 4,
      pendingDt: 0,
    };
    this.planes.set(id, plane);
    this.applyDesc(plane);
    this.ensureUniformSlots(this.planes.size);
    if (behavior.init) this.seedFromCpu(plane);
    else this.seedOnGpu(plane);
    return id;
  }

  /** Call after changing a plane's transform, params or brightness. */
  updatePlane(id: number, desc?: PlaneDesc): void {
    const plane = this.planes.get(id);
    if (!plane) return;
    if (desc) plane.desc = desc;
    this.applyDesc(plane);
  }

  /** Removes a plane; its particle range is reused by later planes. */
  removePlane(id: number): void {
    const plane = this.planes.get(id);
    if (!plane) return;
    this.pool.release(plane);
    this.planes.delete(id);
  }

  /** Removes every plane. Pages are kept for reuse. */
  clear(): void {
    for (const id of [...this.planes.keys()]) this.removePlane(id);
  }

  /** Replaces the world, like the core engine's Simulation.setPlanes. */
  setPlanes(descs: readonly PlaneDesc[], getBehavior: (id: string) => Behavior): number[] {
    this.clear();
    return descs.map((d) => this.addPlane(d, getBehavior(d.behaviorId)));
  }

  /** Simulates, rasterizes and resolves one frame, then submits it. */
  frame(p: FrameParams): FrameStats {
    const encoder = this.device.createCommandEncoder({ label: 'strata-perf frame' });
    this.encode(encoder, p);
    this.timer.resolve(encoder);
    this.device.queue.submit([encoder.finish()]);
    this.timer.readback();
    this.stats.gpuComputeMs = this.timer.ms[0];
    this.stats.gpuResolveMs = this.timer.ms[1];
    return this.stats;
  }

  /** Encodes one frame into a caller-owned encoder (for frame graphs and capture). */
  encode(encoder: GPUCommandEncoder, p: FrameParams): FrameStats {
    const { device, lod, stats } = this;
    const frame = this.frameIndex++;
    const active = this.dispatchPlanes;
    const counts = this.dispatchCounts;
    active.length = 0;
    counts.length = 0;
    let visible = 0;
    let drawn = 0;
    let simulated = 0;
    const baseFlags = this.bilinear ? FLAG_BILINEAR : 0;
    // Every slot's Globals block holds these values; only dt differs per plane.
    const globals: GlobalsValues = {
      viewProj: p.viewProj,
      time: p.time,
      dt: 0,
      frame,
      brightness: this.brightness,
      brushes: this.brushes,
    };

    for (const plane of this.planes.values()) {
      plane.pendingDt += p.dt;
      mat4Multiply(this.mvp, p.viewProj, plane.model);
      const c = classifyPlane(this.mvp, plane.count, this.width, this.height, lod, this.cls);

      const planeBrightness = plane.desc.brightness ?? 1;
      // The LOD prefix of a plane in view: what a drawn frame draws, and with
      // simulateHidden off also all that is simulated. It must not depend on
      // `draw`, or a sim-only frame (draw off) would simulate no visible plane.
      const lodCount =
        c.visible && planeBrightness > 0 ? Math.max(1, Math.min(plane.count, Math.floor(plane.count * c.fraction))) : 0;
      if (lodCount > 0) visible++;
      const drawCount = this.draw ? lodCount : 0;
      // Stagger by plane id so planes on the same interval do not all land on one frame.
      const doSim = this.simulate && c.simInterval > 0 && (frame + plane.id) % c.simInterval === 0;
      const simCount = doSim ? (c.visible && !lod.simulateHidden ? lodCount : plane.count) : 0;
      if (drawCount === 0 && simCount === 0) continue;

      let dt = 0;
      if (doSim) {
        dt = Math.min(plane.pendingDt, MAX_STEP_DT);
        plane.pendingDt = 0;
      }
      const weight = drawCount > 0 ? Math.max(1, Math.round((LIGHT_ONE * planeBrightness * plane.count) / drawCount)) : 0;
      const flags = baseFlags | (doSim ? FLAG_SIM : 0) | (drawCount > 0 ? FLAG_DRAW : 0);
      const processed = Math.max(drawCount, simCount);

      // This dispatch's uniform slot: the engine's Globals and Plane blocks
      // (src/gpu/shaderLib.ts), then this path's Perf block (./shaders.ts).
      const at = active.length * SLOT_STRIDE;
      globals.dt = dt; // a plane on a rate-LOD interval steps the time since its own last step
      packGlobals(this.uniformView, at, globals);
      packPlane(this.uniformView, at + BLOCK_ALIGN, {
        model: plane.model,
        params: plane.params,
        count: processed,
        seed: plane.desc.seed,
        brightness: planeBrightness,
      });
      packPerf(this.uniformView, at + 2 * BLOCK_ALIGN, {
        mvp: this.mvp,
        base: plane.base,
        drawCount,
        simCount,
        weight,
        flags,
        fbWidth: this.width,
        fbHeight: this.height,
        velMax: plane.velMax,
      });
      active.push(plane);
      counts.push(processed);
      drawn += drawCount;
      simulated += simCount;
    }

    const n = active.length;
    if (n > 0) device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, n * SLOT_STRIDE);
    const ru = new ArrayBuffer(16);
    new Uint32Array(ru, 0, 2).set([this.width, this.height]);
    new Float32Array(ru, 8, 1)[0] = this.brightness;
    device.queue.writeBuffer(this.resolveUniform, 0, ru);

    encoder.clearBuffer(this.fb);

    const compute = encoder.beginComputePass({ label: 'strata-perf sim+raster', timestampWrites: this.timer.writes(0) });
    let current: GPUComputePipeline | null = null;
    for (let k = 0; k < n; k++) {
      const plane = active[k];
      if (plane.pipeline !== current) {
        current = plane.pipeline;
        compute.setPipeline(current);
      }
      this.offsets[0] = this.offsets[1] = this.offsets[2] = k * SLOT_STRIDE;
      compute.setBindGroup(0, this.bindGroupFor(plane.page), this.offsets);
      const [gx, gy] = dispatchSize(counts[k]);
      compute.dispatchWorkgroups(gx, gy);
    }
    compute.end();

    const hdr = this.options.output === 'hdr';
    const render = encoder.beginRenderPass({
      label: 'strata-perf resolve',
      colorAttachments: [
        {
          view: p.target,
          loadOp: hdr && !this.clearTarget ? 'load' : 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      timestampWrites: this.timer.writes(1),
    });
    render.setPipeline(this.resolvePipeline);
    render.setBindGroup(0, this.resolveBindGroup);
    render.draw(3);
    render.end();

    stats.planes = this.planes.size;
    stats.visiblePlanes = visible;
    stats.dispatches = n;
    stats.totalParticles = this.pool.particleCount;
    stats.drawnParticles = drawn;
    stats.simulatedParticles = simulated;
    return stats;
  }

  /** Debug and tests: copy the atomic framebuffer of the last frame back to the CPU. */
  async readFramebuffer(): Promise<Uint32Array> {
    return this.readBuffer(this.fb, 0, this.width * this.height * 4);
  }

  /** Debug and tests: read back packed particles of one plane (count capped). */
  async readParticles(id: number, maxCount = 1024): Promise<Uint32Array> {
    const plane = this.planes.get(id)!;
    const size = Math.min(plane.count, maxCount) * BYTES_PER_PARTICLE;
    return this.readBuffer(this.pool.pages[plane.page].buffer, plane.base * BYTES_PER_PARTICLE, size);
  }

  destroy(): void {
    this.pool.destroy();
    this.fb.destroy();
    this.uniformBuffer.destroy();
    this.resolveUniform.destroy();
    this.timer.destroy();
    this.planes.clear();
    this.pageBindGroups = [];
  }

  private async readBuffer(src: GPUBuffer, offset: number, size: number): Promise<Uint32Array> {
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, offset, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  private applyDesc(plane: PlaneRec): void {
    const d = plane.desc;
    planeModelMatrix(d, plane.model);
    planeParamValues(plane.behavior, d.params, plane.params);
  }

  private pipelineFor(behavior: Behavior): GPUComputePipeline {
    let pipeline = this.pipelines.get(behavior.id);
    if (!pipeline) {
      pipeline = compileComputePipeline(this.device, `perf:${behavior.id}`, buildSimRasterWGSL(behavior), this.pipelineLayout);
      this.pipelines.set(behavior.id, pipeline);
    }
    return pipeline;
  }

  /** Default seeding: uniform random at rest, entirely on the GPU. */
  private seedOnGpu(plane: PlaneRec): void {
    // INIT_WGSL reads only the Perf block: base, simCount, and the plane's u32 seed carried in weight.
    packPerf(this.uniformView, 2 * BLOCK_ALIGN, {
      mvp: this.mvp, // unused by INIT_WGSL
      base: plane.base,
      drawCount: 0,
      simCount: plane.count,
      weight: Math.floor(plane.desc.seed * 0xffffffff) >>> 0,
      flags: 0,
      fbWidth: this.width,
      fbHeight: this.height,
      velMax: plane.velMax,
    });
    // One submit per plane keeps slot 0 valid for each dispatch.
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, SLOT_STRIDE);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.initPipeline);
    pass.setBindGroup(0, this.bindGroupFor(plane.page), [0, 0, 0]);
    pass.dispatchWorkgroups(...dispatchSize(plane.count));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Behaviors with their own init() run it on the CPU; the result is packed and uploaded in chunks. */
  private seedFromCpu(plane: PlaneRec): void {
    const data = new Float32Array(plane.count * 4);
    plane.behavior.init!(data, plane.count, seededRandom(Math.floor(plane.desc.seed * 0xffffffff)));
    const buffer = this.pool.pages[plane.page].buffer;
    const chunk = new Uint32Array(Math.min(plane.count, UPLOAD_CHUNK_PARTICLES) * 2);
    for (let start = 0; start < plane.count; start += UPLOAD_CHUNK_PARTICLES) {
      const n = Math.min(UPLOAD_CHUNK_PARTICLES, plane.count - start);
      for (let i = 0; i < n; i++) {
        const s = (start + i) * 4;
        chunk[i * 2] = packPosition(data[s], data[s + 1]);
        chunk[i * 2 + 1] = packVelocity(data[s + 2], data[s + 3], plane.velMax);
      }
      this.device.queue.writeBuffer(buffer, (plane.base + start) * BYTES_PER_PARTICLE, chunk, 0, n * 2);
    }
  }

  private ensureUniformSlots(slots: number): void {
    if (slots <= this.uniformSlots) return;
    let cap = Math.max(64, this.uniformSlots);
    while (cap < slots) cap *= 2;
    this.uniformBuffer?.destroy();
    this.uniformSlots = cap;
    this.uniformData = new ArrayBuffer(cap * SLOT_STRIDE);
    this.uniformView = new DataView(this.uniformData);
    this.uniformBuffer = this.device.createBuffer({
      label: 'strata-perf plane uniforms',
      size: cap * SLOT_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pageBindGroups = [];
  }

  private bindGroupFor(page: number): GPUBindGroup {
    let bg = this.pageBindGroups[page];
    if (!bg) {
      const u = this.uniformBuffer;
      bg = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: u, offset: 0, size: GLOBALS_BLOCK_SIZE } },
          { binding: 1, resource: { buffer: u, offset: BLOCK_ALIGN, size: PLANE_BLOCK_SIZE } },
          { binding: 2, resource: { buffer: u, offset: BLOCK_ALIGN * 2, size: PERF_BLOCK_SIZE } },
          { binding: 3, resource: { buffer: this.pool.pages[page].buffer } },
          { binding: 4, resource: { buffer: this.fb } },
        ],
      });
      this.pageBindGroups[page] = bg;
    }
    return bg;
  }
}
