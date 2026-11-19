// Standalone page for the trillion kernel: renders one frame progressively
// and shows the exact tally. URL: ?n=1e12&planes=256&w=1920&h=1080&offscreen
// Laws: default stand-ins, ?offline (src/offline laws), ?strat (the same
// laws on the stratified fast path). &shot=close for the close-up camera.
// ?bench&w=3840&h=2160&n=1e10: four-mode bench, wide and close-up.
// __trillion.compare(): strata vs plain path, per pixel counts within noise.
//
// window.__trillion.selftest() checks that the counter sum equals the landed
// tally and that two different batch sizes give bit-identical counts.

import { CountToneMapper } from '../../render';
import { TrillionKernel, planeHomography, renderFrame, trillionLimits, STANDIN_LAWS, OFFLINE_LAWS, STRATIFIED_OFFLINE_LAWS, type TrillionPlane } from '..';

const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 1e10);
const PLANES = Math.max(1, Number(q.get('planes') ?? Math.max(1, Math.ceil(N / 2 ** 32))));
const offscreen = q.has('offscreen');
/** Shared memory counters per workgroup, e.g. ?tile=4096 (16 KB, more workgroups per SM) vs the default 8160 (32 KB). */
const TILE = q.has('tile') ? Number(q.get('tile')) : undefined;
const info = document.getElementById('info')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = far / (near - far); m[11] = -1; m[14] = (near * far) / (near - far);
  return m;
}
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function lookAt(eye: number[], target: number[]): Float32Array {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

/** Mid-range params per law (offline laws: see src/offline/core/world.ts). */
const PARAMS: Record<string, number[]> = {
  kepler: [0.25, 3, 0.05, 1.2, 0.035, 0.2, 0.03, 0],
  vortex: [12, 0.6, 0.3, 0.25, 0.7, 0, 0, 0],
  lissajous: [3, 2, 8, 0.03, 0.25, 0.2, 0.25, 0.92],
};

/** A field of tilted sheets, deterministic. */
const SHOTS: Record<string, { eye: number[]; target: number[] }> = {
  wide: { eye: [0, 2.5, 9], target: [0, 0, 0] },
  close: { eye: [1.2, 0.6, 1.4], target: [2.2, 0, -1.6] },
};

function scene(width: number, height: number, n: number, planes: number, laws: string[], shot = SHOTS.wide): TrillionPlane[] {
  const vp = mul(perspective(0.9, width / height, 0.05, 200), lookAt(shot.eye, shot.target));
  const out: TrillionPlane[] = [];
  let left = n;
  for (let i = 0; i < planes; i++) {
    const count = Math.min(2 ** 32, Math.round(left / (planes - i)));
    left -= count;
    const a = i * 2.39996, r = 1.5 + 4 * Math.sqrt((i + 0.5) / planes);
    const s = 0.6 + 0.5 * ((i * 7) % 5) / 5, tilt = 0.4 + 0.3 * Math.sin(i);
    const c = Math.cos(tilt), sn = Math.sin(tilt);
    // sheet x -> world x, sheet y -> tilted toward the camera
    const model = new Float32Array([s, 0, 0, 0, 0, s * c, -s * sn, 0, 0, sn, c, 0, r * Math.cos(a), 0.6 * Math.sin(i * 1.3), r * Math.sin(a) - 2, 1]);
    const law = laws[i % laws.length];
    out.push({ law, count, seed: (i * 2654435761) >>> 0, params: PARAMS[law] ?? [0.6, 0.15], homography: planeHomography(vp, model, width, height) });
  }
  return out;
}

async function main(): Promise<void> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) { info.textContent = 'WebGPU is not available.'; return; }
  const device = await adapter.requestDevice({ requiredLimits: trillionLimits(adapter) });
  device.lost.then((e) => (info.textContent = `GPU device lost: ${e.message}`));
  const width = Number(q.get('w') ?? (offscreen ? 640 : Math.floor(innerWidth * devicePixelRatio)));
  const height = Number(q.get('h') ?? (offscreen ? 360 : Math.floor(innerHeight * devicePixelRatio)));
  canvas.width = width; canvas.height = height;
  const format: GPUTextureFormat = offscreen ? 'rgba8unorm' : navigator.gpu.getPreferredCanvasFormat();
  const target = offscreen
    ? device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    : null;
  const ctx = offscreen ? null : canvas.getContext('webgpu')!;
  ctx?.configure({ device, format, alphaMode: 'opaque' });

  const LAWS = q.has('strat') ? STRATIFIED_OFFLINE_LAWS : q.has('offline') ? OFFLINE_LAWS : STANDIN_LAWS;
  const kernel = await TrillionKernel.create(device, { width, height, laws: LAWS, tileBins: TILE });
  const mapper = new CountToneMapper(device, { format, words: 2 });
  mapper.resize(width, height);
  const shot = SHOTS[q.get('shot') ?? 'wide'] ?? SHOTS.wide;
  const planes = scene(width, height, N, PLANES, LAWS.map((l) => l.id), shot);

  if (q.has('bench')) {
    const rows = await bench(device, width, height, N, PLANES);
    (window as unknown as Record<string, unknown>).__trillion = { bench: rows, device };
    return;
  }

  const show = async (): Promise<void> => {
    await mapper.measureAndExpose(kernel.counts);
    const enc = device.createCommandEncoder();
    mapper.encode(enc, kernel.counts, (target ?? ctx!.getCurrentTexture()).createView());
    device.queue.submit([enc.finish()]);
  };

  const t0 = performance.now();
  const tally = await renderFrame(kernel, planes, {
    onProgress: (done, total, rate) => {
      const eta = (total - done) / Math.max(rate, 1);
      info.textContent = `${done.toExponential(3)} / ${total.toExponential(3)} particles\n${(rate / 1e9).toFixed(2)} B/s   ${eta.toFixed(0)} s left`;
    },
  });
  const secs = (performance.now() - t0) / 1000;
  await show();
  info.textContent = [
    `${N.toExponential(3)} particles, ${planes.length} planes, ${width}x${height}, tile ${kernel.tileBins} counters`,
    `evaluated ${tally.evaluated.toExponential(4)}   culled ${tally.culled.toExponential(4)}`,
    `in view   ${tally.inView.toExponential(4)}   landed ${tally.landed.toExponential(4)}`,
    tally.patches ? `strata patches ${tally.patches}, ${((100 * tally.tiledPatches) / tally.patches).toFixed(1)}% on a shared memory tile` : 'plain path (no strata patches)',
    `${secs.toFixed(2)} s, ${(tally.evaluated / secs / 1e9).toFixed(2)} B particles/s`,
  ].join('\n');

  const selftest = async (): Promise<{ ok: boolean; landed: number; sum: number; identical: boolean }> => {
    const small = scene(width, height, 2e7, 6, LAWS.map((l) => l.id));
    const a = await renderFrame(kernel, small, { startBudget: 1 << 20, targetMs: 1e9, rounds: 1 });
    const ca = await kernel.readCounts();
    const b = await renderFrame(kernel, small, { startBudget: 3_000_017, targetMs: 1e9, rounds: 7 });
    const cb = await kernel.readCounts();
    let sum = 0, identical = a.landed === b.landed;
    for (let i = 0; i < ca.length; i++) { sum += ca[i]; if (ca[i] !== cb[i]) identical = false; }
    const ok = sum === a.landed && identical && a.evaluated + a.culled === 2e7;
    return { ok, landed: a.landed, sum, identical };
  };
  // Statistical check of the strata path against the plain one: same laws,
  // same distribution, so per pixel counts must agree within noise.
  const compare = async (n = 2e7): Promise<Record<string, number>> => {
    const plain = await TrillionKernel.create(device, { width, height, laws: OFFLINE_LAWS });
    const strat = await TrillionKernel.create(device, { width, height, laws: STRATIFIED_OFFLINE_LAWS });
    const sc = scene(width, height, n, 6, OFFLINE_LAWS.map((l) => l.id));
    const ta = await renderFrame(plain, sc, { targetMs: 1e9, startBudget: 1 << 22 });
    const a = await plain.readCounts();
    const tb = await renderFrame(strat, sc, { targetMs: 1e9, startBudget: 1 << 22 });
    const b = await strat.readCounts();
    let m = 0, m2 = 0, k = 0, big = 0, worst = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] + b[i] < 200) continue;
      const z = (b[i] - a[i]) / Math.sqrt(a[i] + b[i]);
      m += z; m2 += z * z; k++;
      worst = Math.max(worst, Math.abs(z));
      if (Math.abs(z) > 5) big++;
    }
    const mean = m / Math.max(k, 1);
    const out = {
      landedPlain: ta.landed, landedStrata: tb.landed, landedRelDiff: (tb.landed - ta.landed) / Math.max(ta.landed, 1),
      pixels: k, zMean: mean, zStd: Math.sqrt(Math.max(m2 / Math.max(k, 1) - mean * mean, 0)), zWorst: worst, over5: big,
      tiledPatches: tb.tiledPatches, patches: tb.patches,
    };
    plain.destroy();
    strat.destroy();
    return out;
  };
  (window as unknown as Record<string, unknown>).__trillion = { kernel, tally, selftest, compare, device };
}

