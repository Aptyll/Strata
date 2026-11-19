/**
 * Compute rasterizer as a drop-in `rasterize` pass for the shared engine
 * (src/core/contracts.ts, docs/architecture.md).
 *
 * It reads the engine's own 16-byte f32 particle buffers through each plane's
 * `simBindGroup`, projects every active particle in a compute shader and
 * adds light per pixel with atomicAdd, in fixed point: one hit adds
 * `plane.brightness * LIGHT_ONE`. A single fullscreen triangle then adds
 * `light / LIGHT_ONE * globals.brightness` to the HDR target. No vertex buffers, no point
 * draw calls, no blending per particle.
 *
 * Use it instead of a point-list rasterize pass, not together with one.
 */

import type { FrameContext, GpuContext, Pass } from '../core/contracts';

const WORKGROUP = 256;
/** Fixed-point scale of the per-pixel light buffer: a full-brightness hit adds this much. */
export const LIGHT_ONE = 256;

const SHARED = /* wgsl */ `
struct Globals {
  viewProj: mat4x4f,
  time: f32,
  dt: f32,
  frame: u32,
  brightness: f32,
}
@group(0) @binding(0) var<uniform> globals: Globals;
`;

const RASTER_WGSL = /* wgsl */ `${SHARED}
struct Plane {
  model: mat4x4f,
  params0: vec4f,
  params1: vec4f,
  count: u32,
  seed: f32,
  brightness: f32,
}
struct Particle { pos: vec2f, vel: vec2f }
struct Size { width: u32, height: u32 }

@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(2) @binding(0) var<uniform> size: Size;
@group(2) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= plane.count) { return; }
  let light = u32(clamp(plane.brightness, 0.0, 16.0) * ${LIGHT_ONE}.0 + 0.5);
  if (light == 0u) { return; }
  let pos = particles[gid.x].pos;
  let clip = globals.viewProj * (plane.model * vec4f(pos, 0.0, 1.0));
  if (clip.w <= 0.0) { return; }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return; }
  let px = vec2u((ndc.xy * vec2f(0.5, -0.5) + 0.5) * vec2f(f32(size.width), f32(size.height)));
  if (px.x >= size.width || px.y >= size.height) { return; }
  atomicAdd(&counts[px.y * size.width + px.x], light);
}
`;

const COMPOSITE_WGSL = /* wgsl */ `${SHARED}
struct Size { width: u32, height: u32 }
@group(1) @binding(0) var<uniform> size: Size;
@group(1) @binding(1) var<storage, read> counts: array<u32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(u32(pos.x), size.width - 1u);
  let y = min(u32(pos.y), size.height - 1u);
  let v = f32(counts[y * size.width + x]) * (globals.brightness / ${LIGHT_ONE}.0);
  return vec4f(v, v, v, 0.0);
}
`;

export interface AtomicRasterPassOptions {
  name?: string;
  /**
   * Clear the HDR target before adding (the contract says the first rasterize
   * pass clears). Set false when another pass already cleared it.
   */
  clear?: boolean;
}

export interface AtomicRasterPass extends Pass {
  /** Per-pixel light of the last frame (u32 per pixel, LIGHT_ONE per full-brightness hit). For tests and debugging. */
  readonly counts: GPUBuffer | undefined;
}

export function createAtomicRasterPass(gpu: GpuContext, options: AtomicRasterPassOptions = {}): AtomicRasterPass {
  const { device } = gpu;
  const clear = options.clear ?? true;

  const rasterLayout = device.createBindGroupLayout({
    label: 'strata-perf atomic raster',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const compositeLayout = device.createBindGroupLayout({
    label: 'strata-perf atomic composite',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });

  const rasterPipeline = device.createComputePipeline({
    label: 'strata-perf atomic raster',
    layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.layouts.globals, gpu.layouts.planeSim, rasterLayout] }),
    compute: { module: device.createShaderModule({ code: RASTER_WGSL }), entryPoint: 'main' },
  });
  const compositeModule = device.createShaderModule({ code: COMPOSITE_WGSL });
  const compositePipeline = device.createRenderPipeline({
    label: 'strata-perf atomic composite',
    layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.layouts.globals, compositeLayout] }),
    vertex: { module: compositeModule, entryPoint: 'vs' },
    fragment: {
      module: compositeModule,
      entryPoint: 'fs',
      targets: [
        {
          format: gpu.hdrFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });

  const sizeBuffer = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let counts: GPUBuffer | undefined;
  let rasterGroup: GPUBindGroup | undefined;
  let compositeGroup: GPUBindGroup | undefined;
  let width = 0;
  let height = 0;

  function resize(_gpu: GpuContext, w: number, h: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (counts && w === width && h === height) return;
    counts?.destroy();
    width = w;
    height = h;
    counts = device.createBuffer({
      label: 'strata-perf atomic counts',
      size: w * h * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(sizeBuffer, 0, new Uint32Array([w, h]));
    const entries = [
      { binding: 0, resource: { buffer: sizeBuffer } },
      { binding: 1, resource: { buffer: counts } },
    ];
    rasterGroup = device.createBindGroup({ layout: rasterLayout, entries });
    compositeGroup = device.createBindGroup({ layout: compositeLayout, entries });
  }

  return {
    name: options.name ?? 'atomic-raster',
    stage: 'rasterize',
    enabled: true,
    get counts() {
      return counts;
    },
    resize,

    execute(frame: FrameContext): void {
      resize(frame.gpu, frame.width, frame.height);
      const { encoder } = frame;
      encoder.clearBuffer(counts!);

      const compute = encoder.beginComputePass({ label: 'strata-perf atomic raster' });
      compute.setPipeline(rasterPipeline);
      compute.setBindGroup(0, frame.gpu.globalsBindGroup);
      compute.setBindGroup(2, rasterGroup!);
      for (const plane of frame.planes) {
        if (plane.activeCount <= 0) continue;
        compute.setBindGroup(1, plane.simBindGroup);
        compute.dispatchWorkgroups(Math.ceil(plane.activeCount / WORKGROUP));
      }
      compute.end();

      const render = encoder.beginRenderPass({
        label: 'strata-perf atomic composite',
        colorAttachments: [
          {
            view: frame.hdrView,
            loadOp: clear ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      render.setPipeline(compositePipeline);
      render.setBindGroup(0, frame.gpu.globalsBindGroup);
      render.setBindGroup(1, compositeGroup!);
      render.draw(3);
      render.end();
    },

    dispose(): void {
      counts?.destroy();
      sizeBuffer.destroy();
      counts = undefined;
    },
  };
}
