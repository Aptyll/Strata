// Demo for CountToneMapper: a synthetic hit counter image with the range of
// the trillion particle render (about 120,000 hits per pixel on average,
// spanning single hits to hundreds of millions), tone mapped straight from
// the integer buffer.
//
// URL: ?words=2 for 64 bit counters, ?mean=120000 for the mean hits per
// pixel, ?offscreen for headless runs (see demo.ts).

import { CountToneMapper, type Display } from '../index';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info')!;

if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('No WebGPU adapter found.');
const device = await adapter.requestDevice({
  requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
});
device.addEventListener('uncapturederror', (e) => console.error('GPU error:', e.error.message));

const format = navigator.gpu.getPreferredCanvasFormat();
const offscreen = params.has('offscreen');
const ctx = offscreen ? null : canvas.getContext('webgpu')!;
ctx?.configure({ device, format, alphaMode: 'opaque' });

const words = num('words', 1) === 2 ? 2 : 1;
const width = num('w', 1280);
const height = num('h', 720);
canvas.width = width;
canvas.height = height;

// ---- synthetic counters ----------------------------------------------------
// Density = exp(field): a few sharp cores, filaments between them and a wide
// faint halo, so the image has detail at every order of magnitude. Normalised
// so the mean over all pixels is `mean`.
function synth(mean: number): { data: Uint32Array<ArrayBuffer>; max: number; total: number } {
  const f = new Float64Array(width * height);
  let sum = 0;
  const cores = [[0.3, 0.4, 0.004], [0.62, 0.55, 0.002], [0.5, 0.25, 0.008], [0.75, 0.3, 0.003]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = (y / height - 0.5) * (height / width) + 0.5 * (height / width) + 0.1;
      let d = 0;
      for (const [cx, cy, r] of cores) {
        const q = (u - cx) ** 2 + (v - cy) ** 2;
        d += 1 / (q / r + 0.00002) + 40 * Math.exp(-q / 0.03);
      }
      const fil = Math.sin(u * 37 + Math.sin(v * 23) * 2.5) * Math.sin(v * 31 + Math.cos(u * 19) * 2.5);
      d *= 0.35 + Math.exp(-60 * (1 - Math.abs(fil)) ** 2) * 3;
      const edge = Math.max(0, 1 - ((u - 0.5) ** 2 + (v - 0.4) ** 2) / 0.2);
      f[y * width + x] = d * edge * edge;
      sum += f[y * width + x];
    }
  }
  const k = (mean * width * height) / sum;
  const data = new Uint32Array(width * height * words);
  let max = 0;
  let total = 0;
  for (let i = 0; i < f.length; i++) {
    // Poisson-like noise, as real hit counts have.
    const m = f[i] * k;
    const n = Math.max(0, Math.round(m + Math.sqrt(m) * (Math.random() + Math.random() + Math.random() - 1.5) * 2));
    max = Math.max(max, n);
    total += n;
    if (words === 2) {
      data[2 * i] = n >>> 0;
      data[2 * i + 1] = Math.floor(n / 4294967296);
    } else {
      data[i] = Math.min(n, 4294967295);
    }
  }
  return { data, max, total };
}

const src = synth(num('mean', 120_000));
const counters = device.createBuffer({ size: src.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(counters, 0, src.data);

// ---- tone mapping ----------------------------------------------------------

const mapper = new CountToneMapper(device, { format, words });
mapper.resize(width, height);
const tone = mapper.post.settings.tone;
const bloom = mapper.post.settings.bloom;

let mode = 'auto';
let chosen = '';
async function expose(): Promise<void> {
  if (mode === 'auto') {
    const h = await mapper.measure(counters);
    const e = mapper.autoExpose(h);
    chosen = e ? `black ${Math.round(e.black).toLocaleString()}  white ${Math.round(e.whiteCount).toLocaleString()}  lit ${((100 * h.lit) / h.pixels).toFixed(1)}%` : 'empty';
  } else if (mode === 'fixed-64') {
    // The white point that suits single particles: everything is blown out.
    tone.exposure = 1;
    tone.white = 64;
    chosen = 'fixed white = 64 hits';
  } else {
    // White at the brightest pixel, no black point: only the cores survive.
    tone.exposure = 1;
    tone.white = src.max;
    chosen = 'fixed white = max hits, black = 1';
  }
}
await expose();

const displays: Display[] = ['soft', 'filmic', 'clip'];
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'a') mode = 'auto';
  if (k === '1') mode = 'fixed-64';
  if (k === '2') mode = 'fixed-max';
  if (k === 'd') tone.display = displays[(displays.indexOf(tone.display) + 1) % displays.length];
  if (k === 'c') tone.contrast = ((tone.contrast ?? 1) >= 2 ? 0.5 : (tone.contrast ?? 1) + 0.25);
  if (k === 'b') bloom.enabled = !bloom.enabled;
  void expose();
});

let offscreenTex: GPUTexture | null = null;
function draw(target: GPUTextureView): void {
  const encoder = device.createCommandEncoder();
  mapper.encode(encoder, counters, target);
  device.queue.submit([encoder.finish()]);
}
function frame(): void {
  if (ctx) draw(ctx.getCurrentTexture().createView());
  else draw((offscreenTex ??= device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT })).createView());
  info.textContent =
    `${words === 2 ? 'u64' : 'u32'} counters  ${width} x ${height}\n` +
    `${src.total.toExponential(2)} hits  mean ${Math.round(src.total / (width * height)).toLocaleString()}  max ${src.max.toLocaleString()}\n` +
    `${mode}: ${chosen}\ndisplay ${tone.display}  contrast ${tone.contrast ?? 1}  bloom ${bloom.enabled ? 'on' : 'off'}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Render offscreen and read back RGBA bytes, for headless checks. */
async function capture(): Promise<{ width: number; height: number; data: Uint8Array }> {
  const tex = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  draw(tex.createView());
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [width, height]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buf.getMappedRange());
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  buf.unmap();
  buf.destroy();
  tex.destroy();
  return { width, height, data };
}

Object.assign(window, { strataCounts: { device, mapper, capture, setMode: async (m: string) => { mode = m; await expose(); }, info: () => chosen } });
