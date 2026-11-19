/**
 * ColorLifeEngine: particle life with color species on one sheet, on the GPU.
 *
 * Simulated, not stateless: every particle stores position, velocity and a
 * species (20 bytes, twice over for the sort), stepped every frame. Neighbors
 * come from a uniform grid rebuilt each frame by a counting sort (see
 * shaders.ts), so the cost per particle depends on how many others sit within
 * one interaction radius, not on the total count.
 *
 * Standalone: it owns its device resources and does not touch the app's
 * Simulation, the perf engine or the stateless trillion path.
 */

import { dispatchSize } from "../gpu/shaderLib";
import { MAX_SPECIES, type ColorRules } from "./rules";
import { buildComputeShader, buildDrawShader, buildTonemapShader, PARAMS_SIZE, SCAN_BLOCK, VIEW_SIZE } from "./shaders";

export interface ColorLifeOptions {
  /** Particles. Clamped to what the device can bind. */
  count: number;
  /**
   * Grid cells per side. The interaction radius is one cell (2 / grid in
   * sheet units). Default: about 12 particles per cell on average.
   */
  grid?: number;
}

/** Bytes per particle in one copy of the state (vec4f state + u32 species). */
const STATE_BYTES = 16;

/** Grid side for a count: mean occupancy near `perCell`, within [16, 1024]. */
export function defaultGrid(count: number, perCell = 12): number {
  return Math.max(16, Math.min(1024, Math.round(Math.sqrt(count / perCell))));
}

export interface ViewParams {
  center: [number, number];
  /** Clip units per sheet unit, x and y (aspect is folded in by the caller). */
  scale: [number, number];
  /** Light each particle adds. */
  energy: number;
  /** Tone map exposure. */
  exposure: number;
}

export class ColorLifeEngine {
  readonly device: GPUDevice;
  readonly count: number;
  readonly grid: number;
  readonly cells: number;
  readonly numBlocks: number;

  private params = new ArrayBuffer(PARAMS_SIZE);
  private paramsBuffer: GPUBuffer;
  private buffers: GPUBuffer[] = [];
  private cellCounters: GPUBuffer;
  private starts: GPUBuffer;
  private stateA: GPUBuffer;
  private speciesA: GPUBuffer;
  private computeBG: GPUBindGroup;
  private pipes: Record<"init" | "reassign" | "bin" | "scanLocal" | "scanBlocks" | "addBlocks" | "scatter" | "integrate", GPUComputePipeline>;

  private viewBuffer: GPUBuffer;
  private viewData = new Float32Array(VIEW_SIZE / 4);
  private drawPipe: GPURenderPipeline;
  private drawBG: GPUBindGroup;
  private tonePipe: GPURenderPipeline;
  private toneLayout: GPUBindGroupLayout;
  private exposureBuffer: GPUBuffer;
  private hdr: GPUTexture | null = null;
  private toneBG: GPUBindGroup | null = null;

