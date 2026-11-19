// Demo page for the render pipeline: `npm run dev`, then open
// /src/render/demo/ on the dev server.
//
// Every control can also be set from the URL, for example
//   ?count=8000000&mode=compute&curve=log&trail=0.3
// Add &clean to hide the panel, and &fixedDt=0.0166 for a fixed time step.
// &offscreen never presents to the canvas: frames go to a texture and are
// only visible through `strataDemo.capture()`. That is for headless browsers
// with a software GPU, which can lose the device on the first present.

import { DensityRenderer, type SplatBatch, type SplatMode, type Curve, type Display, type TrailMode } from '../index';
import { mat4LookAt, mat4Multiply, mat4Perspective, planeModelMatrix } from '../../math';
import type { PlaneDesc } from '../../core/contracts';
import { DemoSim } from './sim';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const str = <T extends string>(k: string, d: T): T => (params.get(k) as T | null) ?? d;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ui = document.getElementById('ui')!;
const stats = document.getElementById('stats')!;
const hint = document.getElementById('hint')!;

function fail(text: string): never {
  const m = document.getElementById('msg')!;
  m.style.display = 'grid';
  m.textContent = text;
  throw new Error(text);
}

if (!navigator.gpu) fail('WebGPU is not available in this browser.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter found.');
const wanted: GPUFeatureName[] = ['float32-blendable'];
const device = await adapter.requestDevice({
  requiredFeatures: wanted.filter((f) => adapter.features.has(f)),
  requiredLimits: {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  },
});
device.addEventListener('uncapturederror', (e) => console.error('GPU error:', e.error.message));
void device.lost.then((info) => console.error(`GPU device lost (${info.reason}): ${info.message}`));

const format = navigator.gpu.getPreferredCanvasFormat();
const offscreen = params.has('offscreen');
const ctx = offscreen ? null : canvas.getContext('webgpu')!;
ctx?.configure({ device, format, alphaMode: 'opaque' });
let offscreenTex: GPUTexture | null = null;

const maxCount = Math.floor(Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize) / 16);

const state = {
  count: Math.min(num('count', 4_000_000), maxCount),
  planes: num('planes', 12),
  spacing: num('spacing', 0.16),
  mode: str<SplatMode>('mode', 'compute'),
  size: num('size', 1),
  energy: num('energy', 1),
  exposure: num('exposure', 1),
  white: num('white', 0), // 0 = follow particle count
  curve: str<Curve>('curve', 'log'),
  display: str<Display>('display', 'soft'),
  bloom: num('bloom', 0.35),
  threshold: num('threshold', 0.55),
  trail: num('trail', 0.12),
  trailMode: str<TrailMode>('trailMode', 'max'),
  speed: num('speed', 1),
  spin: num('spin', 0.08),
  yaw: num('yaw', 0.6),
  pitch: num('pitch', 0.35),
  dist: num('dist', 3.2),
};
type State = typeof state;
type NumKey = { [K in keyof State]: State[K] extends number ? K : never }[keyof State];
type StrKey = Exclude<keyof State, NumKey>;

const renderer = new DensityRenderer(device, { format, mode: state.mode });
let sim = new DemoSim(device, state.count);

// ---- controls ------------------------------------------------------------

interface RangeOpts { min: number; max: number; step: number; log?: boolean; lazy?: boolean; fmt?: (v: number) => string }
const fmtCount = (n: number): string => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : Math.round(n / 1e3) + 'k');

