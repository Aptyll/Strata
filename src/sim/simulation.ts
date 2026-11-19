import { getBehavior } from "../behaviors";
import type {
  Behavior,
  FrameContext,
  GpuContext,
  Pass,
  PlaneBehaviorChange,
  PlaneDesc,
  PlaneHost,
  PlaneInstance,
} from "../core/contracts";
import { compileComputePipeline } from "../gpu/context";
import {
  buildSimShader,
  dispatchSize,
  packPlane,
  PARTICLE_STRIDE,
  PLANE_COUNT_OFFSET,
  PLANE_UNIFORM_SIZE,
  planeParamValues,
} from "../gpu/shaderLib";
import { planeModelMatrix, seededRandom } from "../math";

interface PlaneGpu extends PlaneInstance {
  pipeline: GPUComputePipeline;
  /** The count currently stored in the plane uniform. */
  uploadedCount: number;
}

/**
 * Owns every plane's particle buffer and steps them on the GPU. One compute
 * pipeline per behavior (compiled lazily, cached), one dispatch per plane.
 * It is also the `simulate` pass of the frame graph.
 */
export class Simulation implements Pass, PlaneHost {
  readonly name = "simulate";
  readonly stage = "simulate" as const;
  enabled = true;

  private list: PlaneGpu[] = [];
  private pipelines = new Map<string, GPUComputePipeline>();
  private pipelineLayout: GPUPipelineLayout;
  private countScratch = new Uint32Array(1);
  /** One Plane uniform, packed on the CPU. writeBuffer copies it at call time, so it is reused. */
  private planeBlock = new DataView(new ArrayBuffer(PLANE_UNIFORM_SIZE));

  constructor(private gpu: GpuContext) {
    this.pipelineLayout = gpu.device.createPipelineLayout({
      bindGroupLayouts: [gpu.layouts.globals, gpu.layouts.planeSim],
    });
  }

  get planes(): readonly PlaneInstance[] {
    return this.list;
  }

  /** Replace the whole world. */
  setPlanes(descs: readonly PlaneDesc[]): void {
    this.clear();
    for (const d of descs) this.addPlane(d);
  }

  addPlane(desc: PlaneDesc): PlaneInstance {
    const { device, layouts } = this.gpu;
    const behavior = getBehavior(desc.behaviorId);
    // A plane's particles live in one buffer, so the device's buffer limits cap its size.
    const limit = Math.floor(
      Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize) / PARTICLE_STRIDE,
    );
    const capacity = Math.min(Math.max(1, Math.floor(desc.particleCount)), limit);
    if (capacity < desc.particleCount) {
      console.warn(`Plane capped at ${capacity} particles by this GPU's buffer limits (asked for ${desc.particleCount}).`);
    }

    const particles = device.createBuffer({
      label: `particles:${behavior.id}`,
      size: capacity * PARTICLE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    const data = new Float32Array(particles.getMappedRange());
    const random = seededRandom(Math.floor(desc.seed * 0xffffffff));
    if (behavior.init) {
      behavior.init(data, capacity, random);
    } else {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = random() * 2 - 1;
        data[i + 1] = random() * 2 - 1;
      }
    }
    particles.unmap();

    const uniform = device.createBuffer({
      label: "plane-uniform",
      size: PLANE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const plane: PlaneGpu = {
      desc,
      behavior,
      capacity,
      activeCount: capacity,
      uploadedCount: -1,
      particles,
      uniform,
      pipeline: this.pipelineFor(behavior),
      simBindGroup: device.createBindGroup({
        layout: layouts.planeSim,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: particles } },
        ],
      }),
      renderBindGroup: device.createBindGroup({
        layout: layouts.planeRender,
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      }),
    };
    this.updatePlane(plane);
    this.list.push(plane);
    return plane;
  }

  /** Remove one plane and free its GPU buffers. */
  removePlane(instance: PlaneInstance): void {
    const index = this.list.indexOf(instance as PlaneGpu);
    if (index < 0) return;
    this.list.splice(index, 1);
    instance.particles.destroy();
    instance.uniform.destroy();
  }

  /** Call after mutating a plane's desc (transform, params or brightness) to push it to the GPU. */
  updatePlane(instance: PlaneInstance): void {
    const plane = instance as PlaneGpu;
    const { desc, behavior } = plane;
    packPlane(this.planeBlock, 0, {
      model: planeModelMatrix(desc),
      params: planeParamValues(behavior, desc.params),
      count: plane.activeCount,
      seed: desc.seed,
      brightness: desc.brightness ?? 1,
    });
    this.gpu.device.queue.writeBuffer(plane.uniform, 0, this.planeBlock.buffer);
    plane.uploadedCount = plane.activeCount;
  }

  /**
   * Swap the rule a plane's particles follow. The particle buffer is untouched,
   * so particles carry on from where they are under the new behavior.
   */
  setBehavior(instance: PlaneInstance, change: PlaneBehaviorChange): void {
    const plane = instance as PlaneGpu & { behavior: Behavior };
    const behavior = getBehavior(change.behaviorId);
    plane.behavior = behavior;
    plane.pipeline = this.pipelineFor(behavior);
    plane.desc.behaviorId = behavior.id;
    plane.desc.params = change.params;
    if (change.seed !== undefined) plane.desc.seed = change.seed;
    this.updatePlane(plane);
  }

  /** Encode one simulation step for every plane's active particles. */
  execute(frame: FrameContext): void {
    const pass = frame.encoder.beginComputePass({ label: "simulate" });
    pass.setBindGroup(0, this.gpu.globalsBindGroup);
    let current: GPUComputePipeline | null = null;
    for (const plane of this.list) {
      const count = Math.min(Math.max(0, Math.floor(plane.activeCount)), plane.capacity);
      plane.activeCount = count;
      if (count !== plane.uploadedCount) {
        this.countScratch[0] = count;
        this.gpu.device.queue.writeBuffer(plane.uniform, PLANE_COUNT_OFFSET, this.countScratch);
        plane.uploadedCount = count;
      }
      if (count === 0 || plane.paused) continue;
      if (plane.pipeline !== current) {
        current = plane.pipeline;
        pass.setPipeline(current);
      }
      pass.setBindGroup(1, plane.simBindGroup);
      pass.dispatchWorkgroups(...dispatchSize(count));
    }
    pass.end();
  }

  clear(): void {
    for (const p of this.list) {
      p.particles.destroy();
      p.uniform.destroy();
    }
    this.list.length = 0;
  }

  dispose(): void {
    this.clear();
  }

  private pipelineFor(behavior: Behavior): GPUComputePipeline {
    let pipeline = this.pipelines.get(behavior.id);
    if (!pipeline) {
      pipeline = compileComputePipeline(this.gpu.device, `sim:${behavior.id}`, buildSimShader(behavior), this.pipelineLayout);
      this.pipelines.set(behavior.id, pipeline);
    }
    return pipeline;
  }
}
