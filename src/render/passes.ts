// Frame graph adapters: the render modules as `Pass` objects for the engine
// described in src/core/contracts.ts. Nothing here is registered
// automatically; whoever builds the frame graph adds the passes it wants.
//
// In the app today:
//   createDensityTonemapPass  the default tone map, built by src/passes/tonemap.pass.ts
//   createDensitySplatPass    one of the rasterizers (src/app/graph.ts), picked with ?raster=splat

import type { FrameContext, GpuContext, Mat4, Pass } from '../core/contracts';
import { mat4Multiply, planeModelMatrix } from '../math';
import { SplatAccumulator, type SplatBatch, type SplatMode } from './splat';
import { DensityPost, type DensitySettings } from './post';

type Dyn<T> = T | (() => T);
const get = <T>(v: Dyn<T>): T => (typeof v === 'function' ? (v as () => T)() : v);

export interface DensityTonemapPassOptions {
  /** Starting settings. Change them later through `pass.post.settings`. */
  settings?: Partial<DensitySettings>;
  /**
   * Read density from somewhere other than `frame.hdrView`, for example from
   * a SplatAccumulator's own r32float texture.
   */
  source?: (frame: FrameContext) => GPUTextureView;
  /** Trail time step. Default `frame.dt`. Pass a constant for offline renders. */
  dt?: (frame: FrameContext) => number;
  bloomLevels?: number;
}

/**
 * Stage `tonemap`: density in the HDR target to the canvas, with trails and
 * bloom. Use it in place of a plain tone map pass, not next to one.
 */
export function createDensityTonemapPass(
  opts: DensityTonemapPassOptions = {},
): Pass & { post: DensityPost | null; resize(gpu: GpuContext, width: number, height: number): void } {
  let post: DensityPost | null = null;
  const pass = {
    name: 'density-tonemap',
    stage: 'tonemap' as const,
    enabled: true,
    post: null as DensityPost | null,
    resize(gpu: GpuContext, width: number, height: number): void {
      if (!post) {
        post = new DensityPost(gpu.device, { format: gpu.canvasFormat, bloomLevels: opts.bloomLevels });
        Object.assign(post.settings, structuredClone(opts.settings ?? {}));
        pass.post = post;
      }
      post.resize(width, height);
    },
    execute(frame: FrameContext): void {
      if (!post) pass.resize(frame.gpu, frame.width, frame.height);
      post!.encode(frame.encoder, opts.source?.(frame) ?? frame.hdrView, frame.canvasView, opts.dt?.(frame) ?? frame.dt);
    },
    dispose(): void {
      post?.destroy();
      post = null;
      pass.post = null;
    },
  };
  return pass;
}

export interface DensitySplatPassOptions {
  mode?: Dyn<SplatMode>;
  /** Energy per particle. Wire this to the scene's `render.brightness`. */
  energy?: Dyn<number>;
  /** Particle diameter in pixels. */
  size?: Dyn<number>;
  /** Clear the HDR target first. Default true; set false if another rasterize pass runs before this one. */
  clear?: boolean;
}

/**
 * Stage `rasterize`: draws every plane's active particles into
 * `frame.hdrView` with sub-pixel splatting. An alternative to one pixel
 * points, with the same additive result.
 */
export function createDensitySplatPass(opts: DensitySplatPassOptions = {}): Pass & { splat: SplatAccumulator | null } {
  let splat: SplatAccumulator | null = null;
  const batches: SplatBatch[] = [];
  const model: Mat4 = new Float32Array(16);
  const mvps: Mat4[] = [];
  const pass = {
    name: 'density-splat',
    stage: 'rasterize' as const,
    enabled: true,
    splat: null as SplatAccumulator | null,
    resize(gpu: GpuContext, width: number, height: number): void {
      splat ??= new SplatAccumulator(gpu.device, { format: gpu.hdrFormat, ownTarget: false });
      pass.splat = splat;
      splat.resize(width, height);
    },
    execute(frame: FrameContext): void {
      if (!splat) pass.resize(frame.gpu, frame.width, frame.height);
      const viewProj = frame.camera.viewProjection(frame.width / frame.height);
      const energy = get(opts.energy ?? 1);
      const size = get(opts.size ?? 1);
      batches.length = 0;
      frame.planes.forEach((plane, i) => {
        if (!plane.activeCount) return;
        planeModelMatrix(plane.desc, model);
        batches.push({
          buffer: plane.particles,
          count: plane.activeCount,
          stride: 16,
          offset: 0,
          dims: 2,
          mvp: mat4Multiply((mvps[i] ??= new Float32Array(16)), viewProj, model),
          energy: energy * (plane.desc.brightness ?? 1),
          size,
        });
      });
      splat!.mode = get(opts.mode ?? 'quad');
      splat!.encode(frame.encoder, batches, frame.frame, { view: frame.hdrView, clear: opts.clear ?? true });
    },
    dispose(): void {
      splat?.destroy();
      splat = null;
      pass.splat = null;
    },
  };
  return pass;
}
