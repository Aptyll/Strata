// Particle splatting into a single channel HDR density buffer.
//
// Every particle deposits energy. Energy adds up per pixel, so a pixel that a
// thousand particles pass through holds 1000 times the value of a pixel hit by
// one. Nothing is clamped here: turning density into brightness is the job of
// the tone mapper.
//
// Three modes, all producing the same kind of buffer:
//   'point'   point-list rasterisation. One fragment per particle. Fastest
//             raster path, but particles snap to whole pixels.
//   'quad'    instanced quads with a tent kernel. Energy is split across the
//             2x2 pixels around the true position, so motion is smooth below
//             one pixel and particles can grow past one pixel.
//   'compute' no rasteriser. A compute shader projects each particle and adds
//             fixed point energy into a per pixel atomic counter with the same
//             2x2 split. Scales best when particles outnumber pixels.

import { FULLSCREEN_VS, HASH_WGSL, pickHdrFormat } from './common';

const UBO_SIZE = 112;
// Short rows: a dispatch is a rectangle, so up to one row of invocations runs
// past the count and exits early. 256 groups keeps that under 65,536.
const ROW_GROUPS = 256;
const WORKGROUP = 256;

const BATCH_WGSL = /* wgsl */ `
struct Batch {
  mvp: mat4x4f,
  viewport: vec2f,
  energy: f32,
  size: f32,
  attenuate: f32,
  maxSize: f32,
  count: u32,
  first: u32,
  frame: u32,
  fixedScale: f32,
  gridW: u32,
  gridH: u32,
};
@group(0) @binding(0) var<uniform> u: Batch;

// Apparent diameter in pixels. With attenuation, size is the diameter at w = 1.
fn footprint(clipW: f32) -> f32 {
  let d = u.size / mix(1.0, max(clipW, 1.0e-6), u.attenuate);
  return min(d, u.maxSize);
}
`;

const POINT_WGSL = BATCH_WGSL + /* wgsl */ `
struct Out {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) e: f32,
};
@vertex fn vs(@location(0) p: vec3f) -> Out {
  var o: Out;
  o.pos = u.mvp * vec4f(p, 1.0);
  let d = footprint(o.pos.w);
  // A particle smaller than a pixel covers d*d of it, so it deposits that
  // fraction. Larger ones cannot grow in this mode, so they get brighter.
  o.e = u.energy * d * d;
  return o;
}
@fragment fn fs(i: Out) -> @location(0) vec4f {
  return vec4f(i.e, 0.0, 0.0, 1.0);
}
`;

const QUAD_WGSL = BATCH_WGSL + /* wgsl */ `
struct Out {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) peak: f32,
  @location(2) @interpolate(flat) invH: f32,
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec3f) -> Out {
  let clip = u.mvp * vec4f(p, 1.0);
  let d = footprint(clip.w);
  // Tent kernel half width in pixels. Never below 1, which gives the 2x2
  // bilinear footprint for sub-pixel particles.
  let h = max(d, 1.0);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let off = corner * h;
  var o: Out;
  o.pos = vec4f(clip.xy + off * 2.0 / u.viewport * clip.w, clip.zw);
  o.local = off;
  // The tent sums to h*h over the pixel grid, so this keeps total deposited
  // energy at energy * d*d whatever the kernel width.
  o.peak = u.energy * d * d / (h * h);
  o.invH = 1.0 / h;
  return o;
}
@fragment fn fs(i: Out) -> @location(0) vec4f {
  let a = max(vec2f(0.0), vec2f(1.0) - abs(i.local) * i.invH);
  return vec4f(i.peak * a.x * a.y, 0.0, 0.0, 1.0);
}
`;

