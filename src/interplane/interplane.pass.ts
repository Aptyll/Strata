/**
 * Interplane edge crossing: particles that reach a linked edge of one plane
 * fly through 3D space as a stream and arrive on the neighbouring plane.
 *
 * Built for the particle-count goal: the cost is proportional to the small
 * pool of "couriers" (particles in transit), not to the world's particle
 * count. Particles that stay on their plane are never iterated, and their
 * 16 byte layout is unchanged. See docs/interplane.md.
 *
 * Usage: const ip = createInterplane(); register ip.passes with the frame graph.
 */
import type { FrameContext, GpuContext, Pass, PlaneInstance } from "../core/contracts";
import { buildLinks, planeModel, type Link, type LinkOptions } from "./links";
import { COURIER_BYTES, LINK_UNIFORM_BYTES, drawShader, simShader } from "./wgsl";

export interface InterplaneParams {
  /** Chance that a particle found at a linked edge crosses. 0 turns crossing off. */
  leak: number;
  /** Width of the edge band particles are taken from, plane-local (sheet is 2 wide). */
  margin: number;
  /** Flight speed in world units per second. */
  speed: number;
  /** 0..1: how tightly a stream ropes together mid flight. */
  pinch: number;
  /** Whole turns a stream winds around its spine. Keep it an integer. */
  twist: number;
  /** Brightness of a particle in flight relative to one at rest. */
  boost: number;
}

export interface InterplaneOptions extends Partial<InterplaneParams> {
  /** Couriers per link: the most particles a link can have in flight at once. Default 16384. */
  couriersPerLink?: number;
  /** Options for the automatic neighbour search. */
  link?: LinkOptions;
  /** Explicit links, to override the automatic neighbour search. */
  links?: Link[];
}

export interface Interplane {
  /** Live tunables. Changes apply on the next frame. */
  params: InterplaneParams;
  /** [compute pass (stage "interplane"), draw pass (stage "rasterize")]. */
  passes: [Pass, Pass];
  /** Links currently in use (empty until the first frame). */
  links(): readonly Link[];
  /** Total couriers allocated: the upper bound on particles in flight. */
  capacity(): number;
  /** Recompute links on the next frame, e.g. after planes moved. */
  invalidate(): void;
  /** Debug: count couriers in flight. Reads back from the GPU, do not call per frame. */
  countInFlight(): Promise<number>;
}

const DEFAULTS: InterplaneParams = { leak: 0.5, margin: 0.04, speed: 1.2, pinch: 0.85, twist: 1, boost: 1 };

