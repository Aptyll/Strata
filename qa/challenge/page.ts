// Visual QA harness for the challenge render path: src/render, src/capture,
// src/challenge, src/offline (with src/stateless keys) and src/trillion.
//
// Every scenario renders a fixed, deterministic sequence offscreen, reads it
// back and hands the raw bytes to qa/challenge/run.mjs through window.qaSave.
// Nothing here presents to a canvas: the cloud sandbox's software GPU loses
// the device on the first present, and offscreen readback is exact anyway.
//
// The particle source is the render demo's stateless DemoSim, so frames go
// through the same splat, trails, bloom and tone map code the app and the
// offline renders use. Timings mean nothing on a software GPU and are not
// recorded.

import {
  CountToneMapper,
  DensityRenderer,
  DensityPost,
  type SplatBatch,
  type SplatMode,
  type Curve,
  type Display,
  type TrailMode,
} from '../../src/render/index';
import { mat4Multiply, planeModelMatrix } from '../../src/math';
import { DemoSim } from '../../src/render/demo/sim';
import { Resampler } from '../../src/capture/util';
import { startRecording, type CaptureCodec } from '../../src/capture/index';
import type { PlaneDesc } from '../../src/core/contracts';
import { ChallengeEngine, stackLayout, type ChallengeMode } from '../../src/challenge/index';
import { createCamera } from '../../src/ux/camera/index';
import { clusterJob, PRESETS } from '../../src/offline/core/world';
import { renderJob, gradeJob, loadStats, frameImageName, frameStatsName, defaultLabel } from '../../src/offline/core/session';
import { StatelessRenderer } from '../../src/offline/core/renderer';
import { CameraPath } from '../../src/offline/core/camera';
import { cameraBasis, planeHomography as offlineHomography } from '../../src/offline/core/math';
import { decodeGrayPng16 } from '../../src/offline/core/png';
import { memoryStore, browserZlib } from '../../src/offline/web/platform';
import { DEFAULT_LOOK as GRADE_LOOK, drawLabel, exposureTrack, gradeFrame, toneTable, type Look as GradeLook } from '../../src/offline/core/grade';
import type { FrameStats } from '../../src/offline/core/develop';
import {
  TrillionKernel,
  planeHomography,
  renderFrame as renderTrillionFrame,
  trillionLimits,
  STANDIN_LAWS,
  type TrillionPlane,
} from '../../src/trillion/index';

declare global {
  interface Window {
    /** Provided by run.mjs: writes one file into the run's output folder. */
    qaSave?: (name: string, base64: string, meta: string) => Promise<void>;
  }
}

const logEl = document.getElementById('log')!;
const log = (s: string): void => {
  logEl.textContent += '\n' + s;
  console.log(s);
};

// ---- device ------------------------------------------------------------------

const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) throw new Error('qa: no WebGPU adapter');
const device = await adapter.requestDevice({
  requiredFeatures: (['float32-blendable'] as GPUFeatureName[]).filter((f) => adapter.features.has(f)),
  requiredLimits: {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  },
});
device.addEventListener('uncapturederror', (e) => console.error('GPU error: ' + (e as GPUUncapturedErrorEvent).error.message));
void device.lost.then((i) => console.error(`GPU device lost (${i.reason}): ${i.message}`));

/** Output format. Monochrome, so the channel order does not matter, but RGBA keeps readback simple. */
const FORMAT: GPUTextureFormat = 'rgba8unorm';
const MAX_COUNT = Math.floor(Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize) / 16);

// ---- io ----------------------------------------------------------------------

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function save(name: string, bytes: Uint8Array, meta: object): Promise<void> {
  if (!window.qaSave) throw new Error('qa: window.qaSave is missing; run through qa/challenge/run.mjs');
  await window.qaSave(name, base64(bytes), JSON.stringify(meta));
}

async function readTexture(tex: GPUTexture, bytesPerPixel: number, dev: GPUDevice = device): Promise<Uint8Array> {
  const { width, height } = tex;
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const buf = dev.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [width, height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(width * height * bytesPerPixel);
  const row = width * bytesPerPixel;
  for (let y = 0; y < height; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + row), y * row);
  buf.unmap();
  buf.destroy();
  return out;
}

const BYTES: Partial<Record<GPUTextureFormat, number>> = { r32float: 4, r16float: 2, rgba16float: 8, rgba8unorm: 4 };

/** Downscale exactly the way src/capture does for supersampled stills and video. */
async function resampleLikeCapture(rgba: Uint8Array, sw: number, sh: number, w: number, h: number): Promise<Uint8Array> {
  const img = new ImageData(new Uint8ClampedArray(rgba), sw, sh);
  const bmp = await createImageBitmap(img);
  const rs = new Resampler(w, h, '#000');
  rs.draw(bmp, sw, sh);
  bmp.close();
  const ctx = rs.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  return new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
}

// ---- camera (same model as the render demo) ------------------------------------

