// Frame graph adapters: the render modules as `Pass` objects for the engine
// described in src/core/contracts.ts. Nothing here is registered
// automatically; whoever builds the frame graph adds the passes it wants.

import type { FrameContext, GpuContext, Mat4, Pass, PlaneDesc } from '../core/contracts';
import { SplatAccumulator, type SplatBatch, type SplatMode } from './splat';
import { DensityPost, type DensitySettings } from './post';

type Dyn<T> = T | (() => T);
const get = <T>(v: Dyn<T>): T => (typeof v === 'function' ? (v as () => T)() : v);

/** Plane-local to world: translate * rotate * scale(halfSize). Column major. */
export function planeModelMatrix(d: PlaneDesc, out: Mat4 = new Float32Array(16)): Mat4 {
  const [x, y, z, w] = d.rotation;
  const [sx, sy] = d.halfSize;
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + z * w) * sx;
  out[2] = 2 * (x * z - y * w) * sx;
  out[3] = 0;
  out[4] = 2 * (x * y - z * w) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + x * w) * sy;
  out[7] = 0;
  out[8] = 2 * (x * z + y * w);
  out[9] = 2 * (y * z - x * w);
  out[10] = 1 - 2 * (x * x + y * y);
  out[11] = 0;
  out[12] = d.position[0];
  out[13] = d.position[1];
  out[14] = d.position[2];
  out[15] = 1;
  return out;
}

/** out = a * b, column major. */
export function mulMat4(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return out;
}

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
  const models: Mat4[] = [];
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
        const model = planeModelMatrix(plane.desc, (models[i] ??= new Float32Array(16)));
        batches.push({
          buffer: plane.particles,
          count: plane.activeCount,
          stride: 16,
          offset: 0,
          dims: 2,
          mvp: mulMat4(viewProj, model, model),
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
