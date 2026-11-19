/**
 * PerfEngine: the high particle count path.
 *
 * Per frame:
 *   1. CPU: classify every plane (frustum cull, particle LOD, rate LOD) and
 *      write one 256-byte uniform slot per active plane.
 *   2. GPU: clear the atomic framebuffer, then one compute pass with one
 *      dispatch per active plane that simulates and rasterizes its particles.
 *   3. GPU: one fullscreen triangle resolves the framebuffer to the target.
 *
 * There are no vertex buffers and no per-particle draw calls anywhere.
 */

import { classifyPlane, DEFAULT_LOD, type LodSettings, type PlaneClass } from './culling';
import { GpuTimer } from './gpuTimer';
import { mat4Multiply } from './math';
import { BYTES_PER_PARTICLE } from './packing';
import { ParticlePool, type ParticleRange } from './particlePool';
import {
  BUILTIN_BEHAVIORS,
  buildSimRasterWGSL,
  FLAG_BILINEAR,
  FLAG_DRAW,
  FLAG_SIM,
  INIT_PATTERNS,
  INIT_VELOCITIES,
  INIT_WGSL,
  PLANE_UNIFORM_SIZE,
  PLANE_UNIFORM_STRIDE,
  RESOLVE_WGSL,
  WEIGHT_ONE,
  WORKGROUP_SIZE,
  type Behavior,
  type InitPattern,
  type InitVelocity,
} from './shaders';

export interface PerfEngineOptions {
  /** Format of the texture views passed to frame(). */
  format: GPUTextureFormat;
  /** Behaviors compiled into the pipeline. Defaults to BUILTIN_BEHAVIORS. */
  behaviors?: Behavior[];
  /** Particles per storage page. Clamped to device limits. */
  pageParticles?: number;
  lod?: Partial<LodSettings>;
}

export interface PlaneDesc {
  count: number;
  /** Column-major model matrix: maps the unit square [-0.5, 0.5]^2 (z = 0) to world space. */
  model: ArrayLike<number>;
  /** Behavior name. Defaults to the first behavior. */
  behavior?: string;
  /** These default to the behavior's own settings. */
  params?: [number, number, number, number];
  velMax?: number;
  damping?: number;
  init?: InitPattern;
  initVelocity?: InitVelocity;
  /** Brightness multiplier, 1 = default. */
  intensity?: number;
  seed?: number;
}