const computeWgsl = (strideWords: number, offsetWords: number, dims: 2 | 3): string => BATCH_WGSL + HASH_WGSL + /* wgsl */ `
@group(0) @binding(1) var<storage, read> particles: array<f32>;
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;

fn deposit(ix: i32, iy: i32, v: f32, rnd: u32) {
  if (ix < 0 || iy < 0 || ix >= i32(u.gridW) || iy >= i32(u.gridH)) { return; }
  // Stochastic rounding: dim contributions survive on average instead of
  // all truncating to zero.
  let q = u32(v * u.fixedScale + u01(rnd));
  if (q == 0u) { return; }
  atomicAdd(&grid[u32(iy) * u.gridW + u32(ix)], q);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${ROW_GROUPS * WORKGROUP}u;
  if (i >= u.count) { return; }
  let b = (i + u.first) * ${strideWords}u + ${offsetWords}u;
  let p = vec3f(particles[b], particles[b + 1u], ${dims === 3 ? 'particles[b + 2u]' : '0.0'});
  let clip = u.mvp * vec4f(p, 1.0);
  if (clip.w <= 0.0 || clip.z < 0.0 || clip.z > clip.w) { return; }
  let ndc = clip.xy / clip.w;
  let px = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * u.viewport - 0.5;
  let f0 = floor(px);
  if (f0.x < -1.0 || f0.y < -1.0 || f0.x >= u.viewport.x || f0.y >= u.viewport.y) { return; }
  let fr = px - f0;
  let ix = i32(f0.x);
  let iy = i32(f0.y);
  let d = footprint(clip.w);
  let e = u.energy * d * d;
  let h0 = pcg(i ^ (u.frame * 0x9E3779B9u));
  let h1 = pcg(h0);
  let h2 = pcg(h1);
  let h3 = pcg(h2);
  deposit(ix,     iy,     e * (1.0 - fr.x) * (1.0 - fr.y), h0);
  deposit(ix + 1, iy,     e * fr.x * (1.0 - fr.y),         h1);
  deposit(ix,     iy + 1, e * (1.0 - fr.x) * fr.y,         h2);
  deposit(ix + 1, iy + 1, e * fr.x * fr.y,                 h3);
}
`;

const RESOLVE_WGSL = FULLSCREEN_VS + /* wgsl */ `
struct R { gridW: u32, invScale: f32 };
@group(0) @binding(0) var<uniform> r: R;
@group(0) @binding(1) var<storage, read> grid: array<u32>;
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let c = vec2u(i.pos.xy);
  return vec4f(f32(grid[c.y * r.gridW + c.x]) * r.invScale, 0.0, 0.0, 1.0);
}
`;

export type SplatMode = 'point' | 'quad' | 'compute';

export interface SplatBatch {
  /**
   * Particle data. Needs VERTEX usage for the raster modes and STORAGE usage
   * for compute mode.
   */
  buffer: GPUBuffer;
  /** Particles to draw. */
  count: number;
  /** Column major model view projection, WebGPU clip space. */
  mvp: Float32Array | number[];
  /** Index of the first particle. Default 0. */
  first?: number;
  /** Bytes per particle, a multiple of 4. Default 16. */
  stride?: number;
  /** Byte offset of the position inside a particle. Default 0. */
  offset?: number;
  /** 3 for a vec3f position, 2 for a vec2f on the z = 0 plane. Default 3. */
  dims?: 2 | 3;
  /** Energy of a particle that covers one pixel. Default 1. */
  energy?: number;
  /** Diameter in pixels, or the diameter at w = 1 when attenuated. Default 1. */
  size?: number;
  /** Divide size by clip w, so far particles shrink and dim. Default false. */
  attenuate?: boolean;
  /** Clamp on the apparent diameter in pixels. Default 64. */
  maxSize?: number;
}

export interface SplatTarget {
  view: GPUTextureView;
  /** Clear before drawing. Pass false to add to what is already there. */
  clear?: boolean;
}

interface Slot {
  ubo: GPUBuffer;
  bind: GPUBindGroup | null;
  pipeline: GPURenderPipeline | GPUComputePipeline | null;
  buffer: GPUBuffer | null;
  grid: GPUBuffer | null;
}

const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

