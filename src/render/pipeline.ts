// DensityRenderer: splatting plus the post chain in one object, for callers
// that just have particle buffers and a target.
//
//   splat (HDR density) -> trails -> bloom -> tone map -> target

import { SplatAccumulator, type SplatBatch, type SplatMode } from './splat';
import { DensityPost, type DensitySettings } from './post';

export interface DensityRendererOptions {
  /** Format of the final target, usually the canvas format. */
  format: GPUTextureFormat;
  mode?: SplatMode;
  bloomLevels?: number;
  /** Format of the density buffer. Default: the best the device can blend into. */
  hdrFormat?: GPUTextureFormat;
}

export class DensityRenderer {
  readonly device: GPUDevice;
  readonly splat: SplatAccumulator;
  readonly post: DensityPost;

  constructor(device: GPUDevice, opts: DensityRendererOptions) {
    this.device = device;
    this.splat = new SplatAccumulator(device, { mode: opts.mode ?? 'quad', format: opts.hdrFormat });
    this.post = new DensityPost(device, { format: opts.format, bloomLevels: opts.bloomLevels });
  }

  get settings(): DensitySettings {
    return this.post.settings;
  }
  set settings(s: DensitySettings) {
    this.post.settings = s;
  }

  get mode(): SplatMode {
    return this.splat.mode;
  }
  set mode(m: SplatMode) {
    this.splat.mode = m;
  }

  resize(width: number, height: number): void {
    this.splat.resize(width, height);
    this.post.resize(width, height);
  }

  /** Splat the batches and run the post chain into `target`. `dt` in seconds. */
  render(encoder: GPUCommandEncoder, o: { batches: readonly SplatBatch[]; target: GPUTextureView; dt?: number }): void {
    this.splat.encode(encoder, o.batches, this.post.frame);
    this.post.encode(encoder, this.splat.view!, o.target, o.dt);
  }

  destroy(): void {
    this.splat.destroy();
    this.post.destroy();
  }
}