interface PlaneRec extends ParticleRange {
  id: number;
  model: Float32Array;
  behavior: number;
  params: [number, number, number, number];
  velMax: number;
  damping: number;
  intensity: number;
  seed: number;
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

/**
 * Requests a device with the limits and features the perf path can use.
 * Everything here is optional: the engine also works on a default device.
 */
export async function requestPerfDevice(opts: { timestamps?: boolean } = {}): Promise<GPUDevice> {
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const requiredFeatures: GPUFeatureName[] = [];
  if (opts.timestamps !== false && adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
  return adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
}

export class PerfEngine {
  readonly pool: ParticlePool;
  readonly behaviors: Behavior[];
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
  /** 2x2 bilinear splats: smoother motion, about 4x the framebuffer writes. */
  bilinear = false;
  exposure = 1;
  gamma = 1;

  private readonly planes: PlaneRec[] = [];
  private readonly layout: GPUBindGroupLayout;
  private readonly simPipeline: GPUComputePipeline;
  private readonly initPipeline: GPUComputePipeline;
  private readonly resolvePipeline: GPURenderPipeline;
  private readonly resolveUniform: GPUBuffer;
  private readonly timer: GpuTimer;

  private uniformBuffer!: GPUBuffer;
  private uniformData!: ArrayBuffer;
  private uniformF32!: Float32Array;
  private uniformU32!: Uint32Array;
  private uniformSlots = 0;

  private fb!: GPUBuffer;
  private width = 1;
  private height = 1;
  private pageBindGroups: (GPUBindGroup | undefined)[] = [];
  private resolveBindGroup!: GPUBindGroup;

  private frameIndex = 0;
  private readonly mvp = new Float32Array(16);
  private readonly cls: PlaneClass = { visible: true, fraction: 1, simInterval: 1, areaPx: 0 };
  /** Per-frame dispatch list: page, uniform slot, workgroup count. */
  private dispatchList = new Uint32Array(3 * 64);

  constructor(
    readonly device: GPUDevice,
    options: PerfEngineOptions,
  ) {
    this.behaviors = options.behaviors ?? BUILTIN_BEHAVIORS;
    this.lod = { ...DEFAULT_LOD, ...options.lod };
    this.pool = new ParticlePool(device, options.pageParticles);
    this.timer = new GpuTimer(device, 2);

    this.layout = device.createBindGroupLayout({
      label: 'strata-perf plane',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PLANE_UNIFORM_SIZE },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.simPipeline = device.createComputePipeline({
      label: 'strata-perf sim+raster',
      layout: pipelineLayout,
      compute: { module: device.createShaderModule({ code: buildSimRasterWGSL(this.behaviors) }), entryPoint: 'main' },
    });
    this.initPipeline = device.createComputePipeline({
      label: 'strata-perf init',
      layout: pipelineLayout,
      compute: { module: device.createShaderModule({ code: INIT_WGSL }), entryPoint: 'main' },
    });

    const resolveModule = device.createShaderModule({ code: RESOLVE_WGSL });
    this.resolvePipeline = device.createRenderPipeline({
      label: 'strata-perf resolve',
      layout: 'auto',
      vertex: { module: resolveModule, entryPoint: 'vs' },
      fragment: { module: resolveModule, entryPoint: 'fs', targets: [{ format: options.format }] },
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
    return this.planes.length;
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

  /** Adds a plane and seeds its particles on the GPU. Returns the plane id. */
  addPlane(desc: PlaneDesc): number {
    const behavior = desc.behavior ? this.behaviors.findIndex((b) => b.name === desc.behavior) : 0;
    if (behavior < 0) throw new Error(`PerfEngine: unknown behavior "${desc.behavior}"`);
    const b = this.behaviors[behavior];
    if (Math.ceil(desc.count / WORKGROUP_SIZE) > this.device.limits.maxComputeWorkgroupsPerDimension) {
      throw new Error(`PerfEngine: plane of ${desc.count} particles exceeds one dispatch. Split it.`);
    }
    const range = this.pool.allocate(desc.count);
    const id = this.planes.length;
    const plane: PlaneRec = {
      ...range,
      id,
      model: new Float32Array(desc.model),
      behavior,
      params: desc.params ?? b.params,
      velMax: desc.velMax ?? b.velMax,
      damping: desc.damping ?? b.damping,
      intensity: desc.intensity ?? 1,
      seed: (desc.seed ?? id * 0x9e3779b1 + 0x7f4a7c15) >>> 0,
      pendingDt: 0,
    };
    this.planes.push(plane);
    this.ensureUniformSlots(this.planes.length);

    // Seed on the GPU. One submit per plane keeps slot 0 valid for each dispatch.
    const pattern = INIT_PATTERNS.indexOf(desc.init ?? b.init);
    const velMode = INIT_VELOCITIES.indexOf(desc.initVelocity ?? b.initVelocity);
    this.writeSlot(0, plane, null, 0, 0, plane.count, 0, 0, pattern | (velMode << 8), 1);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, PLANE_UNIFORM_STRIDE);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.initPipeline);
    pass.setBindGroup(0, this.bindGroupFor(plane.page), [0]);
    pass.dispatchWorkgroups(Math.ceil(plane.count / WORKGROUP_SIZE));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return id;
  }

  setPlaneModel(id: number, model: ArrayLike<number>): void {
    this.planes[id].model.set(model);
  }

  setPlaneParams(id: number, params: [number, number, number, number]): void {
    this.planes[id].params = params;
  }

  /** Simulates, rasterizes and resolves one frame, then submits it. */
  frame(p: FrameParams): FrameStats {
    const { device, planes, lod, stats } = this;
    const frame = this.frameIndex++;
    if (this.dispatchList.length < planes.length * 3) {
      this.dispatchList = new Uint32Array(planes.length * 3 * 2);
    }
    const list = this.dispatchList;
    let n = 0;
    let visible = 0;
    let drawn = 0;
    let simulated = 0;
    const baseFlags = this.bilinear ? FLAG_BILINEAR : 0;

    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i];
      plane.pendingDt += p.dt;
      mat4Multiply(this.mvp, p.viewProj, plane.model);
      const c = classifyPlane(this.mvp, plane.count, this.width, this.height, lod, this.cls);

      let drawCount = 0;
      if (c.visible) {
        visible++;
        drawCount = Math.max(1, Math.min(plane.count, Math.floor(plane.count * c.fraction)));
      }
      // Stagger by plane id so planes on the same interval do not all land on one frame.
      const doSim = this.simulate && c.simInterval > 0 && (frame + plane.id) % c.simInterval === 0;
      const simCount = doSim ? (c.visible && !lod.simulateHidden ? drawCount : plane.count) : 0;
      if (drawCount === 0 && simCount === 0) continue;

      let dt = 0;
      if (doSim) {
        dt = Math.min(plane.pendingDt, MAX_STEP_DT);
        plane.pendingDt = 0;
      }
      const weight = drawCount > 0 ? Math.max(1, Math.round((WEIGHT_ONE * plane.intensity * plane.count) / drawCount)) : 0;
      const flags = baseFlags | (doSim ? FLAG_SIM : 0) | (drawCount > 0 ? FLAG_DRAW : 0);
      this.writeSlot(n, plane, this.mvp, dt, p.time, simCount, drawCount, weight, plane.behavior, flags, frame);

      list[n * 3] = plane.page;
      list[n * 3 + 1] = n * PLANE_UNIFORM_STRIDE;
      list[n * 3 + 2] = Math.ceil(Math.max(drawCount, simCount) / WORKGROUP_SIZE);
      n++;
      drawn += drawCount;
      simulated += simCount;
    }

    if (n > 0) device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, n * PLANE_UNIFORM_STRIDE);
    const ru = new ArrayBuffer(16);
    new Uint32Array(ru, 0, 2).set([this.width, this.height]);
    new Float32Array(ru, 8, 2).set([this.exposure, this.gamma]);
    device.queue.writeBuffer(this.resolveUniform, 0, ru);

    const encoder = device.createCommandEncoder({ label: 'strata-perf frame' });
    encoder.clearBuffer(this.fb);

    const compute = encoder.beginComputePass({ timestampWrites: this.timer.writes(0) });
    compute.setPipeline(this.simPipeline);
    for (let k = 0; k < n; k++) {
      compute.setBindGroup(0, this.bindGroupFor(list[k * 3]), [list[k * 3 + 1]]);
      compute.dispatchWorkgroups(list[k * 3 + 2]);
    }
    compute.end();

    const render = encoder.beginRenderPass({
      colorAttachments: [{ view: p.target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      timestampWrites: this.timer.writes(1),
    });
    render.setPipeline(this.resolvePipeline);
    render.setBindGroup(0, this.resolveBindGroup);
    render.draw(3);
    render.end();

    this.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer.readback();

    stats.planes = planes.length;
    stats.visiblePlanes = visible;
    stats.dispatches = n;
    stats.totalParticles = this.pool.particleCount;
    stats.drawnParticles = drawn;
    stats.simulatedParticles = simulated;
    stats.gpuComputeMs = this.timer.ms[0];
    stats.gpuResolveMs = this.timer.ms[1];
    return stats;
  }

  /** Debug and tests: copy the atomic framebuffer of the last frame back to the CPU. */
  async readFramebuffer(): Promise<Uint32Array> {
    const size = this.width * this.height * 4;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.fb, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  /** Debug and tests: read back packed particles of one plane (count capped). */
  async readParticles(id: number, maxCount = 1024): Promise<Uint32Array> {
    const plane = this.planes[id];
    const size = Math.min(plane.count, maxCount) * BYTES_PER_PARTICLE;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.pool.pages[plane.page].buffer, plane.base * BYTES_PER_PARTICLE, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  destroy(): void {
    this.pool.destroy();
    this.fb.destroy();
    this.uniformBuffer.destroy();
    this.resolveUniform.destroy();
    this.timer.destroy();
    this.planes.length = 0;
    this.pageBindGroups = [];
  }

  private ensureUniformSlots(slots: number): void {
    if (slots <= this.uniformSlots) return;
    let cap = Math.max(64, this.uniformSlots);
    while (cap < slots) cap *= 2;
    this.uniformBuffer?.destroy();
    this.uniformSlots = cap;
    this.uniformData = new ArrayBuffer(cap * PLANE_UNIFORM_STRIDE);
    this.uniformF32 = new Float32Array(this.uniformData);
    this.uniformU32 = new Uint32Array(this.uniformData);
    this.uniformBuffer = this.device.createBuffer({
      label: 'strata-perf plane uniforms',
      size: cap * PLANE_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pageBindGroups = [];
  }

  private bindGroupFor(page: number): GPUBindGroup {
    let bg = this.pageBindGroups[page];
    if (!bg) {
      bg = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer, size: PLANE_UNIFORM_SIZE } },
          { binding: 1, resource: { buffer: this.pool.pages[page].buffer } },
          { binding: 2, resource: { buffer: this.fb } },
        ],
      });
      this.pageBindGroups[page] = bg;
    }
    return bg;
  }

  /** Fills one PlaneU slot. Offsets mirror the struct in shaders.ts. */
  private writeSlot(
    slot: number,
    plane: PlaneRec,
    mvp: Float32Array | null,
    dt: number,
    time: number,
    simCount: number,
    drawCount: number,
    weight: number,
    behavior: number,
    flags: number,
    frame = 0,
  ): void {
    const o = (slot * PLANE_UNIFORM_STRIDE) >> 2;
    const f = this.uniformF32;
    const u = this.uniformU32;
    if (mvp) f.set(mvp, o);
    f[o + 16] = plane.params[0];
    f[o + 17] = plane.params[1];
    f[o + 18] = plane.params[2];
    f[o + 19] = plane.params[3];
    f[o + 20] = dt;
    f[o + 21] = time;
    f[o + 22] = plane.velMax;
    f[o + 23] = Math.exp(-plane.damping * dt);
    u[o + 24] = plane.base;
    u[o + 25] = drawCount;
    u[o + 26] = simCount;
    u[o + 27] = weight;
    u[o + 28] = behavior;
    u[o + 29] = flags;
    u[o + 30] = plane.seed;
    u[o + 31] = frame;
    u[o + 32] = this.width;
    u[o + 33] = this.height;
  }
}