interface BenchRow { shot: string; mode: string; particles: number; seconds: number; billionPerSecond: number; secondsPer1T: number; tiled: string }

/**
 * Four-mode bench (brief: docs/briefs/throughput-math-2070.md, lever 5):
 * math only, random global atomics, run merge, run merge + tile; wide and
 * close-up shots. Prints a table and leaves it on window.__trillion.bench.
 */
async function bench(device: GPUDevice, width: number, height: number, n: number, planesCount: number): Promise<BenchRow[]> {
  const plain = await TrillionKernel.create(device, { width, height, laws: OFFLINE_LAWS, tileBins: TILE });
  const strat = await TrillionKernel.create(device, { width, height, laws: STRATIFIED_OFFLINE_LAWS, tileBins: TILE });
  const modes: { mode: string; k: TrillionKernel; m: 'full' | 'math' | 'noTile' }[] = [
    { mode: 'math only', k: plain, m: 'math' },
    { mode: 'random global atomics', k: plain, m: 'full' },
    { mode: 'run merge', k: strat, m: 'noTile' },
    { mode: 'run merge + tile', k: strat, m: 'full' },
  ];
  const rows: BenchRow[] = [];
  const ids = OFFLINE_LAWS.map((l) => l.id);
  for (const shotName of ['wide', 'close']) {
    const planes = scene(width, height, n, planesCount, ids, SHOTS[shotName]);
    for (const { mode, k, m } of modes) {
      k.settings.mode = m;
      info.textContent = `bench: ${shotName}, ${mode} ...\n` + rows.map(fmt).join('\n');
      await renderFrame(k, scene(width, height, Math.min(n, 1e8), planesCount, ids, SHOTS[shotName]));   // warm up
      const t0 = performance.now();
      const t = await renderFrame(k, planes, { targetMs: 200 });
      const seconds = (performance.now() - t0) / 1000;
      const rate = t.evaluated / seconds;
      rows.push({
        shot: shotName, mode, particles: t.evaluated, seconds,
        billionPerSecond: rate / 1e9, secondsPer1T: 1e12 / rate,
        tiled: t.patches ? `${((100 * t.tiledPatches) / t.patches).toFixed(0)}%` : '-',
      });
    }
  }
  plain.destroy();
  strat.destroy();
  const head = `trillion bench, ${width}x${height}, ${n.toExponential(1)} particles per run, ${planesCount} planes, tile ${strat.tileBins} counters`;
  info.textContent = [head, ...rows.map(fmt)].join('\n');
  console.table(rows);
  return rows;
}

function fmt(r: BenchRow): string {
  return `${r.shot.padEnd(6)} ${r.mode.padEnd(22)} ${r.billionPerSecond.toFixed(2).padStart(7)} B/s  ${r.secondsPer1T.toFixed(1).padStart(7)} s per 1T  tile ${r.tiled}`;
}

main().catch((e) => { info.textContent = String(e?.stack ?? e); console.error(e); });
