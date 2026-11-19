// Temporal accumulation of the density buffer, for motion trails.
//
// Works on raw density, before tone mapping, so a trail fades the way light
// would: a pixel that held 1000 particles leaves a longer visible tail than a
// pixel that held one.
//
// Modes:
//   'max'  phosphor. The current frame stays at full strength and the past
//          decays behind it. Static images are unchanged. Comet like tails.
//   'ema'  long exposure. Each frame is blended into a running average, so
//          movement turns into smooth streaks and total brightness of a
//          static image is preserved. Also averages away sub-pixel shimmer.

import { FULLSCREEN_VS } from './common';

const WGSL = FULLSCREEN_VS + /* wgsl */ `
struct T { decay: f32, mode: u32 };
@group(0) @binding(0) var<uniform> t: T;
@group(0) @binding(1) var cur: texture_2d<f32>;
@group(0) @binding(2) var prev: texture_2d<f32>;
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let c = vec2i(i.pos.xy);
  let a = clamp(textureLoad(cur, c, 0).r, 0.0, 1.0e9);
  let b = clamp(textureLoad(prev, c, 0).r, 0.0, 1.0e9);
  var v: f32;
  if (t.mode == 0u) { v = max(a, b * t.decay); } else { v = mix(a, b, t.decay); }
  // Let faint tails die instead of lingering as residue forever.
  if (v < 1.0e-4) { v = 0.0; }
  return vec4f(v, 0.0, 0.0, 1.0);
}
`;

export const TRAIL_MODES = { max: 0, ema: 1 } as const;
export type TrailMode = keyof typeof TRAIL_MODES;

export interface TrailOptions {
  /** Seconds for a trail to fade to half. 0 disables the history. */
  halfLife: number;
  mode: TrailMode;
  /** Seconds since the previous frame. */
  dt: number;
}

export class Trails {
  readonly device: GPUDevice;
  /** Format of the history. Match the density buffer, or use r32float. */
  readonly format: GPUTextureFormat;
  width = 0;
  height = 0;
  private _tex: GPUTexture[] = [];
  private _views: GPUTextureView[] = [];
  private _i = 0;
  private _fresh = true;
  private _ubo: GPUBuffer;
  private _pipeline: GPURenderPipeline;

  constructor(device: GPUDevice, opts: { format: GPUTextureFormat }) {
    this.device = device;
    this.format = opts.format;
    this._ubo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: WGSL });
    this._pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
    });
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    for (let k = 0; k < 2; k++) {
      this._tex[k]?.destroy();
      this._tex[k] = this.device.createTexture({
        size: [width, height],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this._views[k] = this._tex[k].createView();
    }
    this._fresh = true;
  }

  /** Drop the history, for example after a camera cut. */
  reset(): void {
    this._fresh = true;
  }

  /**
   * Blend `srcView` into the history and return the view holding the result.
   * Decay is derived from real time, so trails have the same length at any
   * frame rate. Call `resize` first.
   */
  encode(encoder: GPUCommandEncoder, srcView: GPUTextureView, o: TrailOptions): GPUTextureView {
    const decay = this._fresh || !(o.halfLife > 0) ? 0 : Math.pow(0.5, Math.max(o.dt, 0) / o.halfLife);
    this._fresh = false;
    const u = new ArrayBuffer(16);
    new Float32Array(u)[0] = decay;
    new Uint32Array(u)[1] = TRAIL_MODES[o.mode] ?? 0;
    this.device.queue.writeBuffer(this._ubo, 0, u);
    const prev = this._views[this._i];
    const next = this._views[1 - this._i];
    this._i = 1 - this._i;
    const bind = this.device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._ubo } },
        { binding: 1, resource: srcView },
        { binding: 2, resource: prev },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: next, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    return next;
  }

  destroy(): void {
    for (const t of this._tex) t.destroy();
    this._ubo.destroy();
  }
}