function heading(text: string): void {
  const h = document.createElement('h2');
  h.textContent = text;
  ui.append(h);
}
function row(label: string): HTMLLabelElement {
  const r = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  r.append(name);
  ui.append(r);
  return r;
}
function range(key: NumKey, label: string, o: RangeOpts): void {
  const inp = document.createElement('input');
  const val = document.createElement('span');
  inp.type = 'range';
  inp.min = String(o.min);
  inp.max = String(o.max);
  inp.step = String(o.step);
  inp.value = String(o.log ? Math.log2(state[key]) : state[key]);
  const read = (): number => (o.log ? Math.min(Math.round(2 ** Number(inp.value)), maxCount) : Number(inp.value));
  const show = (): void => { val.textContent = o.fmt ? o.fmt(read()) : String(read()); };
  inp.oninput = () => { show(); if (!o.lazy) state[key] = read(); };
  inp.onchange = () => { state[key] = read(); };
  show();
  row(label).append(inp, val);
}
function select<K extends StrKey>(key: K, label: string, options: readonly State[K][]): void {
  const sel = document.createElement('select');
  for (const v of options) sel.add(new Option(v, v));
  sel.value = state[key];
  sel.onchange = () => { state[key] = sel.value as State[K]; };
  row(label).append(sel);
}

const title = document.createElement('h1');
title.textContent = 'STRATA RENDER';
ui.append(title);
heading('PARTICLES');
range('count', 'count', { min: Math.log2(1e5), max: Math.log2(maxCount), step: 0.01, log: true, fmt: fmtCount, lazy: true });
range('planes', 'planes', { min: 1, max: 64, step: 1 });
range('spacing', 'spacing', { min: 0, max: 0.5, step: 0.005 });
range('speed', 'speed', { min: 0, max: 4, step: 0.05 });
heading('SPLAT');
select('mode', 'mode', ['point', 'quad', 'compute']);
range('size', 'size px', { min: 0.1, max: 6, step: 0.05 });
range('energy', 'energy', { min: 0.05, max: 4, step: 0.05 });
heading('TONE');
select('curve', 'curve', ['log', 'power', 'linear']);
select('display', 'display', ['soft', 'filmic', 'clip']);
range('exposure', 'exposure', { min: 0.05, max: 16, step: 0.05 });
range('white', 'white', { min: 0, max: 4096, step: 1, fmt: (v) => (v ? String(v) : 'auto') });
heading('BLOOM');
range('bloom', 'strength', { min: 0, max: 2, step: 0.01 });
range('threshold', 'threshold', { min: 0, max: 1.5, step: 0.01 });
heading('TRAILS');
select('trailMode', 'mode', ['max', 'ema']);
range('trail', 'half life s', { min: 0, max: 2, step: 0.01 });
heading('CAMERA');
range('spin', 'spin', { min: -1, max: 1, step: 0.01 });

let paused = false;
function toggleChrome(): void {
  for (const el of [ui, stats, hint]) el.classList.toggle('hidden');
}
addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') toggleChrome();
  if (e.key === ' ') paused = !paused;
});
if (params.has('clean')) toggleChrome();

let drag: [number, number] | null = null;
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  state.yaw -= (e.clientX - drag[0]) * 0.005;
  state.pitch = Math.max(-1.55, Math.min(1.55, state.pitch + (e.clientY - drag[1]) * 0.005));
  drag = [e.clientX, e.clientY];
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.dist = Math.max(0.05, Math.min(40, state.dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });

// ---- camera --------------------------------------------------------------

type V3 = [number, number, number];
// Orbit camera matrices, rebuilt every frame (column major, src/math.ts).
const proj = new Float32Array(16);
const view = new Float32Array(16);
const viewProj = new Float32Array(16);

// ---- frame ---------------------------------------------------------------