  private tallyBuffer: GPUBuffer;
  private tallyBusy = false;
  private wantTally = false;
  private rules: ColorRules | null = null;
  private needsInit = true;
  private needsReassign = false;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat, opts: ColorLifeOptions) {
    this.device = device;
    const maxBind = device.limits.maxStorageBufferBindingSize;
    this.count = Math.max(1, Math.min(Math.floor(opts.count), Math.floor(maxBind / STATE_BYTES)));
    this.grid = Math.max(3, Math.min(2048, Math.round(opts.grid ?? defaultGrid(this.count))));
    this.cells = this.grid * this.grid;
    this.numBlocks = Math.ceil(this.cells / SCAN_BLOCK);

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const make = (label: string, size: number, usage = storage) => {
      const b = device.createBuffer({ label: `color-life ${label}`, size: Math.max(16, Math.ceil(size / 4) * 4), usage });
      this.buffers.push(b);
      return b;
    };
    this.paramsBuffer = make("params", PARAMS_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const stateA = (this.stateA = make("state A", this.count * 16));
    const speciesA = (this.speciesA = make("species A", this.count * 4));
    const stateB = make("state B", this.count * 16);
    const speciesB = make("species B", this.count * 4);
    this.cellCounters = make("cell counters", this.cells * 2 * 4);
    this.starts = make("starts", (this.cells + 1) * 4);
    const blockSums = make("block sums", this.numBlocks * 4);
    this.tallyBuffer = make("tally", 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    const module = device.createShaderModule({ label: "color-life compute", code: buildComputeShader() });
    const S = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: "color-life compute",
      entries: [
        { binding: 0, visibility: S, buffer: { type: "uniform" } },
        ...[1, 2, 3, 4, 5, 6, 7].map((binding) => ({ binding, visibility: S, buffer: { type: "storage" as const } })),
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipe = (entryPoint: string) =>
      device.createComputePipeline({ label: `color-life ${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint } });
    this.pipes = {
      init: pipe("init"),
      reassign: pipe("reassign"),
      bin: pipe("bin"),
      scanLocal: pipe("scanLocal"),
      scanBlocks: pipe("scanBlocks"),
      addBlocks: pipe("addBlocks"),
      scatter: pipe("scatter"),
      integrate: pipe("integrate"),
    };
    this.computeBG = device.createBindGroup({
      layout,
      entries: [this.paramsBuffer, stateA, speciesA, stateB, speciesB, this.cellCounters, this.starts, blockSums].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });

    // Draw: additive points into an HDR target.
    this.viewBuffer = make("view", VIEW_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const drawModule = device.createShaderModule({ label: "color-life draw", code: buildDrawShader() });
    const V = GPUShaderStage.VERTEX;
    const drawLayout = device.createBindGroupLayout({
      label: "color-life draw",
      entries: [
        { binding: 0, visibility: V, buffer: { type: "uniform" } },
        { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: V, buffer: { type: "read-only-storage" } },
      ],
    });
    const add: GPUBlendComponent = { srcFactor: "one", dstFactor: "one", operation: "add" };
    this.drawPipe = device.createRenderPipeline({
      label: "color-life draw",
      layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
      vertex: { module: drawModule, entryPoint: "vs" },
      fragment: { module: drawModule, entryPoint: "fs", targets: [{ format: "rgba16float", blend: { color: add, alpha: add } }] },
      primitive: { topology: "point-list" },
    });
    this.drawBG = device.createBindGroup({
      layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.viewBuffer } },
        { binding: 1, resource: { buffer: stateA } },
        { binding: 2, resource: { buffer: speciesA } },
      ],
    });

    // Tone map to the output.
    this.exposureBuffer = make("exposure", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const toneModule = device.createShaderModule({ label: "color-life tonemap", code: buildTonemapShader() });
    this.toneLayout = device.createBindGroupLayout({
      label: "color-life tonemap",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.tonePipe = device.createRenderPipeline({
      label: "color-life tonemap",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.toneLayout] }),
      vertex: { module: toneModule, entryPoint: "vs" },
      fragment: { module: toneModule, entryPoint: "fs", targets: [{ format: outputFormat }] },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Apply a roll. A change of species count re-deals species; positions stay. */
  setRules(rules: ColorRules): void {
    if (this.rules && this.rules.species !== rules.species) this.needsReassign = true;
    this.rules = rules;
  }

  /** Scatter every particle again on the next step. */
  reset(): void {
    this.needsInit = true;
  }

  private writeParams(dt: number): void {
    const r = this.rules;
    if (!r) throw new Error("ColorLifeEngine: setRules before step");
    const u = new Uint32Array(this.params);
    const f = new Float32Array(this.params);
    u[0] = this.count;
    u[1] = this.grid;
    u[2] = r.species;
    u[3] = r.seed;
    f[4] = 2 / this.grid;
    f[5] = r.beta;
    f[6] = r.force;
    f[7] = Math.pow(0.5, dt / r.frictionHalfLife);
    f[8] = dt;
    u[9] = this.numBlocks;
    u[10] = this.cells;
    u[11] = 0;
    f.set(r.matrix.subarray(0, MAX_SPECIES * MAX_SPECIES), 12);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
  }

  /** One simulation step of `dt` seconds (clamped for stability). */
  step(encoder: GPUCommandEncoder, dt: number): void {
    this.writeParams(Math.min(Math.max(dt, 0), 1 / 30));
    const [px, py] = dispatchSize(this.count);
    const cellGroups = this.numBlocks;

    if (this.needsInit || this.needsReassign) {
      const pass = encoder.beginComputePass({ label: "color-life setup" });
      pass.setBindGroup(0, this.computeBG);
      pass.setPipeline(this.needsInit ? this.pipes.init : this.pipes.reassign);
      pass.dispatchWorkgroups(px, py);
      pass.end();
      this.needsInit = this.needsReassign = false;
    }

    encoder.clearBuffer(this.cellCounters, 0, this.cells * 4);
    const pass = encoder.beginComputePass({ label: "color-life step" });
    pass.setBindGroup(0, this.computeBG);
    pass.setPipeline(this.pipes.bin);
    pass.dispatchWorkgroups(px, py);
    pass.setPipeline(this.pipes.scanLocal);
    pass.dispatchWorkgroups(cellGroups);
    pass.setPipeline(this.pipes.scanBlocks);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipes.addBlocks);
    pass.dispatchWorkgroups(cellGroups);
    pass.setPipeline(this.pipes.scatter);
    pass.dispatchWorkgroups(px, py);
    pass.setPipeline(this.pipes.integrate);
    pass.dispatchWorkgroups(px, py);
    pass.end();

    if (this.wantTally && !this.tallyBusy) {
      encoder.copyBufferToBuffer(this.starts, this.cells * 4, this.tallyBuffer, 0, 4);
      this.wantTally = false;
      this.tallyBusy = true;
    }
  }

  /**
   * Ask for the GPU's own count of particles it binned this frame (the last
   * entry of the prefix sum). Call before `step`, then `readTally` after
   * submitting. Resolves to null when a read is already in flight.
   */
  requestTally(): void {
    if (!this.tallyBusy) this.wantTally = true;
  }

  async readTally(): Promise<number | null> {
    if (!this.tallyBusy) return null;
    try {
      await this.tallyBuffer.mapAsync(GPUMapMode.READ);
      const n = new Uint32Array(this.tallyBuffer.getMappedRange())[0];
      this.tallyBuffer.unmap();
      return n;
    } finally {
      this.tallyBusy = false;
    }
  }

  private ensureTarget(width: number, height: number): GPUTexture {
    if (!this.hdr || this.hdr.width !== width || this.hdr.height !== height) {
      this.hdr?.destroy();
      this.hdr = this.device.createTexture({
        label: "color-life hdr",
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.toneBG = this.device.createBindGroup({
        layout: this.toneLayout,
        entries: [
          { binding: 0, resource: this.hdr.createView() },
          { binding: 1, resource: { buffer: this.exposureBuffer } },
        ],
      });
    }
    return this.hdr;
  }

  /** Draw the particles in their species colors into `target` (size width x height). */
  draw(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, view: ViewParams): void {
    const r = this.rules;
    if (!r) return;
    const hdr = this.ensureTarget(width, height);
    const d = this.viewData;
    d[0] = view.center[0];
    d[1] = view.center[1];
    d[2] = view.scale[0];
    d[3] = view.scale[1];
    d[4] = view.energy;
    d.set(r.palette, 8);
    this.device.queue.writeBuffer(this.viewBuffer, 0, d);
    this.device.queue.writeBuffer(this.exposureBuffer, 0, new Float32Array([view.exposure, 0, 0, 0]));

    const p1 = encoder.beginRenderPass({
      label: "color-life points",
      colorAttachments: [{ view: hdr.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    p1.setPipeline(this.drawPipe);
    p1.setBindGroup(0, this.drawBG);
    p1.draw(this.count);
    p1.end();

    const p2 = encoder.beginRenderPass({
      label: "color-life tonemap",
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    p2.setPipeline(this.tonePipe);
    p2.setBindGroup(0, this.toneBG!);
    p2.draw(3);
    p2.end();
  }

  /**
   * Read the particles and the cell starts back to the CPU, for checks and
   * stills. Slow (copies everything); never call it per frame.
   */
  async snapshot(): Promise<{ state: Float32Array; species: Uint32Array; starts: Uint32Array }> {
    const read = async (src: GPUBuffer, bytes: number) => {
      const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, staging, 0, bytes);
      this.device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const copy = staging.getMappedRange().slice(0);
      staging.destroy();
      return copy;
    };
    return {
      state: new Float32Array(await read(this.stateA, this.count * 16)),
      species: new Uint32Array(await read(this.speciesA, this.count * 4)),
      starts: new Uint32Array(await read(this.starts, (this.cells + 1) * 4)),
    };
  }

  destroy(): void {
    for (const b of this.buffers) b.destroy();
    this.hdr?.destroy();
  }
}
