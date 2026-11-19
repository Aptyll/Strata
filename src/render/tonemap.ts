// Final composite: density to monochrome display values.
//
//   density -> exposure -> curve (log / power / linear) -> + bloom
//           -> display shoulder -> sRGB encode -> dither -> white on black
//
// The log curve is the default because particle density is a count, and counts
// in a dense sim span orders of magnitude. With log, going from 1 to 10
// particles on a pixel brightens it by the same step as going from 100 to
// 1000, so structure stays readable in both the dust and the cores.

import { FULLSCREEN_VS, HASH_WGSL, TONE_UNIFORM_BYTES, TONE_WGSL, CURVES, DISPLAYS, type Curve, type Display } from './common';

const WGSL = FULLSCREEN_VS + HASH_WGSL + TONE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> t: Tone;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

// Identity up to the knee, then a smooth roll off that approaches 1.
fn softShoulder(x: f32) -> f32 {
  let k = 0.75;
  if (x <= k) { return x; }
  let r = 1.0 - k;
  return k + r * (1.0 - exp(-(x - k) / r));
}
// ACES style fit (Narkowicz). Has a toe, so sparse dust sinks toward black
// and dense structure gains contrast.
fn filmic(x: f32) -> f32 {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
fn srgb(x: f32) -> f32 {
  if (x <= 0.0031308) { return x * 12.92; }
  return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
fn srgbToLinear(x: f32) -> f32 {
  if (x <= 0.04045) { return x / 12.92; }
  return pow((x + 0.055) / 1.055, 2.4);
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let c = vec2u(i.pos.xy);
  var l = densityToLuma(textureLoad(hdr, c, 0).r, t);
  l += t.bloomStrength * textureSampleLevel(bloom, samp, i.uv, 0.0).r;
  var v: f32;
  switch t.display {
    case 0u { v = softShoulder(l); }
    case 1u { v = filmic(l); }
    default { v = clamp(l, 0.0, 1.0); }
  }
  // Triangular dither, because smooth dark gradients on pure black band badly
  // in 8 bit. It is added to the sRGB encoded value, the space the 8 bit target
  // stores, so one unit of dither is one code value on every target format.
  // The amplitude never exceeds the distance to black or to white: clamped
  // noise would lift black and dim white on average, and the empty void stays
  // exactly 0 instead of sparkling (which also costs video bitrate).
  var e = srgb(v);
  let h = pcg(c.x + pcg(c.y + pcg(t.frame)));
  let n = u01(h) + u01(pcg(h)) - 1.0;
  let a = min(t.dither, min(e, 1.0 - e) * 255.0);
  e = clamp(e + n * a / 255.0, 0.0, 1.0);
  // An -srgb target encodes on write, so hand it the linear value.
  if (t.encodeSrgb == 0u) { e = srgbToLinear(e); }
  return vec4f(e, e, e, 1.0);
}
`;

export interface ToneSettings {
  /** Multiplies raw density before the curve. */
  exposure: number;
  /** Exposed density that maps to full white. */
  white: number;
  curve: Curve;
  display: Display;
  /** Exponent of the 'power' curve. 0.5 is a square root. */
  power: number;
  /**
   * Exponent applied to luma after the curve. Default 1. Above 1 pushes faint
   * regions toward black and separates the bright ones, which helps when the
   * log curve has to span many orders of magnitude.
   */
  contrast?: number;
  /**
   * Dither amplitude in 8 bit steps. 0 turns it off. Near black and white it
   * shrinks to the distance from the end, so black stays exactly black.
   */
  dither: number;
}

export const DEFAULT_TONE: ToneSettings = {
  exposure: 1,
  white: 64,
  curve: 'log',
  display: 'soft',
  power: 0.5,
  dither: 1,
};

export class ToneMap {
  readonly device: GPUDevice;
  /** Format of the output target, usually the canvas format. */
  readonly format: GPUTextureFormat;
  /** Shared with Bloom so its prefilter uses the same curve. */
  readonly buffer: GPUBuffer;
  private _sampler: GPUSampler;
  private _pipeline: GPURenderPipeline;
  private _black: GPUTexture;
  private _blackView: GPUTextureView;

  constructor(device: GPUDevice, opts: { format: GPUTextureFormat }) {
    this.device = device;
    this.format = opts.format;
    this.buffer = device.createBuffer({ size: TONE_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const module = device.createShaderModule({ code: WGSL });
    this._pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
    });
    this._black = device.createTexture({
      size: [1, 1],
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._blackView = this._black.createView();
  }

  /**
   * Upload tone parameters. Call before encoding bloom and the composite.
   * `bloom.strength` is already divided by the bloom level count by the caller.
   * Word indices follow the Tone struct in common.ts.
   */
  write(tone: ToneSettings, bloom: { strength: number; threshold: number }, frame: number): void {
    const b = new ArrayBuffer(TONE_UNIFORM_BYTES);
    const f = new Float32Array(b);
    const u = new Uint32Array(b);
    f[0] = tone.exposure;
    f[1] = tone.white;
    u[2] = CURVES[tone.curve] ?? 0;
    u[3] = DISPLAYS[tone.display] ?? 0;
    f[4] = tone.power;
    f[5] = bloom.strength;
    f[6] = bloom.threshold;
    f[7] = tone.dither;
    u[8] = frame >>> 0;
    u[9] = this.format.endsWith('-srgb') ? 0 : 1;
    f[10] = tone.contrast ?? 1;
    this.device.queue.writeBuffer(this.buffer, 0, b);
  }

  /** `hdrView` holds density in its red channel and has the size of the target. */
  encode(encoder: GPUCommandEncoder, hdrView: GPUTextureView, bloomView: GPUTextureView | null, targetView: GPUTextureView): void {
    const bind = this.device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: hdrView },
        { binding: 2, resource: bloomView ?? this._blackView },
        { binding: 3, resource: this._sampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.buffer.destroy();
    this._black.destroy();
  }
}