export class SplatAccumulator {
  readonly device: GPUDevice;
  /** Switch at any time. Pipelines are built on first use. */
  mode: SplatMode;
  /** Format of the density target. Only the red channel is written. */
  readonly format: GPUTextureFormat;
  /** Fixed point steps per unit of energy in compute mode. */
  fixedScale: number;
  width = 0;
  height = 0;
  /** The accumulator's own density texture. Null with `ownTarget: false`. */
  texture: GPUTexture | null = null;
  view: GPUTextureView | null = null;
  private _ownTarget: boolean;
  private _grid: GPUBuffer | null = null;
  private _raster = new Map<string, GPURenderPipeline>();
  private _compute = new Map<string, GPUComputePipeline>();
  private _slots: Slot[] = [];
  private _scratch = new ArrayBuffer(UBO_SIZE);
  private _f32 = new Float32Array(this._scratch);
  private _u32 = new Uint32Array(this._scratch);
  private _resolveUbo: GPUBuffer;
  private _resolve: GPURenderPipeline | null = null;
  private _resolveBind: GPUBindGroup | null = null;

  /**
   * `format` defaults to the best single channel float format of the device.
   * Pass `ownTarget: false` and a matching `format` to splat only into
   * targets owned by someone else (see `encode`).
   */
  constructor(device: GPUDevice, opts: { mode?: SplatMode; format?: GPUTextureFormat; fixedScale?: number; ownTarget?: boolean } = {}) {
    this.device = device;
    this.mode = opts.mode ?? 'quad';
    this.format = opts.format ?? pickHdrFormat(device);
    this.fixedScale = opts.fixedScale ?? 256;
    this._ownTarget = opts.ownTarget ?? true;
    this._resolveUbo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  resize(width: number, height: number): void {
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    if (this._ownTarget) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        size: [width, height],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.view = this.texture.createView();
    }
    this._grid?.destroy();
    this._grid = null;
    this._resolveBind = null;
    for (const s of this._slots) s.bind = null;
  }