type V3 = [number, number, number];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** a * b, column major, into a new matrix. */
const mulMat4 = (a: ArrayLike<number>, b: ArrayLike<number>): Float32Array => mat4Multiply(new Float32Array(16), a, b);

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const o = new Float32Array(16);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = far / (near - far);
  o[11] = -1;
  o[14] = (near * far) / (near - far);
  return o;
}
function lookAt(eye: V3, target: V3, up: V3): Float32Array {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

interface Cam {
  yaw: number;
  pitch: number;
  dist: number;
  fov: number;
}
function viewProj(c: Cam, aspect: number): Float32Array {
  const cp = Math.cos(c.pitch);
  const eye: V3 = [c.dist * cp * Math.sin(c.yaw), c.dist * Math.sin(c.pitch), c.dist * cp * Math.cos(c.yaw)];
  return mulMat4(perspective(c.fov, aspect, 0.01, 100), lookAt(eye, [0, 0, 0], [0, 1, 0]));
}

// ---- shots -------------------------------------------------------------------

/** The look. Defaults are the render demo's defaults, which is what the app ships. */
export interface Look {
  mode: SplatMode;
  energy: number;
  size: number;
  exposure: number;
  /** 0 = auto: max(12, whiteFactor * mean energy per pixel), as in the render demo. */
  white: number;
  whiteFactor: number;
  curve: Curve;
  display: Display;
  dither: number;
  bloom: number;
  threshold: number;
  /** Trail half life in seconds, 0 = off. */
  trail: number;
  trailMode: TrailMode;
  fixedScale: number;
}
const DEFAULT_LOOK: Look = {
  mode: 'compute', energy: 1, size: 1, exposure: 1, white: 0, whiteFactor: 24, curve: 'log', display: 'soft',
  dither: 1, bloom: 0.35, threshold: 0.55, trail: 0.12, trailMode: 'max', fixedScale: 256,
};

export interface Shot {
  tag: string;
  count: number;
  planes: number;
  spacing: number;
  width: number;
  height: number;
  /** Render at this multiple per axis, then downscale with src/capture's Resampler. */
  supersample: number;
  cam: Cam;
  /** Camera yaw in radians per second of video time. */
  spin: number;
  /** Simulation seconds per second of video time. */
  speed: number;
  t0: number;
  dt: number;
  frames: number;
  /** Frames rendered before the first saved one, so trails reach a steady state. */
  warmup: number;
  look: Look;
  /** Pixel count used for the auto white point: the render target (what the app does when capture resizes the canvas) or the output. */
  whitePixels: 'render' | 'output';
  /** Also save each frame's raw density (before trails). */
  density: boolean;
}
const DEFAULT_SHOT: Shot = {
  tag: 'shot', count: 2_000_000, planes: 12, spacing: 0.16, width: 960, height: 540, supersample: 1,
  cam: { yaw: 0.6, pitch: 0.35, dist: 3.2, fov: 0.9 }, spin: 0.08, speed: 1, t0: 3, dt: 1 / 60, frames: 1, warmup: 0,
  look: DEFAULT_LOOK, whitePixels: 'render', density: false,
};
type ShotIn = Partial<Omit<Shot, 'look' | 'cam'>> & { look?: Partial<Look>; cam?: Partial<Cam> };
function shot(o: ShotIn): Shot {
  return { ...DEFAULT_SHOT, ...o, cam: { ...DEFAULT_SHOT.cam, ...o.cam }, look: { ...DEFAULT_LOOK, ...o.look } };
}

let sim: DemoSim | null = null;
function demoSim(count: number): DemoSim {
  if (!sim || sim.count !== count) {
    sim?.destroy();
    sim = new DemoSim(device, count);
  }
  return sim;
}

interface Frame {
  k: number;
  rgba: Uint8Array;
  width: number;
  height: number;
  density: Uint8Array | null;
  meta: Record<string, unknown>;
}

/** Render a shot frame by frame. Frame k is at video time t0 + k * dt. */
async function render(s: Shot, onFrame: (f: Frame) => Promise<void>): Promise<void> {
  const ss = Math.max(1, Math.round(s.supersample));
  const W = s.width * ss;
  const H = s.height * ss;
  const count = Math.min(s.count, MAX_COUNT);
  const src = demoSim(count);
  const r = new DensityRenderer(device, { format: FORMAT, mode: s.look.mode });
  r.splat.fixedScale = s.look.fixedScale;
  r.resize(W, H);
  const L = s.look;
  const set = r.settings;
  const pixels = s.whitePixels === 'output' ? s.width * s.height : W * H;
  const mean = (count * L.energy * Math.min(L.size, 64) ** 2) / pixels;
  const white = L.white || Math.max(12, mean * L.whiteFactor);
  Object.assign(set.tone, { exposure: L.exposure, white, curve: L.curve, display: L.display, dither: L.dither });
  Object.assign(set.bloom, { enabled: L.bloom > 0, strength: L.bloom, threshold: L.threshold });
  Object.assign(set.trails, { enabled: L.trail > 0, halfLife: L.trail, mode: L.trailMode });
  const target = device.createTexture({ size: [W, H], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const planes = Math.max(1, Math.min(s.planes, count));
  const per = Math.floor(count / planes);
  try {
    for (let k = -s.warmup; k < s.frames; k++) {
      const t = s.t0 + k * s.dt;
      const vp = viewProj({ ...s.cam, yaw: s.cam.yaw + s.spin * t }, W / H);
      const batches: SplatBatch[] = [];
      for (let p = 0; p < planes; p++) {
        const desc: PlaneDesc = {
          position: [0, 0, (p - (planes - 1) / 2) * s.spacing], rotation: [0, 0, 0, 1], halfSize: [1, 1],
          behaviorId: 'demo', particleCount: per, seed: 0,
        };
        batches.push({
          buffer: src.buffer, first: p * per, count: p === planes - 1 ? count - p * per : per, stride: 16, dims: 2,
          mvp: mulMat4(vp, planeModelMatrix(desc)), energy: L.energy, size: L.size,
        });
      }
      const enc = device.createCommandEncoder();
      src.encode(enc, t * s.speed, planes);
      r.render(enc, { batches, target: target.createView(), dt: s.dt });
      device.queue.submit([enc.finish()]);
      if (k < 0) {
        await device.queue.onSubmittedWorkDone();
        continue;
      }
      let rgba = await readTexture(target, 4);
      if (ss > 1) rgba = await resampleLikeCapture(rgba, W, H, s.width, s.height);
      const dfmt = r.splat.format;
      const density = s.density && r.splat.texture ? await readTexture(r.splat.texture, BYTES[dfmt] ?? 4) : null;
      await onFrame({
        k, rgba, width: s.width, height: s.height, density,
        meta: {
          scenario: s.tag, k, t, simTime: t * s.speed, count, planes, renderWidth: W, renderHeight: H, supersample: ss,
          width: s.width, height: s.height, white, meanEnergyPerPixel: mean, look: L, cam: s.cam, spin: s.spin,
          densityFormat: dfmt, whitePixels: s.whitePixels,
        },
      });
    }
  } finally {
    target.destroy();
    r.destroy();
  }
}

/** Render a shot and save every frame (and its density) under `tag`. */
async function saveShot(o: ShotIn): Promise<Record<string, unknown>[]> {
  const s = shot(o);
  const metas: Record<string, unknown>[] = [];
  await render(s, async (f) => {
    const name = `${s.tag}-f${f.k}`;
    await save(`${name}.rgba`, f.rgba, f.meta);
    if (f.density) await save(`${name}.density`, f.density, f.meta);
    metas.push(f.meta);
    log(`saved ${name}`);
  });
  return metas;
}

// ---- scenarios ------------------------------------------------------------------

/** Peak and percentiles of a density readback (r32float only). */
function densityStats(bytes: Uint8Array): { max: number; p999: number; mean: number } {
  const d = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const sorted = Float32Array.from(d).sort();
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += d[i];
  return { max: sorted[sorted.length - 1], p999: sorted[Math.floor(sorted.length * 0.999)], mean: sum / d.length };
}

/**
 * The same frame through CountToneMapper (src/render/counts.ts) and its
 * percentile auto exposure, the class docs/render.md points to for huge
 * counts. The compute splat's density is its u32 counter grid divided by
 * fixedScale, so multiplying back rebuilds the counters (exactly below 2^24
 * units, to float precision above). Bloom, display and dither match `look`.
 */
async function countsLook(density: Uint8Array, W: number, H: number, fixedScale: number, look: Look): Promise<{ rgba: Uint8Array; exposure: number; white: number }> {
  const d = new Float32Array(density.buffer, density.byteOffset, density.byteLength / 4);
  const counts = new Uint32Array(d.length);
  for (let i = 0; i < d.length; i++) counts[i] = Math.min(0xffffffff, Math.round(d[i] * fixedScale));
  const buf = device.createBuffer({ size: counts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, counts);
  const mapper = new CountToneMapper(device, { format: FORMAT, words: 1, scale: fixedScale });
  mapper.resize(W, H);
  const set = mapper.post.settings;
  Object.assign(set.tone, { display: look.display, dither: look.dither });
  Object.assign(set.bloom, { enabled: look.bloom > 0, strength: look.bloom, threshold: look.threshold });
  await mapper.measureAndExpose(buf);
  const target = device.createTexture({ size: [W, H], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const enc = device.createCommandEncoder();
  mapper.encode(enc, buf, target.createView());
  device.queue.submit([enc.finish()]);
  const rgba = await readTexture(target, 4);
  const out = { rgba, exposure: set.tone.exposure, white: set.tone.white };
  target.destroy();
  buf.destroy();
  mapper.destroy();
  return out;
}

// ---- challenge mode (src/challenge) ------------------------------------------

interface ChallengeShot {
  tag: string;
  mode: ChallengeMode;
  count: number;
  width?: number;
  height?: number;
  planes?: number;
  warmup?: number;
  frames?: number;
  dt?: number;
  /** Resolve exposure. Default: the engine's. */
  exposure?: number;
}

/** Challenge mode's own kernel and resolve, with its page's world and camera, rendered offscreen. */
async function challengeShot(s: ChallengeShot): Promise<void> {
  const W = s.width ?? 960;
  const H = s.height ?? 540;
  const dt = s.dt ?? 1 / 30;
  const warmup = s.warmup ?? 0;
  const engine = new ChallengeEngine({ device, width: W, height: H, planes: stackLayout(s.planes ?? 24, 1), seed: 1 });
  engine.mode = s.mode;
  if (s.exposure !== undefined) engine.exposure = s.exposure;
  const count = await engine.setCount(s.count);
  // The page's start pose; the idle orbit is replaced by a fixed 0.09 rad/s yaw so frames are repeatable.
  const fovY = (45 * Math.PI) / 180;
  const cam = createCamera(
    { target: [0, 0, 0], yaw: 0.6, pitch: -0.52, distance: 3.7, fovY },
    { near: 0.02, far: 200, minDistance: 0.3, maxDistance: 40, idle: { enabled: false, delay: 0, rampIn: 2, orbitRate: 0, swayPitch: 0, breathe: 0 } },
  );
  const target = device.createTexture({ size: [W, H], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  try {
    for (let k = -warmup; k < (s.frames ?? 1); k++) {
      const frame = k + warmup;
      const t = frame * dt;
      cam.state = { target: [0, 0, 0], yaw: 0.6 + 0.09 * t, pitch: -0.52, distance: 3.7, fovY };
      const enc = device.createCommandEncoder();
      engine.encode(enc, { viewProj: cam.viewProjection(W / H), time: t, dt, frame });
      engine.resolveToCanvas(enc, target.createView(), FORMAT);
      device.queue.submit([enc.finish()]);
      if (k < 0) {
        await device.queue.onSubmittedWorkDone();
        continue;
      }
      const rgba = await readTexture(target, 4);
      const acc = await engine.readAccumulation();
      const meta = {
        scenario: s.tag, k, t, mode: s.mode, count, width: W, height: H, units: engine.units,
        exposure: engine.exposure, curve: engine.curve, planes: engine.planeCount,
      };
      await save(`${s.tag}-f${k}.rgba`, rgba, meta);
      await save(`${s.tag}-f${k}.acc`, new Uint8Array(acc.buffer), meta);
      log(`saved ${s.tag}-f${k}`);
    }
  } finally {
    target.destroy();
    engine.dispose();
  }
}

// ---- offline 1T renderer (src/offline) ------------------------------------------

const short = (n: number): string => (n >= 1e9 ? `${Math.round(n / 1e9)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1e3)}k`);

/**
 * Render and grade a job with src/offline's own session code, as its web page
 * does, keeping both the developed 16-bit log frames and the graded 8-bit
 * frames. With `mp4`, the graded frames are encoded exactly like the page's
 * export button does it (src/capture recorder, its defaults).
 */
async function offlineRun(
  job: ReturnType<typeof clusterJob>,
  tag: string,
  look: Partial<GradeLook>,
  end: number | undefined,
  mp4: boolean,
): Promise<Record<string, unknown>> {
  const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!a) throw new Error('qa: no adapter for the offline renderer');
  const dev = await a.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, a) });
  const store = memoryStore();
  const W = job.width;
  const H = job.height;
  const base = { scenario: tag, job: { ...job, planes: job.planes.length, camera: job.camera }, look };
  try {
    await renderJob(dev, job, store, browserZlib, { targetBatchMs: 120, checkpointSeconds: 0, end });
    const stats = await loadStats(store, job);
    for (const s of stats) {
      const file = await store.read(`frame-${String(s.frame).padStart(6, '0')}.png`);
      if (!file) continue;
      const { samples } = await decodeGrayPng16(file, browserZlib);
      await save(`${tag}-f${s.frame}.codes`, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), { ...base, width: W, height: H, stats: s });
    }
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d')!;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const image = new ImageData(rgba, W, H);
    const rec = mp4 ? await startRecording(canvas, { fps: job.fps, width: W, height: H, timing: 'fixed' }) : null;
    await gradeJob(store, browserZlib, async (f, gray) => {
      await save(`${tag}-f${f}.gray`, gray, { ...base, width: W, height: H, frame: f, stats: stats[f] });
      log(`saved ${tag}-f${f}`);
      if (rec) {
        for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = gray[i];
          rgba[o + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        await rec.addFrame(canvas);
      }
    }, { look });
    if (rec) {
      const r = await rec.stop();
      const bytes = new Uint8Array(await r.blob!.arrayBuffer());
      const meta = { scenario: tag, codec: r.codec, bitrate: r.bitrate, frames: r.frames, fps: r.fps, width: r.width, height: r.height };
      await save(`${tag}.mp4`, bytes, meta);
      return meta;
    }
    return { frames: stats.length };
  } finally {
    dev.destroy();
  }
}

/**
 * The trillion demo page's scene (src/trillion/demo/demo.ts, scene()), copied
 * because the demo does not export it: a deterministic field of tilted sheets.
 */
function trillionScene(width: number, height: number, n: number, planes: number, laws: string[]): TrillionPlane[] {
  const vp = mulMat4(perspective(0.9, width / height, 0.05, 200), lookAt([0, 2.5, 9], [0, 0, 0], [0, 1, 0]));
  const out: TrillionPlane[] = [];
  let left = n;
  for (let i = 0; i < planes; i++) {
    const count = Math.min(2 ** 32, Math.round(left / (planes - i)));
    left -= count;
    const a = i * 2.39996;
    const r = 1.5 + 4 * Math.sqrt((i + 0.5) / planes);
    const s = 0.6 + (0.5 * ((i * 7) % 5)) / 5;
    const tilt = 0.4 + 0.3 * Math.sin(i);
    const c = Math.cos(tilt);
    const sn = Math.sin(tilt);
    const model = new Float32Array([s, 0, 0, 0, 0, s * c, -s * sn, 0, 0, sn, c, 0, r * Math.cos(a), 0.6 * Math.sin(i * 1.3), r * Math.sin(a) - 2, 1]);
    out.push({ law: laws[i % laws.length], count, seed: (i * 2654435761) >>> 0, params: [0.6, 0.15], homography: planeHomography(vp, model, width, height) });
  }
  return out;
}

const scenarios = {
  /**
   * The trillion shot from src/offline, scaled down: same world (1024 sheets),
   * same 600-frame camera move, fewer particles, a small frame. Only the frames
   * in `moments` are rendered, each graded like gradeJob does (own white point,
   * no smoothing across moments that are seconds apart, default label).
   * Rendering a short job instead would compress the whole camera move into a
   * few frames, and since PR #92 the camera blur would follow it. `frames`
   * renders such a short job on purpose (tag offline-short-*, every frame), to
   * show that effect.
   */
  async offline(o: { particles?: number[]; width?: number; height?: number; planes?: number; moments?: number[]; splat?: 'point' | 'bilinear'; frames?: number } = {}) {
    const out: Record<string, unknown> = {};
    for (const particles of o.particles ?? [4e6, 4e7, 4e8]) {
      // The preset picks the splat by count (point above 2e10, as the 1T record does); `splat` forces one.
      const job = clusterJob({
        ...PRESETS.trillion, name: `qa-${short(particles)}`, width: o.width ?? 640, height: o.height ?? 360,
        particles, planes: o.planes ?? 1024, ...(o.splat ? { splat: o.splat } : {}), ...(o.frames ? { frames: o.frames } : {}),
      });
      const tag = `offline-${o.frames ? 'short-' : ''}${short(particles)}${o.splat ? `-${o.splat}` : ''}`;
      const moments = o.moments ?? (o.frames ? [...Array(job.frames).keys()] : [0, 150, 300, 449, job.frames - 1]);
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!a) throw new Error('qa: no adapter for the offline renderer');
      const dev = await a.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, a) });
      const store = memoryStore();
      const look: GradeLook = { ...GRADE_LOOK, smoothFrames: 0 };
      const base = { scenario: tag, job: { ...job, planes: job.planes.length, camera: job.camera }, look };
      try {
        for (let m = 0; m < moments.length; m++) {
          const f = moments[m];
          await renderJob(dev, job, store, browserZlib, { targetBatchMs: 120, checkpointSeconds: 0, first: f, end: f + 1 });
          const stats = JSON.parse(new TextDecoder().decode((await store.read(frameStatsName(f)))!)) as FrameStats;
          const { samples } = await decodeGrayPng16((await store.read(frameImageName(f)))!, browserZlib);
          const [white] = exposureTrack([stats], look);
          const gray = gradeFrame(samples, toneTable(white, look), f);
          drawLabel(gray, job.width, job.height, defaultLabel(stats, job));
          const meta = { ...base, width: job.width, height: job.height, frame: f, moment: m, white, stats };
          await save(`${tag}-f${m}.codes`, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), meta);
          await save(`${tag}-f${m}.gray`, gray, meta);
          log(`saved ${tag}-f${m} (frame ${f})`);
        }
        out[tag] = { frames: moments };
      } finally {
        dev.destroy();
      }
    }
    return out;
  },

  /**
   * One moment of the trillion shot through both kernels the offline renderer
   * offers: its own (the default) and src/trillion's (PR #80, the web UI's
   * "kernel" menu). Shutter 0 by default, so the two differ only in how they
   * weight light (both blur camera moves since PR #174, but a blur would hide
   * the grain this compares). Flux weights are what clusterJob gives the job
   * (fluxBits since PR #166). Both frames are graded with one tone table (the
   * offline kernel's own white point) and saved without the label.
   */
  async offlineKernels(o: { particles?: number; frame?: number; width?: number; height?: number; shutter?: number } = {}) {
    const particles = o.particles ?? 4e7;
    const job = {
      ...clusterJob({ ...PRESETS.trillion, name: `qa-kernels-${short(particles)}`, width: o.width ?? 640, height: o.height ?? 360, particles, planes: 1024 }),
      shutter: o.shutter ?? 0,
    };
    const f = o.frame ?? 300;
    const look: GradeLook = { ...GRADE_LOOK, smoothFrames: 0 };
    let lut: ReturnType<typeof toneTable> | null = null;
    let white = 0;
    const out: Record<string, unknown> = { frame: f, shutter: job.shutter, splat: job.splat, weighting: job.weighting };
    for (const kernel of ['offline', 'trillion'] as const) {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!a) throw new Error('qa: no adapter for the offline renderer');
      const dev = await a.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, a) });
      const store = memoryStore();
      try {
        await renderJob(dev, job, store, browserZlib, { targetBatchMs: 120, checkpointSeconds: 0, first: f, end: f + 1, kernel });
        const stats = JSON.parse(new TextDecoder().decode((await store.read(frameStatsName(f)))!)) as FrameStats;
        const { samples } = await decodeGrayPng16((await store.read(frameImageName(f)))!, browserZlib);
        const [own] = exposureTrack([stats], look);
        if (!lut) {
          white = own;
          lut = toneTable(white, look);
        }
        const tag = `kernels-${kernel}-${short(particles)}`;
        const meta = { scenario: 'offlineKernels', kernel, width: job.width, height: job.height, frame: f, shutter: job.shutter, weighting: job.weighting, fluxBits: job.fluxBits ?? null, white, ownWhite: own, stats };
        await save(`${tag}.codes`, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), meta);
        await save(`${tag}.gray`, gradeFrame(samples, lut, f), meta);
        out[kernel] = { landed: stats.landed, drawn: stats.drawn ?? null, evaluated: stats.evaluated, evaluatedBy: stats.evaluatedBy ?? 'gpu', unitSum: stats.unitSum, unitsPerParticle: stats.unitsPerParticle ?? 65536, ownWhite: own };
        log(`saved ${tag}`);
      } finally {
        dev.destroy();
      }
    }
    return out;
  },

  /**
   * No rendering: for the full trillion job (1e12 particles, 4K) and the
   * scaled-down jobs above, the share of particles the trillion kernel keeps
   * under flux weighting at each moment, computed the way StatelessRenderer
   * gives it each sheet (keep = min(1, (fluxRef / depth of the sheet center)^2)),
   * weighted by particle count over all sheets, visible or not.
   */
  async fluxKeep(o: { particles?: number[]; moments?: number[] } = {}) {
    const rows: Record<string, unknown>[] = [];
    const paths: { particles: number; frame: number; distance: number }[] = [];
    for (const particles of o.particles ?? [4e6, 4e7, 4e8, 1e12]) {
      const full = particles >= 1e12;
      const job = clusterJob({ ...PRESETS.trillion, name: `qa-keep-${short(particles)}`, particles, planes: 1024, ...(full ? {} : { width: 640, height: 360 }) });
      const path = new CameraPath(job.camera);
      for (const f of o.moments ?? [0, 150, 300, 449, job.frames - 1]) {
        const cam = cameraBasis(path.atFrame(f, job.frames));
        let kept = 0;
        let total = 0;
        for (const plane of job.planes) {
          const depth = offlineHomography(cam, plane, job.width * job.ssaa, job.height * job.ssaa)[8];
          const keep = job.weighting === 'flux' ? (depth > 0 ? Math.min(1, (job.fluxRef / depth) ** 2) : 1) : 1;
          kept += plane.particleCount * keep;
          total += plane.particleCount;
        }
        rows.push({ particles, width: job.width, height: job.height, frame: f, fluxRef: job.fluxRef, kept, total, share: kept / total });
      }
      // The camera's distance to its target per frame: the path itself depends on the count.
      for (let f = 0; f < job.frames; f++) paths.push({ particles, frame: f, distance: path.atFrame(f, job.frames).distance });
    }
    return { rows, paths };
  },

  /** The first frames of the trillion shot at its real 60 fps timing, default look, plus the web export's MP4. */
  async offlineSeq(o: { particles?: number; frames?: number; width?: number; height?: number } = {}) {
    const job = clusterJob({ ...PRESETS.trillion, name: 'qa-seq', width: o.width ?? 640, height: o.height ?? 360, particles: o.particles ?? 4e7 });
    return offlineRun(job, 'offline-seq', {}, o.frames ?? 8, true);
  },

  /**
   * Consecutive frames from the middle of the trillion shot, where it is
   * bright (its first frames are the dimmest stretch). Graded at one fixed
   * white, so any change between frames comes from the renderer and not from
   * exposure. Returns each frame's own unsmoothed white point as well.
   */
  async offlineMid(o: { particles?: number; first?: number; frames?: number; width?: number; height?: number } = {}) {
    const job = clusterJob({ ...PRESETS.trillion, name: 'qa-mid', width: o.width ?? 640, height: o.height ?? 360, particles: o.particles ?? 4e7 });
    const first = o.first ?? 300;
    const end = Math.min(job.frames, first + (o.frames ?? 8));
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) throw new Error('qa: no adapter for the offline renderer');
    const dev = await a.requestDevice({ requiredLimits: StatelessRenderer.requiredLimits(job, a) });
    const store = memoryStore();
    const tag = 'offline-mid';
    const base = { scenario: tag, job: { ...job, planes: job.planes.length, camera: job.camera } };
    try {
      await renderJob(dev, job, store, browserZlib, { targetBatchMs: 120, checkpointSeconds: 0, first, end });
      const stats: FrameStats[] = [];
      for (let f = first; f < end; f++) stats.push(JSON.parse(new TextDecoder().decode((await store.read(frameStatsName(f)))!)) as FrameStats);
      const whites = exposureTrack(stats, { ...GRADE_LOOK, smoothFrames: 0 });
      const white = [...whites].sort((x, y) => x - y)[whites.length >> 1];
      const lut = toneTable(white, GRADE_LOOK);
      for (let i = 0; i < stats.length; i++) {
        const f = first + i;
        const { samples } = await decodeGrayPng16((await store.read(frameImageName(f)))!, browserZlib);
        const meta = { ...base, width: job.width, height: job.height, frame: f, stats: stats[i], white, ownWhite: whites[i] };
        await save(`${tag}-f${f}.codes`, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), meta);
        await save(`${tag}-f${f}.gray`, gradeFrame(samples, lut, f), meta);
        log(`saved ${tag}-f${f}`);
      }
      return { first, end, white, whites };
    } finally {
      dev.destroy();
    }
  },

  /**
   * src/trillion's kernel on its demo page's scene and stand-in laws (the
   * demo's default), counted exactly and tone mapped by CountToneMapper as the
   * demo does. Point splat, stochastic bilinear splat, and the stochastic
   * splat again with another salt at the same instant, which isolates its
   * noise. Ends with the demo's self test: counter sum equals the landed
   * tally, and two batch plans give bit-identical counters.
   */
  async trillion(o: { n?: number; planes?: number; width?: number; height?: number; time?: number } = {}) {
    const W = o.width ?? 960;
    const H = o.height ?? 540;
    const n = o.n ?? 1e8;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) throw new Error('qa: no adapter for the trillion kernel');
    const dev = await a.requestDevice({ requiredLimits: trillionLimits(a) });
    const laws = STANDIN_LAWS;
    const kernel = await TrillionKernel.create(dev, { width: W, height: H, laws });
    const mapper = new CountToneMapper(dev, { format: FORMAT, words: 2 });
    mapper.resize(W, H);
    const target = dev.createTexture({ size: [W, H], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    // 32 sheets, not the demo's default of ceil(n / 2^32) (one sheet at 1e8), so every stand-in law and many poses are in frame.
    const planes = trillionScene(W, H, n, o.planes ?? 32, laws.map((l) => l.id));
    const out: Record<string, unknown> = { n, planes: planes.length, width: W, height: H, tileBins: kernel.tileBins };
    try {
      const variants = [
        { tag: 'trillion-point', stochastic: false, salt: 0 },
        { tag: 'trillion-stochastic', stochastic: true, salt: 0 },
        { tag: 'trillion-stochastic-salt1', stochastic: true, salt: 1 },
      ];
      for (const v of variants) {
        Object.assign(kernel.settings, { time: o.time ?? 2, shutter: 0, salt: v.salt, stochastic: v.stochastic, cull: false });
        const tally = await renderTrillionFrame(kernel, planes);
        const counts = await kernel.readCounts();
        let sum = 0;
        for (let i = 0; i < counts.length; i++) sum += counts[i];
        await mapper.measureAndExpose(kernel.counts);
        const enc = dev.createCommandEncoder();
        mapper.encode(enc, kernel.counts, target.createView());
        dev.queue.submit([enc.finish()]);
        const rgba = await readTexture(target, 4, dev);
        const tone = mapper.post.settings.tone;
        const meta = { scenario: v.tag, width: W, height: H, n, planes: planes.length, settings: { ...kernel.settings }, tally, sum, exposure: tone.exposure, white: tone.white };
        await save(`${v.tag}.rgba`, rgba, meta);
        await save(`${v.tag}.counts`, new Uint8Array(Float32Array.from(counts).buffer), meta);
        out[v.tag] = { tally, sum, exact: sum === tally.landed };
        log(`saved ${v.tag}`);
      }
      // The demo's self test, on a small scene.
      const small = trillionScene(W, H, 2e7, 6, laws.map((l) => l.id));
      Object.assign(kernel.settings, { time: 0, shutter: 0, salt: 0, stochastic: true, cull: false });
      const ta = await renderTrillionFrame(kernel, small, { startBudget: 1 << 20, targetMs: 1e9, rounds: 1 });
      const ca = await kernel.readCounts();
      const tb = await renderTrillionFrame(kernel, small, { startBudget: 3_000_017, targetMs: 1e9, rounds: 7 });
      const cb = await kernel.readCounts();
      let sum = 0;
      let identical = ta.landed === tb.landed;
      for (let i = 0; i < ca.length; i++) {
        sum += ca[i];
        if (ca[i] !== cb[i]) identical = false;
      }
      out.selftest = { ok: sum === ta.landed && identical && ta.evaluated + ta.culled === 2e7, landed: ta.landed, sum, identical };
      return out;
    } finally {
      target.destroy();
      mapper.destroy();
      dev.destroy();
    }
  },

  /** Challenge mode's simulated and procedural modes at increasing counts, then consecutive frames. */
  async challenge(o: { counts?: number[]; procCounts?: number[] } = {}) {
    for (const count of o.counts ?? [1 << 20, 1 << 22, 1 << 24]) {
      await challengeShot({ tag: `challenge-sim-${short(count)}`, mode: 'sim', count, warmup: 30 });
    }
    for (const count of o.procCounts ?? [1 << 20, 1 << 22, 1 << 24, 1 << 26]) {
      await challengeShot({ tag: `challenge-proc-${short(count)}`, mode: 'proc', count, warmup: 0 });
    }
    await challengeShot({ tag: 'challenge-sim-seq', mode: 'sim', count: 1 << 22, warmup: 30, frames: 4 });
    await challengeShot({ tag: 'challenge-proc-seq', mode: 'proc', count: 1 << 22, frames: 4 });
  },

  /** Challenge mode's procedural view at other resolve exposures, to check a suggested default. */
  async challengeExposure(o: { count?: number; exposures?: number[] } = {}) {
    const count = o.count ?? 1 << 22;
    for (const exposure of o.exposures ?? [0.008]) {
      await challengeShot({ tag: `challenge-proc-${short(count)}-e${exposure}`, mode: 'proc', count, exposure });
    }
  },

  /** Same view at increasing particle counts, default look, as seen live (trails warmed up). */
  async ladder(o: { counts?: number[]; width?: number; height?: number } = {}) {
    const counts = o.counts ?? [500_000, 2_000_000, 8_000_000, 32_000_000];
    for (const count of counts) {
      await saveShot({ tag: `ladder-${count}`, count, width: o.width ?? 960, height: o.height ?? 540, warmup: 4, density: true });
    }
  },

  /**
   * Compute splat overflow. The same frame at energy 1 and at energies that
   * push the brightest pixels past 2^32 fixed point units. The auto white
   * point scales with energy, so without overflow all frames would match.
   */
  async overflow(o: { count?: number; width?: number; height?: number } = {}) {
    const base = { count: o.count ?? 4_000_000, width: o.width ?? 640, height: o.height ?? 360, look: { trail: 0 }, density: true };
    let peak = 0;
    await render(shot({ ...base, tag: 'probe' }), async (f) => {
      peak = densityStats(f.density!).max;
    });
    const limit = 2 ** 32 / DEFAULT_LOOK.fixedScale; // energy units per pixel before u32 wraps
    const eAt = limit / peak;
    const energies = [1, 0.5 * eAt, 4 * eAt, 64 * eAt];
    for (const energy of energies) {
      const tag = `overflow-e${Math.round(energy)}`;
      const wrapped = energy * peak >= limit;
      await render(shot({ ...base, tag, look: { trail: 0, energy } }), async (f) => {
        await save(`${tag}-f${f.k}.rgba`, f.rgba, f.meta);
        await save(`${tag}-f${f.k}.density`, f.density!, f.meta);
        if (!wrapped) {
          const c = await countsLook(f.density!, f.width, f.height, DEFAULT_LOOK.fixedScale, f.meta.look as Look);
          await save(`${tag}-counts-f${f.k}.rgba`, c.rgba, { ...f.meta, toneMapper: 'CountToneMapper', exposure: c.exposure, white: c.white });
        }
        log(`saved ${tag}-f${f.k}`);
      });
    }
    return { peak, limit, energyAtOverflow: eAt, energies };
  },

  /** Synthetic density ramps through DensityPost: the tone curve on its own. */
  async ramp(o: { width?: number; band?: number; white?: number } = {}) {
    const W = o.width ?? 1024;
    const band = o.band ?? 48;
    const white = o.white ?? 64;
    const bands = [
      { name: 'log', from: white * 1e-3, to: white * 1e3, scale: 'log' },
      { name: 'dark', from: 0, to: white * 0.02, scale: 'linear' },
      { name: 'shoulder', from: white * 0.25, to: white * 4, scale: 'linear' },
    ] as const;
    const H = band * bands.length;
    const data = new Float32Array(W * H);
    for (let b = 0; b < bands.length; b++) {
      const { from, to, scale } = bands[b];
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const d = scale === 'log' ? from * (to / from) ** u : from + (to - from) * u;
        for (let y = b * band; y < (b + 1) * band; y++) data[y * W + x] = d;
      }
    }
    const tex = device.createTexture({ size: [W, H], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: W * 4 }, [W, H]);
    const variants = [
      { tag: 'ramp-default', tone: {}, bloom: 0 },
      { tag: 'ramp-nodither', tone: { dither: 0 }, bloom: 0 },
      { tag: 'ramp-filmic', tone: { display: 'filmic' as Display }, bloom: 0 },
    ];
    for (const v of variants) {
      const post = new DensityPost(device, { format: FORMAT });
      post.resize(W, H);
      post.settings.trails.enabled = false;
      post.settings.bloom.enabled = false;
      Object.assign(post.settings.tone, { white }, v.tone);
      const target = device.createTexture({ size: [W, H], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const enc = device.createCommandEncoder();
      post.encode(enc, tex.createView(), target.createView(), 1 / 60);
      device.queue.submit([enc.finish()]);
      const rgba = await readTexture(target, 4);
      await save(`${v.tag}.rgba`, rgba, { scenario: v.tag, width: W, height: H, band, white, bands, tone: post.settings.tone });
      target.destroy();
      post.destroy();
      log(`saved ${v.tag}`);
    }
    tex.destroy();
  },

  /** One still at 1x and supersampled through src/capture's Resampler. */
  async supersample(o: { count?: number } = {}) {
    const base = { count: o.count ?? 2_000_000, look: { trail: 0 }, density: false };
    await saveShot({ ...base, tag: 'ss1' });
    await saveShot({ ...base, tag: 'ss2', supersample: 2 });
    await saveShot({ ...base, tag: 'ss3', supersample: 3 });
    await saveShot({ ...base, tag: 'ss2-fixedwhite', supersample: 2, whitePixels: 'output' });
  },

  /**
   * Supersampled stills the way the app makes them since PR #96: particle light
   * scaled by supersample^2 (the app's capture gain) at the 1x white point,
   * then downscaled by src/capture's Resampler (linear light since PR #99).
   */
  async supersampleGain(o: { count?: number } = {}) {
    const count = o.count ?? 2_000_000;
    const white = Math.max(12, ((count * DEFAULT_LOOK.energy) / (DEFAULT_SHOT.width * DEFAULT_SHOT.height)) * DEFAULT_LOOK.whiteFactor);
    for (const ss of [2, 3]) {
      await saveShot({ count, tag: `ss${ss}-gain`, supersample: ss, look: { trail: 0, energy: ss * ss, white }, density: false });
    }
  },

  /** Consecutive frames: moving camera and sim, a frozen scene, and point splats for comparison. */
  async flicker(o: { count?: number } = {}) {
    const count = o.count ?? 2_000_000;
    await saveShot({ tag: 'flicker-motion', count, frames: 6, warmup: 8 });
    await saveShot({ tag: 'flicker-static', count, frames: 4, warmup: 8, speed: 0, spin: 0 });
    await saveShot({ tag: 'flicker-point', count, frames: 6, warmup: 8, look: { mode: 'point' } });
  },

  /**
   * MP4 through src/capture's recorder with its defaults, fed real density
   * pipeline frames. Source frames are saved too, for a per-frame comparison
   * against the decoded video.
   */
  async mp4(o: { count?: number; frames?: number; width?: number; height?: number; bitsPerPixel?: number; codec?: CaptureCodec; tag?: string } = {}) {
    const fps = 60;
    const s = shot({ tag: o.tag ?? 'mp4', count: o.count ?? 2_000_000, width: o.width ?? 960, height: o.height ?? 540, frames: o.frames ?? 90, warmup: 8 });
    const rec = await startRecording(new OffscreenCanvas(s.width, s.height), {
      fps, width: s.width, height: s.height, codec: o.codec, bitsPerPixel: o.bitsPerPixel,
    });
    await render(s, async (f) => {
      await save(`${s.tag}-src-f${f.k}.rgba`, f.rgba, f.meta);
      const vf = new VideoFrame(f.rgba, { format: 'RGBA', codedWidth: f.width, codedHeight: f.height, timestamp: Math.round((f.k * 1e6) / fps) });
      await rec.addFrame(vf);
    });
    const res = await rec.stop();
    const bytes = new Uint8Array(await res.blob!.arrayBuffer());
    const meta = { scenario: s.tag, codec: res.codec, mimeType: res.mimeType, bitrate: res.bitrate, frames: res.frames, fps, width: res.width, height: res.height, bitsPerPixel: o.bitsPerPixel ?? 0.15 };
    await save(`${s.tag}.mp4`, bytes, meta);
    log(`saved ${s.tag}.mp4 (${bytes.length} bytes, ${res.codec})`);
    return meta;
  },
};

const api = {
  info: () => ({
    adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description },
    features: [...device.features],
    maxBufferSize: device.limits.maxBufferSize,
    maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
    maxCount: MAX_COUNT,
  }),
  run: async (name: keyof typeof scenarios, opts?: Record<string, unknown>) => {
    log(`run ${name}`);
    return (await scenarios[name](opts as never)) ?? null;
  },
  saveShot,
  scenarios: Object.keys(scenarios),
};
Object.assign(window, { qa: api });
log('ready');
