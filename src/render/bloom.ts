// Bloom for the density buffer.
//
// The prefilter converts density to luma with the same curve the tone mapper
// uses, then keeps what is above a threshold. Blooming luma instead of raw
// density matters here: raw density spans several orders of magnitude, and a
// blur of it would be nothing but the few densest cores. A down chain and an
// additive up chain then spread the result over several octaves.
//
// Buffers: up to `levels` r16float textures, level 0 at half the source size
// and each next level half again. They hold luma above the threshold, not
// density. encode() returns level 0, the sum of every octave, which the tone
// map samples with a linear filter.

import { ADDITIVE_BLEND, FULLSCREEN_VS, TONE_WGSL } from './common';

const FORMAT: GPUTextureFormat = 'r16float';

const PREFILTER_WGSL = FULLSCREEN_VS + TONE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> t: Tone;
@group(0) @binding(1) var src: texture_2d<f32>;
fn tap(c: vec2i, hi: vec2i) -> f32 {
  let l = densityToLuma(textureLoad(src, min(c, hi), 0).r, t);
  // Cap each tap so one extreme pixel cannot flicker through the whole chain.
  return min(max(l - t.bloomThreshold, 0.0), 4.0);
}
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let c = vec2i(i.pos.xy) * 2;
  let hi = vec2i(textureDimensions(src)) - 1;
  let v = tap(c, hi) + tap(c + vec2i(1, 0), hi) + tap(c + vec2i(0, 1), hi) + tap(c + vec2i(1, 1), hi);
  return vec4f(v * 0.25, 0.0, 0.0, 1.0);
}
`;

const DOWN_WGSL = FULLSCREEN_VS + /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(src));
  let v = textureSampleLevel(src, samp, i.uv + px * vec2f(-1.0, -1.0), 0.0).r
        + textureSampleLevel(src, samp, i.uv + px * vec2f( 1.0, -1.0), 0.0).r
        + textureSampleLevel(src, samp, i.uv + px * vec2f(-1.0,  1.0), 0.0).r
        + textureSampleLevel(src, samp, i.uv + px * vec2f( 1.0,  1.0), 0.0).r;
  return vec4f(v * 0.25, 0.0, 0.0, 1.0);
}
`;

const UP_WGSL = FULLSCREEN_VS + /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(src));
  var v = 4.0 * textureSampleLevel(src, samp, i.uv, 0.0).r;
  v += 2.0 * (textureSampleLevel(src, samp, i.uv + px * vec2f(-1.0, 0.0), 0.0).r
            + textureSampleLevel(src, samp, i.uv + px * vec2f( 1.0, 0.0), 0.0).r
            + textureSampleLevel(src, samp, i.uv + px * vec2f(0.0, -1.0), 0.0).r
            + textureSampleLevel(src, samp, i.uv + px * vec2f(0.0,  1.0), 0.0).r);
  v += textureSampleLevel(src, samp, i.uv + px * vec2f(-1.0, -1.0), 0.0).r
     + textureSampleLevel(src, samp, i.uv + px * vec2f( 1.0, -1.0), 0.0).r
     + textureSampleLevel(src, samp, i.uv + px * vec2f(-1.0,  1.0), 0.0).r
     + textureSampleLevel(src, samp, i.uv + px * vec2f( 1.0,  1.0), 0.0).r;
  return vec4f(v / 16.0, 0.0, 0.0, 1.0);
}
`;

export class Bloom {
  readonly device: GPUDevice;
  readonly toneBuffer: GPUBuffer;
  readonly maxLevels: number;
  width = 0;
  height = 0;
  private _tex: GPUTexture[] = [];
  private _views: GPUTextureView[] = [];
  private _sampler: GPUSampler;
  private _prefilter: GPURenderPipeline;
  private _down: GPURenderPipeline;
  private _up: GPURenderPipeline;

  /**
   * `toneBuffer` is the uniform buffer owned by ToneMap, so both stages agree
   * on the density curve.
   */
  constructor(device: GPUDevice, opts: { toneBuffer: GPUBuffer; levels?: number }) {
    this.device = device;
    this.toneBuffer = opts.toneBuffer;
    this.maxLevels = opts.levels ?? 6;
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const mk = (code: string, blend?: GPUBlendState): GPURenderPipeline => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT, blend }] },
      });
    };
    this._prefilter = mk(PREFILTER_WGSL);
    this._down = mk(DOWN_WGSL);
    this._up = mk(UP_WGSL, ADDITIVE_BLEND);
  }

  /** Number of levels actually in use. The composite divides by this. */
  get levels(): number {
    return this._tex.length;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    for (const t of this._tex) t.destroy();
    this._tex = [];
    this._views = [];
    let w = width;
    let h = height;
    for (let l = 0; l < this.maxLevels; l++) {
      w = Math.max(1, (w + 1) >> 1);
      h = Math.max(1, (h + 1) >> 1);
      const t = this.device.createTexture({
        size: [w, h],
        format: FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this._tex.push(t);
      this._views.push(t.createView());
      if (w <= 2 || h <= 2) break;
    }
  }

  /**
   * `srcView` is full resolution density (red channel). Returns half
   * resolution bloom, the sum of `levels` octaves.
   */
  encode(encoder: GPUCommandEncoder, srcView: GPUTextureView): GPUTextureView {
    const device = this.device;
    const draw = (pipeline: GPURenderPipeline, target: GPUTextureView, entries: GPUBindGroupEntry[], load = false): void => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: load ? 'load' : 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      pass.draw(3);
      pass.end();
    };
    const v = this._views;
    draw(this._prefilter, v[0], [
      { binding: 0, resource: { buffer: this.toneBuffer } },
      { binding: 1, resource: srcView },
    ]);
    const tex = (view: GPUTextureView): GPUBindGroupEntry[] => [{ binding: 0, resource: view }, { binding: 1, resource: this._sampler }];
    for (let l = 1; l < v.length; l++) draw(this._down, v[l], tex(v[l - 1]));
    for (let l = v.length - 1; l > 0; l--) draw(this._up, v[l - 1], tex(v[l]), true);
    return v[0];
  }

  destroy(): void {
    for (const t of this._tex) t.destroy();
  }
}
