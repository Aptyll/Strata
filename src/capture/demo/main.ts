/**
 * Standalone test bed for src/capture. It draws a small deterministic point
 * cloud with WebGPU (or Canvas 2D when WebGPU is missing) and wires every
 * capture feature to a button. It doubles as the integration example for the
 * real engine, and src/capture/demo/verify.mjs drives it headlessly.
 */
import {
  type CameraPose,
  type FrameImage,
  TextureReader,
  type OfflineFrame,
  type Tile,
  capturePNG,
  captureStillPNG,
  captureTiledPNG,
  createCaptureController,
  downloadBlob,
  keyframePath,
  orbitPath,
  pickOutputFile,
  renderOffline,
  sequencePath,
  timestampName,
  viewMatrix,
} from '../index';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;
const setStatus = (s: string) => (statusEl.textContent = s);

// ---------------------------------------------------------------- scene

// ?count=N sets the number of particles (the headless check uses fewer, since it
// runs on a software GPU).
const COUNT = Math.max(1, Number(new URLSearchParams(location.search).get('count')) || 200_000);
const PLANES = 24;

interface Scene {
  kind: 'webgpu' | '2d';
  /** Advance the simulation. */
  step(dt: number): void;
  /** Draw with the given camera; `tile` is set for tiled poster renders. */
  render(pose: CameraPose, tile?: Tile): void;
  flush(): Promise<unknown>;
  /** Set in ?readback mode: returns the frame just rendered via GPU readback. */
  capture?: () => Promise<FrameImage>;
  time: number;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

function perspective(fovDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ]);
}

function viewProj(pose: CameraPose, aspect: number, tile?: Tile): Float32Array {
  let m = mul(perspective(pose.fov, aspect, 0.05, 100), viewMatrix(pose));
  if (tile) m = mul(tile.matrix, m);
  return m;
}

const SHADER = /* wgsl */ `
struct U { viewProj: mat4x4f, viewport: vec2f, time: f32, pointSize: f32 };
@group(0) @binding(0) var<uniform> u: U;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32 };

fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  // Each particle lives on one of several parallel planes and swirls on it.
  let plane = f32(ii % ${PLANES}u);
  let r = sqrt(hash(ii * 3u)) * 1.6;
  let a0 = hash(ii * 3u + 1u) * 6.2831853;
  let speed = (0.25 + hash(ii * 3u + 2u) * 0.5) / (0.3 + r);
  let a = a0 + u.time * speed * select(-1.0, 1.0, (ii % 2u) == 0u);
  let wob = sin(u.time * 0.7 + r * 4.0 + plane) * 0.04;
  let p = vec3f(cos(a) * (r + wob), sin(a) * (r + wob), (plane - ${(PLANES - 1) / 2}) * 0.12);
  var out: V;
  out.pos = u.viewProj * vec4f(p, 1.0);
  out.pos = vec4f(out.pos.xy + corner * u.pointSize / u.viewport * out.pos.w, out.pos.zw);
  out.uv = corner;
  out.a = 0.35 + 0.65 * hash(ii * 7u + 5u);
  return out;
}

@fragment fn fs(v: V) -> @location(0) vec4f {
  let d = dot(v.uv, v.uv);
  if (d > 1.0) { discard; }
  let c = v.a * (1.0 - d);
  return vec4f(c, c, c, 1.0);
}`;

async function createGpuScene(): Promise<Scene | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  // ?readback exercises the TextureReader path: the scene is drawn into an
  // offscreen texture and never touches the canvas, so the page stays black.
  // It also lets verify.mjs test the WebGPU pipeline on machines where a
  // headless browser cannot present a WebGPU canvas.
  const readback = new URLSearchParams(location.search).has('readback');
  const format: GPUTextureFormat = readback ? 'rgba8unorm' : navigator.gpu.getPreferredCanvasFormat();
  const context = readback ? null : canvas.getContext('webgpu');
  if (!readback && !context) return null;
  context?.configure({ device, format, alphaMode: 'opaque' });
  const reader = new TextureReader(device);
  let offscreen: GPUTexture | null = null;
  const target = (): GPUTexture => {
    if (context) return context.getCurrentTexture();
    if (!offscreen || offscreen.width !== canvas.width || offscreen.height !== canvas.height) {
      offscreen?.destroy();
      offscreen = device.createTexture({
        size: [canvas.width, canvas.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
    return offscreen;
  };
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }],
    },
    primitive: { topology: 'triangle-strip' },
  });
  const ubo = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });
  const data = new Float32Array(20);
  const scene: Scene = {
    kind: 'webgpu',
    time: 0,
    step(dt) {
      scene.time += dt;
    },
    render(pose, tile) {
      const fullW = tile ? tile.fullWidth : canvas.width;
      const fullH = tile ? tile.fullHeight : canvas.height;
      data.set(viewProj(pose, fullW / fullH, tile), 0);
      // Viewport of this pass, and a point size relative to the full image
      // height so stills, tiles and video all look the same.
      data[16] = canvas.width;
      data[17] = canvas.height;
      data[18] = scene.time;
      data[19] = Math.max(1, fullH / 720);
      device.queue.writeBuffer(ubo, 0, data);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(4, COUNT);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    flush: () => device.queue.onSubmittedWorkDone(),
  };
  if (readback) scene.capture = () => reader.read(target());
  return scene;
}

