/**
 * Standalone benchmark for the perf path. Open /src/perf/bench/ in the dev server.
 *
 * URL parameters:
 *   n=50M        total particles (suffix K or M)
 *   planes=64    number of planes
 *   cull=0|1     per-plane frustum culling
 *   lod=0|1      particle and rate LOD
 *   hidden=0|1   simulate particles LOD is not drawing (1 = exact, 0 = cheaper)
 *   bilinear=1   2x2 splats
 *   density=4    LOD target particles per pixel
 *   sim=0        draw only
 *   auto=0       stop the camera orbit
 *   res=1920x1080  fixed drawing buffer size
 *   timer=0      do not use GPU timestamp queries
 *   offscreen=1  render to a texture instead of the canvas (no presentation)
 *   bench=1      run the automated sweep and print a table
 *   selftest=1   run correctness checks
 */

import { mat4LookAt, mat4Multiply, mat4Perspective, PerfEngine, requestPerfDevice } from '../index';
import { runSelfTest } from './selftest';
import { buildWorld, type BenchWorld } from './world';

const q = new URLSearchParams(location.search);
const flag = (k: string, d: boolean) => (q.has(k) ? q.get(k) !== '0' : d);
function count(s: string | null, d: number): number {
  if (!s) return d;
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s);
  if (!m) return d;
  const mul = m[2] === '' ? 1 : m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
  return Math.round(parseFloat(m[1]) * mul);
}
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`);

const cfg = {
  n: count(q.get('n'), 10e6),
  planes: Math.max(1, count(q.get('planes'), 64)),
  cull: flag('cull', true),
  lod: flag('lod', true),
  hidden: flag('hidden', true),
  bilinear: flag('bilinear', false),
  density: parseFloat(q.get('density') ?? '4'),
  sim: flag('sim', true),
  auto: flag('auto', true),
  res: /^(\d+)x(\d+)$/.exec(q.get('res') ?? ''),
};

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const bar = document.getElementById('bar')!;
const report = document.getElementById('report')!;
const errorBox = document.getElementById('error')!;

function fail(e: unknown): void {
  errorBox.style.display = 'flex';
  errorBox.textContent = e instanceof Error ? e.message : String(e);
  console.error(e);
}

function link(label: string, changes: Record<string, string | null>, on = false): void {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(changes)) v === null ? p.delete(k) : p.set(k, v);
  const a = document.createElement('a');
  a.textContent = label;
  a.href = `?${p}`;
  if (on) a.className = 'on';
  bar.appendChild(a);
}

const camera = { yaw: 0.6, pitch: 0.35, dist: 2.2, target: [0, 0, 0] as [number, number, number] };
const view = new Float32Array(16);
const proj = new Float32Array(16);
const viewProj = new Float32Array(16);

function updateCamera(aspect: number): void {
  const cp = Math.cos(camera.pitch);
  const eye = [
    camera.target[0] + camera.dist * cp * Math.sin(camera.yaw),
    camera.target[1] + camera.dist * Math.sin(camera.pitch),
    camera.target[2] + camera.dist * cp * Math.cos(camera.yaw),
  ];
  mat4LookAt(view, eye, camera.target, [0, 1, 0]);
  mat4Perspective(proj, (50 * Math.PI) / 180, aspect, 0.01, 500);
  mat4Multiply(viewProj, proj, view);
}

function sizeCanvas(): void {
  const w = cfg.res ? +cfg.res[1] : Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  const h = cfg.res ? +cfg.res[2] : Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

interface Setup {
  engine: PerfEngine;
  world: BenchWorld;
}

async function setup(
  device: GPUDevice,
  format: GPUTextureFormat,
  n: number,
  planes: number,
  cull: boolean,
  lod: boolean,
): Promise<Setup> {
  device.pushErrorScope('out-of-memory');
  const engine = new PerfEngine(device, {
    format,
    lod: { culling: cull, lod, pixelDensity: cfg.density, simulateHidden: cfg.hidden },
  });
  // A plane must fit in one page; use more planes when the request needs it.
  const needed = Math.max(planes, Math.ceil(n / engine.pool.maxRange));
  const world = buildWorld(engine, n, needed);
  const oom = await device.popErrorScope();
  if (oom) {
    engine.destroy();
    throw new Error(`Out of GPU memory at ${fmt(n)} particles: ${oom.message}`);
  }
  engine.simulate = cfg.sim;
  engine.bilinear = cfg.bilinear;
  engine.resize(canvas.width, canvas.height);
  // Keep the picture readable as density grows: dimmer particles, same look.
  engine.exposure = Math.min(1, Math.max(0.01, (1.2 * canvas.width * canvas.height) / world.particles));
  camera.dist = Math.max(1.4, world.radius * 0.75);
  return { engine, world };
}

async function main(): Promise<void> {
  const device = await requestPerfDevice({ timestamps: flag('timer', true) });
  device.lost.then((info) => fail(`WebGPU device lost (${info.reason}): ${info.message}`));
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));
  const format = navigator.gpu.getPreferredCanvasFormat();
  sizeCanvas();
  let target: () => GPUTextureView;
  if (flag('offscreen', false)) {
    let tex: GPUTexture | undefined;
    target = () => {
      if (!tex || tex.width !== canvas.width || tex.height !== canvas.height) {
        tex?.destroy();
        tex = device.createTexture({
          size: [canvas.width, canvas.height],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        (window as unknown as Record<string, unknown>).__target = tex;
      }
      return tex.createView();
    };
  } else {
    const context = canvas.getContext('webgpu')!;
    context.configure({ device, format, alphaMode: 'opaque' });
    target = () => context.getCurrentTexture().createView();
  }

  if (q.has('selftest')) {
    const results = await runSelfTest(device);
    const failed = results.filter((r) => !r.ok).length;
    report.style.display = 'block';
    report.textContent =
      `self test: ${results.length - failed}/${results.length} passed\n\n` +
      results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `\n       ${r.detail}` : ''}`).join('\n');
    (window as unknown as Record<string, unknown>).__selftest = { failed, results };
    return;
  }

  if (q.has('bench')) {
    await sweep(device, target, format);
    return;
  }

  const { engine, world } = await setup(device, format, cfg.n, cfg.planes, cfg.cull, cfg.lod);
  (window as unknown as Record<string, unknown>).__engine = engine;

  // --- controls -----------------------------------------------------------
  for (const n of ['1M', '5M', '10M', '25M', '50M', '100M']) link(n, { n }, count(n, 0) === cfg.n);
  link('cull', { cull: cfg.cull ? '0' : '1' }, cfg.cull);
  link('lod', { lod: cfg.lod ? '0' : '1' }, cfg.lod);
  link('sim hidden', { hidden: cfg.hidden ? '0' : '1' }, cfg.hidden);
  link('bilinear', { bilinear: cfg.bilinear ? '0' : '1' }, cfg.bilinear);
  link('sim', { sim: cfg.sim ? '0' : '1' }, cfg.sim);
  link('orbit', { auto: cfg.auto ? '0' : '1' }, cfg.auto);
  link('run sweep', { bench: '1' });
  link('self test', { selftest: '1' });

  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    camera.yaw -= e.movementX * 0.005;
    camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + e.movementY * 0.005));
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      camera.dist = Math.max(0.05, Math.min(400, camera.dist * Math.exp(e.deltaY * 0.001)));
    },
    { passive: false },
  );
  addEventListener('keydown', (e) => {
    if (e.key === '[') engine.exposure *= 0.8;
    if (e.key === ']') engine.exposure *= 1.25;
  });

  // --- loop ---------------------------------------------------------------
  let last = performance.now();
  let frameMs = 16.7;
  let gpuMs = 0;
  let cpuMs = 0;
  let time = 0;
  let hudAt = 0;

  const tick = (now: number) => {
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(rawDt, 0.05);
    time += dt;
    frameMs += (rawDt * 1000 - frameMs) * 0.05;
    if (cfg.auto && !dragging) camera.yaw += dt * 0.12;

    sizeCanvas();
    engine.resize(canvas.width, canvas.height);
    updateCamera(canvas.width / canvas.height);

    const t0 = performance.now();
    const s = engine.frame({ viewProj, dt, time, target: target() });
    cpuMs += (performance.now() - t0 - cpuMs) * 0.05;
    const g = s.gpuComputeMs + s.gpuResolveMs;
    gpuMs += (g - gpuMs) * 0.1;

    if (now - hudAt > 200) {
      hudAt = now;
      hud.textContent =
        `${fmt(s.totalParticles)} particles   ${s.planes} planes   ${canvas.width}x${canvas.height} (${fmt(canvas.width * canvas.height)} px)\n` +
        `${(1000 / frameMs).toFixed(0)} fps   frame ${frameMs.toFixed(1)} ms   cpu ${cpuMs.toFixed(2)} ms   ` +
        (engine.hasGpuTimer ? `gpu ${gpuMs.toFixed(2)} ms (compute ${s.gpuComputeMs.toFixed(2)}, resolve ${s.gpuResolveMs.toFixed(2)})\n` : 'gpu timer unavailable\n') +
        `visible ${s.visiblePlanes}/${s.planes} planes   drawn ${fmt(s.drawnParticles)}   simulated ${fmt(s.simulatedParticles)}   dispatches ${s.dispatches}\n` +
        `particle memory ${(engine.particleBytes / 2 ** 20).toFixed(0)} MB in ${engine.pool.pages.length} pages   exposure ${engine.exposure.toFixed(3)}\n` +
        `drag to orbit, wheel to zoom, [ ] exposure`;
      (window as unknown as Record<string, unknown>).__stats = { ...s, frameMs, cpuMs, world };
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Automated sweep. For each particle count it measures throughput without
 * vsync: submit a batch of frames back to back and wait for the GPU to finish
 * them. That works on every browser, with or without timestamp queries.
 */
async function sweep(device: GPUDevice, target: () => GPUTextureView, format: GPUTextureFormat): Promise<void> {
  const counts = (q.get('counts') ?? '1M,2M,5M,10M,20M,35M,50M,75M,100M').split(',').map((s) => count(s, 0));
  const modes: [string, boolean, boolean][] = [
    ['cull+lod', true, true],
    ['brute', false, false],
  ];
  const batch = Math.max(1, count(q.get('batch'), 30));
  const rows: Record<string, number | string>[] = [];
  report.style.display = 'block';
  const header = `sweep at ${canvas.width}x${canvas.height}, ${cfg.planes}+ planes, ${batch} frames per sample\n\n` +
    'particles  mode       ms/frame     fps   drawn   simulated/frame  visible\n';
  const lines: string[] = [];
  const print = (extra = '') => (report.textContent = header + lines.join('\n') + (extra ? `\n\n${extra}` : ''));
  print('running...');

  outer: for (const n of counts) {
    for (const [name, cull, lod] of modes) {
      let s: Setup;
      try {
        s = await setup(device, format, n, cfg.planes, cull, lod);
      } catch (e) {
        lines.push(`${fmt(n).padStart(9)}  ${String(e instanceof Error ? e.message : e)}`);
        break outer;
      }
      const { engine } = s;
      updateCamera(canvas.width / canvas.height);
      const run = async (frames: number) => {
        let drawn = 0;
        let simulated = 0;
        let visible = 0;
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          camera.yaw += 0.002;
          updateCamera(canvas.width / canvas.height);
          const st = engine.frame({ viewProj, dt: 1 / 60, time: i / 60, target: target() });
          drawn += st.drawnParticles;
          simulated += st.simulatedParticles;
          visible += st.visiblePlanes;
        }
        await device.queue.onSubmittedWorkDone();
        return { ms: (performance.now() - t0) / frames, drawn: drawn / frames, simulated: simulated / frames, visible: visible / frames };
      };
      await run(4); // warm up: pipeline compile, first touch of the pages
      const r = await run(batch);
      rows.push({ particles: s.world.particles, mode: name, msPerFrame: r.ms, fps: 1000 / r.ms, drawn: r.drawn, simulated: r.simulated });
      lines.push(
        `${fmt(s.world.particles).padStart(9)}  ${name.padEnd(9)} ${r.ms.toFixed(2).padStart(9)} ${(1000 / r.ms).toFixed(0).padStart(7)} ` +
          `${fmt(Math.round(r.drawn)).padStart(7)}   ${fmt(Math.round(r.simulated)).padStart(14)}  ${r.visible.toFixed(0)}/${engine.planeCount}`,
      );
      print('running...');
      engine.destroy();
      await new Promise((res) => requestAnimationFrame(res));
      if (r.ms > 500) break outer; // far past interactive, no point going on
    }
  }
  print('done');
  (window as unknown as Record<string, unknown>).__bench = rows;
}

main().catch(fail);