export function createInterplane(options: InterplaneOptions = {}): Interplane {
  const params: InterplaneParams = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof InterplaneParams)[]) {
    const v = options[k];
    if (v !== undefined) params[k] = v;
  }
  const perLink = Math.max(1, Math.floor(options.couriersPerLink ?? 16384));

  let device: GPUDevice | null = null;
  let layout: { sim: GPUBindGroupLayout; draw: GPUBindGroupLayout } | null = null;
  let simPipeline: GPUComputePipeline | null = null;
  let drawPipeline: GPURenderPipeline | null = null;

  // Rebuilt whenever the set of planes changes.
  let links: Link[] = [];
  let builtFor: GPUBuffer[] = [];
  let dirty = true;
  let stride = 256;
  let uniformData = new ArrayBuffer(0);
  let uniformBuffer: GPUBuffer | null = null;
  let courierBuffer: GPUBuffer | null = null;
  let simGroups: GPUBindGroup[] = [];
  let drawGroup: GPUBindGroup | null = null;

  function init(gpu: GpuContext): void {
    device = gpu.device;
    const uniform: GPUBufferBindingLayout = { type: "uniform", hasDynamicOffset: true, minBindingSize: LINK_UNIFORM_BYTES };
    layout = {
      sim: device.createBindGroupLayout({
        label: "interplane sim",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: uniform },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      }),
      draw: device.createBindGroupLayout({
        label: "interplane draw",
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: uniform },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ],
      }),
    };
    simPipeline = device.createComputePipeline({
      label: "interplane sim",
      layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.layouts.globals, layout.sim] }),
      compute: { module: device.createShaderModule({ label: "interplane sim", code: simShader }), entryPoint: "main" },
    });
    const module = device.createShaderModule({ label: "interplane draw", code: drawShader });
    const add: GPUBlendComponent = { srcFactor: "one", dstFactor: "one", operation: "add" };
    drawPipeline = device.createRenderPipeline({
      label: "interplane draw",
      layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.layouts.globals, layout.draw] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: gpu.hdrFormat, blend: { color: add, alpha: add } }] },
      primitive: { topology: "point-list" },
    });
  }

  function rebuild(planes: readonly PlaneInstance[]): void {
    const dev = device!;
    links = options.links ?? buildLinks(planes.map((p) => p.desc), options.link);
    builtFor = planes.map((p) => p.particles);
    dirty = false;
    uniformBuffer?.destroy();
    courierBuffer?.destroy();
    uniformBuffer = courierBuffer = drawGroup = null;
    simGroups = [];
    if (links.length === 0) return;

    stride = Math.ceil(LINK_UNIFORM_BYTES / dev.limits.minUniformBufferOffsetAlignment) * dev.limits.minUniformBufferOffsetAlignment;
    uniformData = new ArrayBuffer(links.length * stride);
    uniformBuffer = dev.createBuffer({ label: "interplane links", size: uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Zero filled, so every courier starts idle.
    courierBuffer = dev.createBuffer({ label: "interplane couriers", size: links.length * perLink * COURIER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const uniform = { buffer: uniformBuffer, size: LINK_UNIFORM_BYTES };
    simGroups = links.map((l) =>
      dev.createBindGroup({
        layout: layout!.sim,
        entries: [
          { binding: 0, resource: uniform },
          { binding: 1, resource: { buffer: planes[l.src].particles } },
          { binding: 2, resource: { buffer: planes[l.dst].particles } },
          { binding: 3, resource: { buffer: courierBuffer! } },
        ],
      }),
    );
    drawGroup = dev.createBindGroup({
      layout: layout!.draw,
      entries: [
        { binding: 0, resource: uniform },
        { binding: 1, resource: { buffer: courierBuffer } },
      ],
    });
  }

  function writeUniforms(frame: FrameContext): void {
    const f = new Float32Array(uniformData);
    const u = new Uint32Array(uniformData);
    links.forEach((l, i) => {
      const o = (i * stride) / 4;
      const src = frame.planes[l.src];
      const dst = frame.planes[l.dst];
      planeModel(src.desc, f, o);
      planeModel(dst.desc, f, o + 16);
      u[o + 32] = i * perLink;
      u[o + 33] = perLink;
      u[o + 34] = src.activeCount;
      u[o + 35] = dst.activeCount;
      u[o + 36] = l.exit;
      u[o + 37] = l.entry;
      f[o + 38] = l.flip;
      f[o + 39] = 1 / l.length;
      f[o + 40] = params.leak;
      f[o + 41] = params.margin;
      f[o + 42] = params.speed;
      f[o + 43] = params.pinch;
      f[o + 44] = params.twist;
      f[o + 45] = params.boost;
      u[o + 46] = Math.imul(i + 1, 0x9e3779b1) >>> 0;
    });
    device!.queue.writeBuffer(uniformBuffer!, 0, uniformData);
  }

  const sim: Pass = {
    name: "interplane-crossing",
    stage: "interplane",
    execute(frame) {
      if (!device) init(frame.gpu);
      const changed = dirty || frame.planes.length !== builtFor.length || frame.planes.some((p, i) => p.particles !== builtFor[i]);
      if (changed) rebuild(frame.planes);
      if (links.length === 0) return;
      writeUniforms(frame);
      const pass = frame.encoder.beginComputePass({ label: "interplane crossing" });
      pass.setPipeline(simPipeline!);
      pass.setBindGroup(0, frame.gpu.globalsBindGroup);
      const groups = Math.ceil(perLink / 64);
      for (let i = 0; i < links.length; i++) {
        pass.setBindGroup(1, simGroups[i], [i * stride]);
        pass.dispatchWorkgroups(groups);
      }
      pass.end();
    },
    dispose() {
      uniformBuffer?.destroy();
      courierBuffer?.destroy();
      uniformBuffer = courierBuffer = null;
      links = [];
      dirty = true;
    },
  };

  const draw: Pass = {
    name: "interplane-streams",
    stage: "rasterize",
    execute(frame) {
      if (!drawGroup || links.length === 0) return;
      // Adds onto whatever the main rasterize pass drew, so register after it.
      const pass = frame.encoder.beginRenderPass({
        label: "interplane streams",
        colorAttachments: [{ view: frame.hdrView, loadOp: "load", storeOp: "store" }],
      });
      pass.setPipeline(drawPipeline!);
      pass.setBindGroup(0, frame.gpu.globalsBindGroup);
      for (let i = 0; i < links.length; i++) {
        pass.setBindGroup(1, drawGroup, [i * stride]);
        pass.draw(perLink);
      }
      pass.end();
    },
  };

  return {
    params,
    passes: [sim, draw],
    links: () => links,
    capacity: () => links.length * perLink,
    invalidate: () => {
      dirty = true;
    },
    async countInFlight() {
      if (!device || !courierBuffer) return 0;
      const size = courierBuffer.size;
      const copy = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(courierBuffer, 0, copy, 0, size);
      device.queue.submit([enc.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(copy.getMappedRange());
      let n = 0;
      for (let i = 4; i < f.length; i += COURIER_BYTES / 4) if (f[i] > 0) n++;
      copy.unmap();
      copy.destroy();
      return n;
    },
  };
}