function create2dScene(): Scene {
  const ctx = canvas.getContext('2d')!;
  const n = 6000;
  const seed = new Float32Array(n * 3);
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < seed.length; i++) seed[i] = rnd();
  const scene: Scene = {
    kind: '2d',
    time: 0,
    step(dt) {
      scene.time += dt;
    },
    render(pose, tile) {
      const w = canvas.width;
      const h = canvas.height;
      const fullW = tile ? tile.fullWidth : w;
      const fullH = tile ? tile.fullHeight : h;
      const m = viewProj(pose, fullW / fullH, tile);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      const size = Math.max(1, fullH / 540);
      for (let i = 0; i < n; i++) {
        const r = Math.sqrt(seed[i * 3]) * 1.6;
        const a = seed[i * 3 + 1] * 6.2831853 + (scene.time * (0.25 + seed[i * 3 + 2] * 0.5)) / (0.3 + r);
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        const z = ((i % PLANES) - (PLANES - 1) / 2) * 0.12;
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw <= 0) continue;
        const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
        const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
        ctx.fillRect((cx * 0.5 + 0.5) * w, (0.5 - cy * 0.5) * h, size, size);
      }
    },
    flush: () => Promise.resolve(),
  };
  return scene;
}

// ---------------------------------------------------------------- app

const forced2d = new URLSearchParams(location.search).has('2d');
const scene: Scene = (!forced2d && (await createGpuScene())) || create2dScene();

/** A cinematic move: slow orbit, then a push through the planes. */
function cinematicPath(duration: number) {
  const a = duration * 0.6;
  const b = duration - a;
  return sequencePath([
    orbitPath({ duration: a, radius: [4.2, 3.2], height: [1.6, 0.4], turns: 0.5, fov: 45, ease: 'smooth' }),
    keyframePath(
      [
        { t: 0, position: [0, 0.4, -3.2], target: [0, 0, 0], fov: 45 },
        { t: b * 0.5, position: [0.6, 0.1, -1.2], fov: 60 },
        { t: b, position: [0, 0, 2.4], target: [0, 0, 4], fov: 70, roll: 20 },
      ],
      { ease: 'smooth' },
    ),
  ]);
}

const livePath = orbitPath({ duration: 40, radius: 3.6, height: 0.9, turns: 1, fov: 50 });
const livePose = () => livePath.sample(scene.time % livePath.duration);

const controller = createCaptureController(canvas, { onStatus: setStatus, capture: scene.capture });
const shotWaiters: ((png: Promise<Blob>) => void)[] = [];

let busy = false;
let last = performance.now();
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (busy) return; // an offline render or still owns the canvas
  resize();
  scene.step(dt);
  scene.render(livePose());
  controller.afterRender();
  if (shotWaiters.length) {
    const png = scene.capture ? scene.capture().then((image) => capturePNG(image)) : capturePNG(canvas);
    for (const w of shotWaiters.splice(0)) w(png);
  }
}
requestAnimationFrame(frame);

const $ = (id: string) => document.getElementById(id)!;

$('shot').onclick = () => controller.requestScreenshot();
$('rec').onclick = async () => {
  await controller.toggleRecording();
  $('rec').textContent = controller.recording ? 'Stop recording (R)' : 'Record live (R)';
};

async function exclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (busy) return undefined;
  busy = true;
  try {
    return await fn();
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      setStatus(`Failed: ${(err as Error).message ?? err}`);
      throw err;
    }
    setStatus('Cancelled');
    return undefined;
  } finally {
    busy = false;
  }
}

