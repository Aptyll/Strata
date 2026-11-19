/**
 * The app's compute rasterizer as a `rasterize` pass (src/core/contracts.ts):
 * "atomic-raster", the default in src/app/graph.ts.
 *
 * Reads the engine's own 16-byte f32 particle buffers through each plane's
 * `simBindGroup`, projects every active particle in a compute shader and adds
 * light per pixel with atomicAdd, in fixed point: one hit adds
 * `plane.brightness * LIGHT_ONE`. A single fullscreen triangle then adds
 * `light / LIGHT_ONE * globals.brightness` to the HDR target. No vertex
 * buffers, no point draw calls, no blending per particle.
 *
 * Two options, both off by default and switchable every frame:
 *   subpixel  split each particle over the 2x2 pixels around it (?subpixel=1)
 *   depth     fog, near fade, size gain and depth of field from src/depth
 *             (?depth=1). Fog, focus and particle size are fitted to the
 *             world the first time, and again when the world's radius moves
 *             by more than a quarter. Focus follows the nearest plane on the
 *             view axis, as the depth sprites do. `params` holds the live
 *             settings, so the cue switches in DepthParams (fog, dof,
 *             atmosphere) work here too.
 * Each combination is its own pipeline (./kernel.ts), built the first time it
 * is used, so cues that are off cost nothing.
 *
 * Use it instead of a point-list rasterize pass, not together with one.
 * PerfEngine (src/perf/engine.ts) has its own fused simulate + rasterize
 * kernel for 8-byte particles; this pass is the same idea for the engine's
 * 16-byte ones.
 */

import type { FrameContext, GpuContext, Pass, PlaneInstance, Vec3 } from '../core/contracts';
import {
  DepthParams,
  DEPTH_PARAMS_BYTES,
  depthSettingsForWorld,
  FocusTracker,
  focusPlaneFromDesc,
  worldRadius,
  type DepthSettings,
} from '../depth';
import { dispatchSize } from '../gpu/shaderLib';
import { RASTER_COMPOSITE_WGSL, RASTER_VIEW_BYTES, rasterKernelWgsl } from './kernel';

export interface ComputeRasterPassOptions {
  name?: string;
  /**
   * Clear the HDR target before adding (the contract says the first rasterize
   * pass clears). Set false when another pass already cleared it.
   */
  clear?: boolean;
  /** Start with the sub-pixel split on. */
  subpixel?: boolean;
  /** Start with depth cues on. */
  depth?: boolean;
  /** Depth settings applied on top of the world-sized ones. Change them later through `pass.params`. */
  params?: Partial<DepthSettings>;
}

export interface ComputeRasterPass extends Pass {
  /** Per-pixel light of the last frame (u32 per pixel, LIGHT_ONE per full-brightness hit). For tests and debugging. */
  readonly counts: GPUBuffer | undefined;
  /** Split each particle over the 2x2 pixels around its true position. */
  subpixel: boolean;
  /** Fog, near fade, size gain and depth of field. */
  depth: boolean;
  /** Live depth settings, read every frame while `depth` is on. */
  readonly params: DepthParams;
  readonly focus: FocusTracker;
  /** Focus follows the nearest plane on the view axis. Default true. */
  autofocus: boolean;
  /** Planes skipped last frame because fog had already hidden them. */
  readonly culledPlanes: number;
  /** Size fog, particle size and focus for a world of this radius (or measure `planes`). */
  fitWorld(source: number | readonly PlaneInstance[]): void;
}

/** Refit the depth settings when the world's radius moves by more than this fraction. */
const REFIT = 0.25;