function resize(): void {
  const dpr = num('dpr', window.devicePixelRatio || 1);
  const lim = device.limits.maxTextureDimension2D;
  const w = Math.max(1, Math.min(Math.round(canvas.clientWidth * dpr), lim));
  const h = Math.max(1, Math.min(Math.round(canvas.clientHeight * dpr), lim));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  renderer.resize(w, h);
  if (offscreen && (offscreenTex?.width !== w || offscreenTex.height !== h)) {
    offscreenTex?.destroy();
    offscreenTex = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
}

let simTime = num('t', 0);

/** Encode simulation and rendering of the current state into `target`. */
function draw(target: GPUTextureView, dt: number): void {
  const pixels = canvas.width * canvas.height;
  const s = renderer.settings;
  renderer.mode = state.mode;
  s.tone.curve = state.curve;
  s.tone.display = state.display;
  // Auto black and white points from the mean energy per pixel, so the
  // picture keeps its balance when the particle count changes. Without the
  // black point the log curve's toe stays at one particle and dense frames
  // drift toward white (docs/render.md, "Tone mapping").
  const mean = (sim.count * state.energy * Math.min(state.size, 64) ** 2) / pixels;
  const black = state.white ? 1 : Math.max(1, mean / 4);
  s.tone.exposure = state.exposure / black;
  s.tone.white = state.white || Math.max(12, mean * 24) / black;
  s.bloom.strength = state.bloom;
  s.bloom.threshold = state.threshold;
  s.trails.halfLife = state.trail;
  s.trails.mode = state.trailMode;

  const cp = Math.cos(state.pitch);
  const eye: V3 = [state.dist * cp * Math.sin(state.yaw), state.dist * Math.sin(state.pitch), state.dist * cp * Math.cos(state.yaw)];
  mat4Perspective(proj, 0.9, canvas.width / canvas.height, 0.01, 100);
  mat4LookAt(view, eye, [0, 0, 0], [0, 1, 0]);
  mat4Multiply(viewProj, proj, view);

  // One batch per plane, the way the engine hands planes over: a range of
  // plane-local 2D particles plus a model matrix.
  const planes = Math.max(1, Math.min(state.planes, sim.count));
  const per = Math.floor(sim.count / planes);
  const batches: SplatBatch[] = [];
  for (let p = 0; p < planes; p++) {
    const desc: PlaneDesc = {
      position: [0, 0, (p - (planes - 1) / 2) * state.spacing],
      rotation: [0, 0, 0, 1],
      halfSize: [1, 1],
      behaviorId: 'demo',
      particleCount: per,
      seed: 0,
    };
    batches.push({
      buffer: sim.buffer,
      first: p * per,
      count: p === planes - 1 ? sim.count - p * per : per,
      stride: 16,
      dims: 2,
      mvp: mat4Multiply(new Float32Array(16), viewProj, planeModelMatrix(desc)),
      energy: state.energy,
      size: state.size,
    });
  }

  const encoder = device.createCommandEncoder();
  sim.encode(encoder, simTime, planes);
  renderer.render(encoder, { batches, target, dt });
  device.queue.submit([encoder.finish()]);
}

let last = performance.now();
let fps = 0;
let frames = 0;
let fpsAt = last;
let total = 0;
const fixedDt = num('fixedDt', 0);

function frame(now: number): void {
  const dt = fixedDt || Math.min(0.1, (now - last) / 1000);
  last = now;
  resize();
  if (state.count !== sim.count) {
    sim.destroy();
    sim = new DemoSim(device, state.count);
  }
  if (!paused) {
    simTime += dt * state.speed;
    state.yaw += dt * state.spin;
  }
  draw((ctx ? ctx.getCurrentTexture() : offscreenTex!).createView(), dt);

  frames++;
  total++;
  if (now - fpsAt > 500) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
  }
  const pixels = canvas.width * canvas.height;
  stats.textContent = '';
  const big = document.createElement('b');
  big.textContent = `${(sim.count / pixels).toFixed(1)}x`;
  stats.append(
    big,
    `\nparticles per pixel\n\n${sim.count.toLocaleString()} particles\n` +
      `${canvas.width} x ${canvas.height} = ${pixels.toLocaleString()} px\n` +
      `${fps.toFixed(0)} fps  ${renderer.splat.format}`,
  );
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- test hook -----------------------------------------------------------

/** Render the current state offscreen and read it back as RGBA bytes. */
async function capture(): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { width, height } = canvas;
  const tex = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  draw(tex.createView(), 0);
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [width, height]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  buf.unmap();
  buf.destroy();
  tex.destroy();
  return { width, height, data };
}

Object.assign(window, { strataDemo: { device, renderer, state, capture, frames: () => total } });
