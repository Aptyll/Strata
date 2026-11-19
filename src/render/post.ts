// DensityPost: everything after the particles are in the density buffer.
//
//   density -> trails -> bloom -> tone map -> target
//
// Takes any float texture view whose red channel holds accumulated particle
// energy, so it works on the engine's HDR target as well as on the output of
// SplatAccumulator. It keeps no reference to the source between frames.

import { Trails, type TrailMode } from './trails';
import { Bloom } from './bloom';
import { ToneMap, DEFAULT_TONE, type ToneSettings } from './tonemap';

export interface DensitySettings {
  tone: ToneSettings;
  bloom: {
    enabled: boolean;
    /** Amount of bloom added to the image. Around 0.3 is subtle. */
    strength: number;
    /** Luma above this blooms. 0 blooms everything. */
    threshold: number;
  };
  trails: {
    enabled: boolean;
    mode: TrailMode;
    /** Seconds for a trail to fade to half. */
    halfLife: number;
  };
}

export const DEFAULT_SETTINGS: DensitySettings = {
  tone: { ...DEFAULT_TONE },
  bloom: { enabled: true, strength: 0.35, threshold: 0.55 },
  trails: { enabled: true, mode: 'max', halfLife: 0.12 },
};

export interface DensityPostOptions {
  /** Format of the final target, usually the canvas format. */
  format: GPUTextureFormat;
  /** Format of the trail history. Default r32float, which never saturates. */
  historyFormat?: GPUTextureFormat;
  bloomLevels?: number;
}

export class DensityPost {
  readonly device: GPUDevice;
  settings: DensitySettings = structuredClone(DEFAULT_SETTINGS);
  readonly trails: Trails;
  readonly bloom: Bloom;
  readonly tone: ToneMap;
  /** Frame counter, drives the dither pattern. */
  frame = 0;
  private _trailsWereOn = false;

  constructor(device: GPUDevice, opts: DensityPostOptions) {
    this.device = device;
    this.trails = new Trails(device, { format: opts.historyFormat ?? 'r32float' });
    this.tone = new ToneMap(device, { format: opts.format });
    this.bloom = new Bloom(device, { toneBuffer: this.tone.buffer, levels: opts.bloomLevels });
  }

  /** Size of the density buffer and of the target, in pixels. */
  resize(width: number, height: number): void {
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    this.trails.resize(width, height);
    this.bloom.resize(width, height);
  }

  /** Drop the trail history, for example after a camera cut. */
  reset(): void {
    this.trails.reset();
  }

  /**
   * Encode the post chain.
   * `hdrView` holds density in its red channel. `dt` is the time since the
   * previous frame in seconds; pass a fixed step when rendering offline so
   * trails come out identical on every run.
   */
  encode(encoder: GPUCommandEncoder, hdrView: GPUTextureView, target: GPUTextureView, dt = 1 / 60): void {
    const s = this.settings;
    const bloomOn = s.bloom.enabled && s.bloom.strength > 0 && this.bloom.levels > 0;
    this.tone.write(
      s.tone,
      { strength: bloomOn ? s.bloom.strength / this.bloom.levels : 0, threshold: s.bloom.threshold },
      this.frame,
    );
    let hdr = hdrView;
    const trailsOn = s.trails.enabled && s.trails.halfLife > 0;
    if (trailsOn) {
      if (!this._trailsWereOn) this.trails.reset();
      hdr = this.trails.encode(encoder, hdr, { halfLife: s.trails.halfLife, mode: s.trails.mode, dt });
    }
    this._trailsWereOn = trailsOn;
    const bloom = bloomOn ? this.bloom.encode(encoder, hdr) : null;
    this.tone.encode(encoder, hdr, bloom, target);
    this.frame++;
  }

  destroy(): void {
    this.trails.destroy();
    this.bloom.destroy();
    this.tone.destroy();
  }
}
