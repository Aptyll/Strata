/**
 * Compute rasterizer as a drop-in `rasterize` pass for the main engine
 * (src/core/contracts.ts, docs/architecture.md). It is the app's default
 * rasterizer ("atomic-raster" in src/app/graph.ts).
 *
 * Reads the engine's own 16-byte f32 particle buffers through each plane's
 * `simBindGroup`, projects every active particle in a compute shader and adds
 * light per pixel with atomicAdd, in fixed point: one hit adds
 * `plane.brightness * LIGHT_ONE`. A single fullscreen triangle then adds
 * `light / LIGHT_ONE * globals.brightness` to the HDR target. No vertex
 * buffers, no point draw calls, no blending per particle.
 *
 * Bindings: group(0) Globals, group(1) the plane (engine `planeSim` layout),
 * group(2) this pass' size uniform and u32 light buffer (one per pixel, row
 * major, top row first).
 *
 * Use it instead of a point-list rasterize pass, not together with one.
 * PerfEngine (./engine.ts) has its own fused simulate + rasterize kernel for
 * 8-byte particles; this pass is the same idea for the engine's 16-byte ones.
 */

import type { FrameContext, GpuContext, Pass } from '../core/contracts';
import {
  dispatchSize,
  DISPATCH_ROW_PARTICLES,
  GLOBALS_WGSL,
  PARTICLE_WGSL,
  PLANE_STRUCT_WGSL,
  WORKGROUP_SIZE,
} from '../gpu/shaderLib';
import { FULLSCREEN_VS_WGSL } from '../gpu/wgsl';
import { LIGHT_ONE } from './shaders';

/** Projects each active particle and adds its light to the pixel it lands on. */
export const ATOMIC_RASTER_WGSL = /* wgsl */ `${GLOBALS_WGSL}
${PLANE_STRUCT_WGSL}
${PARTICLE_WGSL}
struct Size { width: u32, height: u32 }

@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(2) @binding(0) var<uniform> size: Size;
@group(2) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${DISPATCH_ROW_PARTICLES}u;
  if (i >= plane.count) { return; }
  let light = u32(clamp(plane.brightness, 0.0, 16.0) * ${LIGHT_ONE}.0 + 0.5);
  if (light == 0u) { return; }
  let pos = particles[i].pos;
  let clip = globals.viewProj * (plane.model * vec4f(pos, 0.0, 1.0));
  if (clip.w <= 0.0) { return; }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return; }
  let px = vec2u((ndc.xy * vec2f(0.5, -0.5) + 0.5) * vec2f(f32(size.width), f32(size.height)));
  if (px.x >= size.width || px.y >= size.height) { return; }
  atomicAdd(&counts[px.y * size.width + px.x], light);
}
`;

/** Adds the light buffer to the HDR target, scaled by globals.brightness. */
export const ATOMIC_COMPOSITE_WGSL = /* wgsl */ `${GLOBALS_WGSL}
struct Size { width: u32, height: u32 }
@group(1) @binding(0) var<uniform> size: Size;
@group(1) @binding(1) var<storage, read> counts: array<u32>;
${FULLSCREEN_VS_WGSL}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(u32(pos.x), size.width - 1u);
  let y = min(u32(pos.y), size.height - 1u);
  let v = f32(counts[y * size.width + x]) * (globals.brightness / ${LIGHT_ONE}.0);
  return vec4f(v, v, v, 1.0);
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
    compute: { module: device.createShaderModule({ label: 'strata-perf atomic raster', code: ATOMIC_RASTER_WGSL }), entryPoint: 'main' },
  });
  const compositeModule = device.createShaderModule({ label: 'strata-perf atomic composite', code: ATOMIC_COMPOSITE_WGSL });
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
        compute.dispatchWorkgroups(...dispatchSize(plane.activeCount));
      }
      compute.end();

      const render = encoder.beginRenderPass({
        label: 'strata-perf atomic composite',
        colorAttachments: [
          {
            view: frame.hdrView,
            loadOp: clear ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
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
