// @ts-check
/**
 * Quick self-checks for the offline renderer. Seconds on any adapter.
 *
 *   conservation     with everything in view, the grid sum is exactly N * ONE
 *   batch invariance different batch sizes give bit-identical grids
 *   64-bit carry     more light in one pixel than a u32 holds is still exact
 *   CPU cross-check  the shader agrees with the double-precision reference
 *   resume           a checkpointed frame continues to the identical result
 */
import { create, globals } from "webgpu";

import { CameraPath } from "../core/camera";
import { ONE } from "../core/job";
import { lawPosition, particleKey, draw, u01 } from "../core/laws";
import { cameraBasis, planeHomography } from "../core/math";
import { decodeGrayPng16, encodeGrayPng } from "../core/png";
import { StatelessRenderer, accumulationSum } from "../core/renderer";
import { nodeZlib } from "./platform.mjs";

Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) throw new Error("No GPU adapter");
const device = await adapter.requestDevice();
// Dawn aborts the process if the instance or adapter is garbage collected while a device lives.
Object.assign(globalThis, { __strataDawn: [gpu, adapter, device] });
/** @type {string[]} */
const gpuErrors = [];
device.addEventListener("uncapturederror", (e) => gpuErrors.push(e.error?.message ?? String(e)));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const LAWS = /** @type {const} */ (["kepler", "vortex", "lissajous"]);
const PARAMS = {
  kepler: [0.3, 3.2, 0.03, 1.1, 0.03, 0.22, 0.03, 0],
  vortex: [12, 0.6, 0.3, 0.25, 0.7, 0, 0, 0],
  lissajous: [3, 2, 6, 0.03, 0.2, 0.3, 0.2, 0.92],
};

/** A small job: three tilted sheets, one per law, all comfortably in view. */
function testJob(overrides = {}) {
  return {
    version: 1,
    name: "test",
    width: 320,
    height: 180,
    fps: 30,
    frames: 4,
    timeScale: 1,
    timeOffset: 40,
    ssaa: 1,
    splat: "point",
    weighting: "count",
    fluxRef: 1,
    shutter: 0.5,
    near: 0.01,
    planes: LAWS.map((law, i) => ({
      position: [(i - 1) * 1.6, 0.1 * i, -0.3 * i],
      rotation: [0.2 * i, 0.1, 0.05 * i, Math.sqrt(1 - 0.04 * i * i - 0.01 - 0.0025 * i * i)],
      halfSize: [0.7, 0.7],
      law,
      seed: 1000 + i,
      particleCount: 300_000 + i * 12_345,
      params: PARAMS[law],
    })),
    camera: [
      { t: 0, target: [0, 0, 0], yaw: 0.1, pitch: -0.1, distance: 9, fovY: 0.7 },
      { t: 1, target: [0, 0, 0], yaw: 0.4, pitch: -0.2, distance: 8, fovY: 0.7 },
    ],
    ...overrides,
  };
}