export function createComputeRasterPass(gpu: GpuContext, options: ComputeRasterPassOptions = {}): ComputeRasterPass {
  const { device } = gpu;
  const clear = options.clear ?? true;

  const rasterLayout = device.createBindGroupLayout({
    label: 'strata compute raster',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const compositeLayout = device.createBindGroupLayout({
    label: 'strata compute raster composite',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });

  const rasterPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [gpu.layouts.globals, gpu.layouts.planeSim, rasterLayout],
  });
  const pipelines = new Map<string, GPUComputePipeline>();
  const rasterPipeline = (subpixel: boolean, depth: boolean): GPUComputePipeline => {
    const key = `${subpixel ? 's' : ''}${depth ? 'd' : ''}`;
    let pipeline = pipelines.get(key);
    if (!pipeline) {
      const label = `strata compute raster${key ? ` (${key})` : ''}`;
      pipeline = device.createComputePipeline({
        label,
        layout: rasterPipelineLayout,
        compute: { module: device.createShaderModule({ label, code: rasterKernelWgsl({ subpixel, depth }) }), entryPoint: 'main' },
      });
      pipelines.set(key, pipeline);
    }
    return pipeline;
  };

  const compositeModule = device.createShaderModule({ label: 'strata compute raster composite', code: RASTER_COMPOSITE_WGSL });
  const compositePipeline = device.createRenderPipeline({
    label: 'strata compute raster composite',
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
  const paramsBuffer = device.createBuffer({
    label: 'strata compute raster depth params',
    size: DEPTH_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const viewBuffer = device.createBuffer({
    label: 'strata compute raster view',
    size: RASTER_VIEW_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
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
      label: 'strata compute raster counts',
      size: w * h * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(sizeBuffer, 0, new Uint32Array([w, h]));
    const grid = [
      { binding: 0, resource: { buffer: sizeBuffer } },
      { binding: 1, resource: { buffer: counts } },
    ];
    rasterGroup = device.createBindGroup({
      layout: rasterLayout,
      entries: [...grid, { binding: 2, resource: { buffer: paramsBuffer } }, { binding: 3, resource: { buffer: viewBuffer } }],
    });
    compositeGroup = device.createBindGroup({ layout: compositeLayout, entries: grid });
  }

  // ---- depth cues: world fit, autofocus, uniforms (as in src/depth/sprite-pass.ts)
  const params = new DepthParams(options.params);
  const focus = new FocusTracker({ initial: params.focusDist });
  const paramsData = new Float32Array(DEPTH_PARAMS_BYTES / 4);
  const viewData = new Float32Array(RASTER_VIEW_BYTES / 4);
  let fittedRadius = 0;
  let snapFocus = true;
  let culled = 0;

  const fitWorld = (source: number | readonly PlaneInstance[]): void => {
    const radius = typeof source === 'number' ? source : worldRadius(source);
    if (!(radius > 0)) return;
    Object.assign(params, depthSettingsForWorld(radius), options.params);
    focus.minDist = 0.15 * radius;
    focus.distance = focus.target = params.focusDist;
    fittedRadius = radius;
    snapFocus = true;
  };

  /** Fits the world if needed, moves the focus, uploads the uniforms. Returns the eye. */
  const updateDepth = (frame: FrameContext): Vec3 => {
    const radius = worldRadius(frame.planes);
    if (radius > 0 && (fittedRadius === 0 || Math.abs(radius - fittedRadius) > REFIT * fittedRadius)) fitWorld(radius);
    const eye = frame.camera.eye();
    const state = frame.camera.state;
    if (pass.autofocus) {
      const to: Vec3 = [state.target[0] - eye[0], state.target[1] - eye[1], state.target[2] - eye[2]];
      const len = Math.hypot(to[0], to[1], to[2]);
      if (len > 1e-6) {
        const forward: Vec3 = [to[0] / len, to[1] / len, to[2] / len];
        const planes = frame.planes.map((p) => focusPlaneFromDesc(p.desc));
        params.focusDist = focus.update(eye, forward, planes, snapFocus ? 0 : frame.dt);
        if (snapFocus) {
          focus.snap();
          params.focusDist = focus.distance;
        }
      }
    }
    snapFocus = false;
    params.pack({ viewportH: frame.height, projScaleY: 1 / Math.tan(state.fovY / 2) }, paramsData);
    viewData[0] = eye[0];
    viewData[1] = eye[1];
    viewData[2] = eye[2];
    device.queue.writeBuffer(paramsBuffer, 0, paramsData);
    device.queue.writeBuffer(viewBuffer, 0, viewData);
    return eye;
  };

  const planeRadius = (p: PlaneInstance): number => Math.hypot(p.desc.halfSize[0], p.desc.halfSize[1]);

  const pass: ComputeRasterPass = {
    name: options.name ?? 'atomic-raster',
    stage: 'rasterize',
    enabled: true,
    subpixel: options.subpixel ?? false,
    depth: options.depth ?? false,
    params,
    focus,
    autofocus: true,
    get counts() {
      return counts;
    },
    get culledPlanes() {
      return culled;
    },
    fitWorld,
    resize,

    execute(frame: FrameContext): void {
      resize(frame.gpu, frame.width, frame.height);
      const { encoder } = frame;
      encoder.clearBuffer(counts!);

      const depth = pass.depth;
      let cullDist = Infinity;
      let eye: Vec3 = [0, 0, 0];
      if (depth) {
        eye = updateDepth(frame);
        cullDist = params.fogCullDistance();
      }

      const compute = encoder.beginComputePass({ label: 'strata compute raster' });
      compute.setPipeline(rasterPipeline(pass.subpixel, depth));
      compute.setBindGroup(0, frame.gpu.globalsBindGroup);
      compute.setBindGroup(2, rasterGroup!);
      culled = 0;
      for (const plane of frame.planes) {
        if (plane.activeCount <= 0) continue;
        if (cullDist < Infinity) {
          // Whole planes that fog has already erased are never dispatched.
          const c = plane.desc.position;
          if (Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) - planeRadius(plane) > cullDist) {
            culled++;
            continue;
          }
        }
        compute.setBindGroup(1, plane.simBindGroup);
        compute.dispatchWorkgroups(...dispatchSize(plane.activeCount));
      }
      compute.end();

      const render = encoder.beginRenderPass({
        label: 'strata compute raster composite',
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
      paramsBuffer.destroy();
      viewBuffer.destroy();
      counts = undefined;
    },
  };
  rasterPipeline(pass.subpixel, pass.depth); // build the starting variant now, as before
  return pass;
}