  /**
   * Open an additive render pass on the density target. Use this to draw
   * particles with your own pipeline: the target format is `this.format`,
   * blend must be one + one, and only the red channel is read downstream.
   */
  beginPass(encoder: GPUCommandEncoder, target?: SplatTarget): GPURenderPassEncoder {
    const view = target?.view ?? this.view;
    if (!view) throw new Error('SplatAccumulator: no target. Call resize() or pass a target.');
    return encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: (target?.clear ?? true) ? 'clear' : 'load',
        clearValue: [0, 0, 0, 0],
        storeOp: 'store',
      }],
    });
  }

  /**
   * Splat all batches into the density target.
   *
   * `frame` is a frame counter that decorrelates stochastic rounding.
   * `target` redirects the output to another texture of format `this.format`
   * and the size given to `resize`. Without it the accumulator's own texture
   * is cleared and filled.
   */
  encode(encoder: GPUCommandEncoder, batches: readonly SplatBatch[], frame = 0, target?: SplatTarget): void {
    if (!this.width) throw new Error('SplatAccumulator: call resize() before encode()');
    for (let i = 0; i < batches.length; i++) this._writeBatch(i, batches[i], frame);
    if (this.mode === 'compute') this._encodeCompute(encoder, batches, target);
    else this._encodeRaster(encoder, batches, target);
  }

  private _slot(i: number): Slot {
    while (this._slots.length <= i) {
      this._slots.push({
        ubo: this.device.createBuffer({ size: UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        bind: null,
        pipeline: null,
        buffer: null,
        grid: null,
      });
    }
    return this._slots[i];
  }

  private _writeBatch(i: number, b: SplatBatch, frame: number): void {
    const f = this._f32;
    const u = this._u32;
    f.set(b.mvp, 0);
    f[16] = this.width;
    f[17] = this.height;
    f[18] = b.energy ?? 1;
    f[19] = b.size ?? 1;
    f[20] = b.attenuate ? 1 : 0;
    f[21] = b.maxSize ?? 64;
    u[22] = b.count;
    u[23] = b.first ?? 0;
    u[24] = frame >>> 0;
    f[25] = this.fixedScale;
    u[26] = this.width;
    u[27] = this.height;
    this.device.queue.writeBuffer(this._slot(i).ubo, 0, this._scratch);
  }

  private _rasterPipeline(mode: 'point' | 'quad', b: SplatBatch): GPURenderPipeline {
    const stride = b.stride ?? 16;
    const offset = b.offset ?? 0;
    const dims = b.dims ?? 3;
    const key = `${mode}:${stride}:${offset}:${dims}`;
    let p = this._raster.get(key);
    if (p) return p;
    const quad = mode === 'quad';
    const module = this.device.createShaderModule({ code: quad ? QUAD_WGSL : POINT_WGSL });
    p = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: stride,
          stepMode: quad ? 'instance' : 'vertex',
          // A two component attribute feeding a vec3f leaves z at 0.
          attributes: [{ shaderLocation: 0, offset, format: dims === 3 ? 'float32x3' : 'float32x2' }],
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: ADD }] },
      primitive: { topology: quad ? 'triangle-strip' : 'point-list' },
    });
    this._raster.set(key, p);
    return p;
  }

  private _computePipeline(b: SplatBatch): GPUComputePipeline {
    const stride = b.stride ?? 16;
    const offset = b.offset ?? 0;
    const dims = b.dims ?? 3;
    if (stride % 4 || offset % 4) throw new Error('compute splatting needs stride and offset in multiples of 4 bytes');
    const key = `${stride}:${offset}:${dims}`;
    let p = this._compute.get(key);
    if (p) return p;
    const module = this.device.createShaderModule({ code: computeWgsl(stride / 4, offset / 4, dims) });
    p = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this._compute.set(key, p);
    return p;
  }

  private _encodeRaster(encoder: GPUCommandEncoder, batches: readonly SplatBatch[], target?: SplatTarget): void {
    const mode = this.mode === 'quad' ? 'quad' : 'point';
    const pass = this.beginPass(encoder, target);
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      if (!b.count) continue;
      const pipeline = this._rasterPipeline(mode, b);
      const slot = this._slots[i];
      if (!slot.bind || slot.pipeline !== pipeline) {
        slot.bind = this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: slot.ubo } }],
        });
        slot.pipeline = pipeline;
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, slot.bind);
      pass.setVertexBuffer(0, b.buffer);
      if (mode === 'quad') pass.draw(4, b.count, 0, b.first ?? 0);
      else pass.draw(b.count, 1, b.first ?? 0, 0);
    }
    pass.end();
  }

  private _encodeCompute(encoder: GPUCommandEncoder, batches: readonly SplatBatch[], target?: SplatTarget): void {
    const device = this.device;
    const grid = (this._grid ??= device.createBuffer({
      size: this.width * this.height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    }));
    encoder.clearBuffer(grid);
    const pass = encoder.beginComputePass();
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      if (!b.count) continue;
      const pipeline = this._computePipeline(b);
      const slot = this._slots[i];
      if (!slot.bind || slot.pipeline !== pipeline || slot.buffer !== b.buffer || slot.grid !== grid) {
        slot.bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: slot.ubo } },
            { binding: 1, resource: { buffer: b.buffer } },
            { binding: 2, resource: { buffer: grid } },
          ],
        });
        slot.pipeline = pipeline;
        slot.buffer = b.buffer;
        slot.grid = grid;
      }
      const groups = Math.ceil(b.count / WORKGROUP);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, slot.bind);
      pass.dispatchWorkgroups(Math.min(groups, ROW_GROUPS), Math.ceil(groups / ROW_GROUPS));
    }
    pass.end();

    if (!this._resolve) {
      const module = device.createShaderModule({ code: RESOLVE_WGSL });
      this._resolve = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        // Additive, so the counters can be added onto a target that already
        // holds something. Float formats that cannot blend fall back to replace.
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this._blendable() ? ADD : undefined }] },
      });
    }
    this._resolveBind ??= device.createBindGroup({
      layout: this._resolve.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._resolveUbo } },
        { binding: 1, resource: { buffer: grid } },
      ],
    });
    const r = new ArrayBuffer(16);
    new Uint32Array(r)[0] = this.width;
    new Float32Array(r)[1] = 1 / this.fixedScale;
    device.queue.writeBuffer(this._resolveUbo, 0, r);
    const rp = this.beginPass(encoder, target);
    rp.setPipeline(this._resolve);
    rp.setBindGroup(0, this._resolveBind);
    rp.draw(3);
    rp.end();
  }

  private _blendable(): boolean {
    return !this.format.includes('32float') || this.device.features.has('float32-blendable');
  }

  destroy(): void {
    this.texture?.destroy();
    this._grid?.destroy();
    this._resolveUbo.destroy();
    for (const s of this._slots) s.ubo.destroy();
  }
}