async function renderOnce(job, opts = {}, frame = 1, hooks = {}) {
  const r = await StatelessRenderer.create(device, /** @type {any} */ (job), opts);
  try {
    return await r.renderFrame(frame, hooks);
  } finally {
    r.dispose();
  }
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- conservation -----------------------------------------------------------
for (const splat of ["point", "bilinear"]) {
  const job = testJob({ splat });
  const n = job.planes.reduce((s, p) => s + p.particleCount, 0);
  const out = await renderOnce(job);
  const sum = accumulationSum(out.lo, out.hi);
  check(`conservation, ${splat}`, sum === BigInt(n) * BigInt(ONE) && out.landed === BigInt(n) && out.gpuEvaluated === BigInt(n), `${sum / BigInt(ONE)} of ${n} particles, landed ${out.landed}, evaluated ${out.gpuEvaluated}`);
}

// ---- tally matches the grid with part of the world off frame ----------------
{
  const job = testJob();
  job.camera = [{ t: 0, target: [0.4, 0.2, 0], yaw: 0.3, pitch: -0.2, distance: 1.6, fovY: 0.7 }];
  const n = job.planes.reduce((s, p) => s + p.particleCount, 0);
  const out = await renderOnce(job);
  const inGrid = accumulationSum(out.lo, out.hi) / BigInt(ONE);
  check("tally equals grid count, partly off frame", out.landed === inGrid && inGrid > 0n && inGrid < BigInt(n), `${out.landed} landed of ${n}`);
}

// ---- cancel ---------------------------------------------------------------------
{
  const controller = new AbortController();
  let error = null;
  try {
    await renderOnce(testJob(), { initialBatch: 50_000, maxBatch: 50_000 }, 1, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
  } catch (e) {
    error = e;
  }
  check("cancel rejects with AbortError", error?.name === "AbortError", error?.message ?? "no error");
}

// ---- cancel keeps the work done so far, and the frame resumes exactly ---------
{
  const job = testJob({ splat: "bilinear" });
  const opts = { initialBatch: 60_000, maxBatch: 60_000 };
  const whole = await renderOnce(job, opts);
  const controller = new AbortController();
  /** @type {any} */
  let saved = null;
  let batches = 0;
  try {
    await renderOnce(job, opts, 1, {
      signal: controller.signal,
      checkpoint: { everyMs: 1e9, save: async (cursor, acc) => void (saved = { cursor, ...acc }) },
      onProgress: () => {
        if (++batches === 7) controller.abort();
      },
    });
  } catch (e) {
    if (/** @type {Error} */ (e).name !== "AbortError") throw e;
  }
  const resumed = saved ? await renderOnce(job, opts, 1, { resume: saved }) : null;
  check("cancel saves a checkpoint that resumes exactly", resumed !== null && same(whole.lo, resumed.lo) && whole.landed === resumed.landed && resumed.gpuEvaluated === whole.gpuEvaluated, saved ? `saved after ${saved.gpuEvaluated} particles` : "nothing saved");
}

// ---- batch invariance -------------------------------------------------------
{
  const job = testJob({ splat: "bilinear", weighting: "flux", fluxRef: 8.5 });
  const a = await renderOnce(job, { initialBatch: 50_000, maxBatch: 50_000, perInvocation: 7 });
  const b = await renderOnce(job, { initialBatch: 2 ** 20, perInvocation: 64 });
  check("batch invariance", same(a.lo, b.lo) && same(a.hi, b.hi), `${a.batches} vs ${b.batches} batches`);
}

// ---- 64-bit carry -----------------------------------------------------------
{
  // A sheet so small that it lands inside a single pixel.
  const job = testJob();
  job.planes = [{ ...job.planes[0], position: [0.015, 0.015, 0], halfSize: [1e-4, 1e-4], particleCount: 200_000 }];
  const out = await renderOnce(job);
  const lit = [...out.lo.keys()].filter((i) => out.lo[i] || out.hi[i]);
  const sum = accumulationSum(out.lo, out.hi);
  const expected = 200_000n * BigInt(ONE);
  check("64-bit carry", lit.length === 1 && sum === expected && out.hi[lit[0]] === Number(expected >> 32n), `hi word ${out.hi[lit[0]]}, ${lit.length} lit pixel`);
}

// ---- CPU cross-check --------------------------------------------------------
for (const law of LAWS) {
  const job = testJob();
  job.planes = [{ ...job.planes[LAWS.indexOf(law)], particleCount: 200_000 }];
  const frame = 2;
  const out = await renderOnce(job, {}, frame);
  // Reference: same hash and law in doubles, same projection, point splat.
  const ref = new Float64Array(job.width * job.height);
  const cam = cameraBasis(new CameraPath(/** @type {any} */ (job.camera)).atFrame(frame, job.frames));
  const plane = job.planes[0];
  const h = planeHomography(cam, /** @type {any} */ (plane), job.width, job.height);
  const time = job.timeOffset + (frame / job.fps) * job.timeScale;
  const span = (job.shutter / job.fps) * job.timeScale;
  for (let i = 0; i < plane.particleCount; i++) {
    const key = particleKey(i, plane.seed);
    const t = time + span * (u01(draw(key, 6)) - 0.5);
    const [x, y] = lawPosition(law, key, t, plane.params);
    const depth = h[2] * x + h[5] * y + h[8];
    if (!(depth > job.near)) continue;
    const px = (h[0] * x + h[3] * y + h[6]) / depth;
    const py = (h[1] * x + h[4] * y + h[7]) / depth;
    if (px >= 0 && py >= 0 && px < job.width && py < job.height) ref[Math.floor(py) * job.width + Math.floor(px)]++;
  }
  // A particle that lands in a different pixel on the GPU (f32) shows up twice in the L1 distance.
  let l1 = 0;
  for (let i = 0; i < ref.length; i++) l1 += Math.abs(ref[i] - (out.lo[i] + out.hi[i] * 2 ** 32) / ONE);
  const moved = l1 / 2 / plane.particleCount;
  check(`CPU cross-check, ${law}`, moved < 0.002, `${(moved * 100).toFixed(4)}% of particles in a different pixel`);
}

// ---- resume -----------------------------------------------------------------
{
  const job = testJob({ splat: "bilinear" });
  const whole = await renderOnce(job, { initialBatch: 100_000, maxBatch: 100_000 });
  /** @type {any} */
  let saved = null;
  try {
    await renderOnce(job, { initialBatch: 100_000, maxBatch: 100_000 }, 1, {
      checkpoint: {
        everyMs: 0,
        save: async (cursor, acc) => {
          saved = { cursor, ...acc };
          // Stop partway, like a crash would.
          if (cursor.plane >= 1) throw new Error("stop");
        },
      },
    });
  } catch (e) {
    if (/** @type {Error} */ (e).message !== "stop") throw e;
  }
  const resumed = await renderOnce(job, { initialBatch: 77_777, maxBatch: 77_777 }, 1, { resume: saved });
  check("resume from checkpoint", saved !== null && same(whole.lo, resumed.lo) && same(whole.hi, resumed.hi) && whole.landed === resumed.landed && resumed.gpuEvaluated === whole.gpuEvaluated, `resumed at plane ${saved?.cursor.plane}, offset ${saved?.cursor.offset}`);
}

// ---- PNG round trip ---------------------------------------------------------
{
  const samples = new Uint16Array(64 * 48).map((_, i) => (i * 2654435761) >>> 16);
  const back = await decodeGrayPng16(await encodeGrayPng(samples, 64, 48, nodeZlib), nodeZlib);
  check("16-bit PNG round trip", back.width === 64 && back.height === 48 && same(samples, back.samples));
}

check("no GPU validation errors", gpuErrors.length === 0, gpuErrors[0] ?? "");
device.destroy();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