$('still').onclick = () =>
  exclusive(async () => {
    const pose = livePose();
    await captureStillPNG({ canvas, width: 3840, height: 2160, supersample: 2, render: () => scene.render(pose), capture: scene.capture, download: true });
    setStatus('Saved 4K still');
  });

$('poster').onclick = () =>
  exclusive(async () => {
    const pose = livePose();
    await captureTiledPNG({
      canvas,
      width: 15360,
      height: 8640,
      render: (tile) => scene.render(pose, tile),
      capture: scene.capture,
      onProgress: (d, t) => setStatus(`Poster tile ${d}/${t}`),
      download: true,
    });
    setStatus('Saved 16K poster');
  });

interface OfflineRequest {
  width: number;
  height: number;
  seconds: number;
  fps?: number;
  supersample?: number;
  toDisk?: boolean;
  codec?: 'avc' | 'hevc' | 'vp9' | 'av1';
  signal?: AbortSignal;
}

async function runOffline(req: OfflineRequest) {
  const output = req.toDisk ? await pickOutputFile() : 'memory';
  const savedTime = scene.time;
  scene.time = 0;
  try {
    return await renderOffline({
      canvas,
      fps: req.fps ?? 60,
      duration: req.seconds,
      width: req.width,
      height: req.height,
      supersample: req.supersample ?? 1,
      step: (dt: number) => scene.step(dt),
      render: (_ctx: OfflineFrame) => scene.render(pose),
      camera: cinematicPath(req.seconds),
      applyCamera: (p) => (pose = p),
      flush: scene.flush,
      capture: scene.capture,
      recording: { output, codec: req.codec },
      signal: req.signal,
      onProgress: (p) =>
        setStatus(
          `Rendering ${p.frame + 1}/${p.totalFrames} (${(p.progress * 100).toFixed(0)}%), ` +
            `${p.renderFps.toFixed(1)} fps, ${Math.ceil(p.remaining)} s left`,
        ),
    });
  } finally {
    scene.time = savedTime;
  }
}
let pose: CameraPose = livePose();

let abort: AbortController | null = null;
$('offline').onclick = () =>
  exclusive(async () => {
    const [width, height] = ($('res') as HTMLSelectElement).value.split('x').map(Number);
    abort = new AbortController();
    $('cancel').hidden = false;
    try {
      const result = await runOffline({
        width,
        height,
        seconds: Number(($('secs') as HTMLInputElement).value),
        supersample: Number(($('ss') as HTMLSelectElement).value),
        toDisk: ($('disk') as HTMLInputElement).checked,
        signal: abort.signal,
      });
      if (result.blob) downloadBlob(result.blob, timestampName('strata', 'mp4'));
      setStatus(
        `Saved ${result.width}x${result.height} ${result.codec}, ${result.duration.toFixed(1)} s ` +
          `in ${result.elapsed.toFixed(1)} s`,
      );
    } finally {
      $('cancel').hidden = true;
    }
  });
$('cancel').onclick = () => abort?.abort();

setStatus(`Renderer: ${scene.kind}. P screenshot, R record.`);

// Hooks for src/capture/demo/verify.mjs.
Object.assign(window, {
  __capture: {
    scene,
    canvas,
    runOffline: (req: OfflineRequest) => exclusive(() => runOffline(req)),
    still: (width: number, height: number, supersample: number) =>
      exclusive(() => captureStillPNG({ canvas, width, height, supersample, render: () => scene.render(livePose()), capture: scene.capture })),
    tiled: (width: number, height: number, tileSize: number) =>
      exclusive(() => captureTiledPNG({ canvas, width, height, tileSize, render: (t) => scene.render(livePose(), t), capture: scene.capture })),
    single: (width: number, height: number) =>
      exclusive(() => captureStillPNG({ canvas, width, height, supersample: 1, render: () => scene.render(livePose()), capture: scene.capture })),
    /** PNG of the next live frame, captured right after it renders. */
    screenshot: () => new Promise<Blob>((resolve) => shotWaiters.push(resolve)),
    /** Reads an MP4 back and reports what is actually in the file. */
    probe: async (blob: Blob) => {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('no video track');
      const stats = await track.computePacketStats();
      return {
        width: track.displayWidth,
        height: track.displayHeight,
        duration: await input.computeDuration(),
        packets: stats.packetCount,
        fps: stats.averagePacketRate,
        bitrate: stats.averageBitrate,
      };
    },
    controller,
  },
});
