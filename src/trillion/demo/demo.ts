// Standalone page for the trillion kernel: renders one frame progressively
// and shows the exact tally. URL: ?n=1e12&planes=256&w=1920&h=1080&offscreen
//
// window.__trillion.selftest() checks that the counter sum equals the landed
// tally and that two different batch sizes give bit-identical counts.

import { CountToneMapper } from '../../render';
import { TrillionKernel, planeHomography, renderFrame, trillionLimits, STANDIN_LAWS, type TrillionPlane } from '..';

const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 1e10);
const PLANES = Math.max(1, Number(q.get('planes') ?? Math.max(1, Math.ceil(N / 2 ** 32))));
const offscreen = q.has('offscreen');
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

/** A field of tilted sheets, deterministic. */
function scene(width: number, height: number, n: number, planes: number, laws: string[]): TrillionPlane[] {
  const vp = mul(perspective(0.9, width / height, 0.05, 200), lookAt([0, 2.5, 9], [0, 0, 0]));
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
    out.push({ law: laws[i % laws.length], count, seed: (i * 2654435761) >>> 0, params: [0.6, 0.15], homography: planeHomography(vp, model, width, height) });
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

  const kernel = await TrillionKernel.create(device, { width, height, laws: STANDIN_LAWS });
  const mapper = new CountToneMapper(device, { format, words: 2 });
  mapper.resize(width, height);
  const planes = scene(width, height, N, PLANES, STANDIN_LAWS.map((l) => l.id));

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
    `${secs.toFixed(2)} s, ${(tally.evaluated / secs / 1e9).toFixed(2)} B particles/s`,
  ].join('\n');

  const selftest = async (): Promise<{ ok: boolean; landed: number; sum: number; identical: boolean }> => {
    const small = scene(width, height, 2e7, 6, STANDIN_LAWS.map((l) => l.id));
    const a = await renderFrame(kernel, small, { startBudget: 1 << 20, targetMs: 1e9, rounds: 1 });
    const ca = await kernel.readCounts();
    const b = await renderFrame(kernel, small, { startBudget: 3_000_017, targetMs: 1e9, rounds: 7 });
    const cb = await kernel.readCounts();
    let sum = 0, identical = a.landed === b.landed;
    for (let i = 0; i < ca.length; i++) { sum += ca[i]; if (ca[i] !== cb[i]) identical = false; }
    const ok = sum === a.landed && identical && a.evaluated + a.culled === 2e7;
    return { ok, landed: a.landed, sum, identical };
  };
  (window as unknown as Record<string, unknown>).__trillion = { kernel, tally, selftest, device };
}

main().catch((e) => { info.textContent = String(e?.stack ?? e); console.error(e); });
