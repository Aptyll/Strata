// @ts-check
/**
 * Quick self-checks for the offline renderer. Seconds on any adapter.
 *
 *   conservation     with everything in view, the grid sum is exactly N * ONE
 *   flux             far particles keep their light: every one in frame adds
 *                    some, and the total matches a double-precision reference
 *   batch invariance different batch sizes give bit-identical grids
 *   64-bit carry     more light in one pixel than a u32 holds is still exact
 *   CPU cross-check  the shader agrees with the double-precision reference
 *   resume           a checkpointed frame continues to the identical result,
 *                    and reports the time and batches of every run, not the last
 */
import { create, globals } from "webgpu";

import { CameraPath } from "../core/camera";
import { ONE } from "../core/job";
import { lawPosition, particleKey, draw, u01 } from "../core/laws";
import { STATELESS_LAWS } from "../../stateless/laws";
import { cameraBasis, planeHomography } from "../core/math";
import { decodeGrayPng16, encodeGrayPng } from "../core/png";
import { StatelessRenderer, accumulationSum } from "../core/renderer";
import { renderJob } from "../core/session";
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
  check(`conservation, ${splat}`, sum === BigInt(n) * BigInt(ONE) && out.landed === BigInt(n) && out.drawn === BigInt(n) && out.gpuEvaluated === BigInt(n) && out.unitsPerParticle === ONE, `${sum / BigInt(ONE)} of ${n} particles, landed ${out.landed}, drawn ${out.drawn}, evaluated ${out.gpuEvaluated}`);
}

// ---- flux: far particles keep their light ---------------------------------------
/**
 * Double-precision reference: visits every particle of a job's frame that
 * lands inside the picture, with its depth. Same hash, law and projection as
 * the shader, including each particle's shutter instant and the camera's.
 */
function eachInFrame(job, frame, visit) {
  const path = new CameraPath(/** @type {any} */ (job.camera));
  const cam = cameraBasis(path.atFrame(frame, job.frames));
  const shutterSpan = job.frames > 1 ? job.shutter / (job.frames - 1) : 0;
  const tMid = job.frames > 1 ? frame / (job.frames - 1) : 0;
  const time = job.timeOffset + (frame / job.fps) * job.timeScale;
  const span = (job.shutter / job.fps) * job.timeScale;
  for (const plane of job.planes) {
    const h0 = planeHomography(cam, /** @type {any} */ (plane), job.width, job.height);
    const ho = planeHomography(cameraBasis(path.at(tMid - shutterSpan / 2)), /** @type {any} */ (plane), job.width, job.height);
    const hc = planeHomography(cameraBasis(path.at(tMid + shutterSpan / 2)), /** @type {any} */ (plane), job.width, job.height);
    for (let i = 0; i < plane.particleCount; i++) {
      const key = particleKey(i, plane.seed);
      const s = u01(draw(key, 6)) - 0.5;
      const h = h0.map((v, j) => v + s * (hc[j] - ho[j]));
      const [x, y] = lawPosition(plane.law, key, time + span * s, plane.params);
      const depth = h[2] * x + h[5] * y + h[8];
      if (!(depth > job.near)) continue;
      const px = (h[0] * x + h[3] * y + h[6]) / depth;
      const py = (h[1] * x + h[4] * y + h[7]) / depth;
      if (px >= 0 && py >= 0 && px < job.width && py < job.height) visit(px, py, depth);
    }
  }
}

for (const splat of ["point", "bilinear"]) {
  // So far away that a particle's weight is about a hundredth of 1/65536.
  const far = { splat, weighting: "flux", fluxRef: 1, camera: [{ t: 0, target: [0, 0, 0], yaw: 0.1, pitch: -0.1, distance: 2500, fovY: 0.7 }] };
  const fineJob = testJob({ ...far, fluxBits: 31 });
  const fine = await renderOnce(fineJob);
  // No fluxBits: the first renders' 16 bits, where such a weight is rounded at random to 1 unit or to 0.
  const coarse = await renderOnce(testJob(far));
  let light = 0;
  let inFrame = 0;
  eachInFrame(fineJob, 1, (_px, _py, depth) => {
    light += Math.min(1, (fineJob.fluxRef / depth) ** 2);
    inFrame++;
  });
  const fineLight = Number(accumulationSum(fine.lo, fine.hi)) / fine.unitsPerParticle;
  const coarseSum = accumulationSum(coarse.lo, coarse.hi);
  const coarseLight = Number(coarseSum) / coarse.unitsPerParticle;
  check(
    `flux, ${splat}: every particle in frame adds light`,
    fine.unitsPerParticle === 2 ** 31 && fine.landed === BigInt(inFrame) && fine.drawn === fine.landed,
    `${fine.drawn} drawn of ${fine.landed} in frame`,
  );
  check(
    `flux, ${splat}: total light matches the reference`,
    Math.abs(fineLight / light - 1) < 1e-3,
    `${fineLight.toFixed(4)} particles of light, reference ${light.toFixed(4)}`,
  );
  // The old behaviour, kept for jobs without fluxBits: drawn by a small random
  // share of the particles. Point splats round with 24 random bits, so the
  // total is right on average and each drawn particle adds exactly one unit.
  // Bilinear splats round each of 4 shares with 8 random bits, good to 1/256
  // of a unit, which is as large as a whole share this far away: the total
  // comes out more than 10% too bright here. Finer units fix both.
  check(
    `flux, ${splat}: 16-bit weights draw only a random share`,
    coarse.unitsPerParticle === ONE && coarse.landed === fine.landed && coarse.drawn * 20n < coarse.landed && coarse.drawn > 0n && (splat !== "point" || (coarseSum === coarse.drawn && Math.abs(coarseLight / light - 1) < 0.1)),
    `${coarse.drawn} drawn of ${coarse.landed} in frame, ${coarseLight.toFixed(4)} particles of light against ${light.toFixed(4)}`,
  );
}

// ---- flux: full weights of 2^31 units carry exactly ---------------------------------
{
  // The single-pixel sheet again, this time in flux at full weight and 31 bits:
  // every particle adds 2^31 units, so combining runs must flush before a u32 wraps.
  const job = testJob({ weighting: "flux", fluxRef: 1e6, fluxBits: 31 });
  job.planes = [{ ...job.planes[0], position: [0.015, 0.015, 0], halfSize: [1e-4, 1e-4], particleCount: 200_000 }];
  const out = await renderOnce(job);
  const lit = [...out.lo.keys()].filter((i) => out.lo[i] || out.hi[i]);
  const sum = accumulationSum(out.lo, out.hi);
  const expected = 200_000n << 31n;
  check("flux at full weight: 2^31 units per particle add up exactly", lit.length === 1 && sum === expected && out.drawn === 200_000n, `sum ${sum}, expected ${expected}, ${lit.length} lit pixel`);
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
      checkpoint: { everyMs: 1e9, save: async (cursor, acc, progress) => void (saved = { cursor, ...acc, ...progress }) },
      onProgress: () => {
        if (++batches === 7) controller.abort();
      },
    });
  } catch (e) {
    if (/** @type {Error} */ (e).name !== "AbortError") throw e;
  }
  const resumed = saved ? await renderOnce(job, opts, 1, { resume: saved }) : null;
  check("cancel saves a checkpoint that resumes exactly", resumed !== null && same(whole.lo, resumed.lo) && whole.landed === resumed.landed && resumed.gpuEvaluated === whole.gpuEvaluated, saved ? `saved after ${saved.gpuEvaluated} particles` : "nothing saved");
  // The checkpoint carries the work spent so far, so the continued frame
  // reports the whole frame: every batch, and at least the first run's time.
  check(
    "a continued frame counts the batches and time of every run",
    resumed !== null && saved.batches === 7 && resumed.batches === whole.batches && resumed.resumes === 1 && whole.resumes === 0 && resumed.seconds > saved.seconds && saved.seconds > 0,
    resumed ? `${saved.batches} + ${resumed.batches - saved.batches} of ${whole.batches} batches` : "nothing saved",
  );
}

/** A FileStore in memory, with its files visible to the checks. */
function memoryFiles() {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  const store = {
    read: async (/** @type {string} */ name) => files.get(name) ?? null,
    write: async (/** @type {string} */ name, /** @type {Uint8Array} */ data) => void files.set(name, data),
    remove: async (/** @type {string} */ name) => void files.delete(name),
  };
  return { files, store };
}

// ---- flux through the session: the stored frame is in ONE units -----------------
{
  const { files, store } = memoryFiles();
  const job = testJob({ frames: 1, weighting: "flux", fluxRef: 1, fluxBits: 31, camera: [{ t: 0, target: [0, 0, 0], yaw: 0.1, pitch: -0.1, distance: 2500, fovY: 0.7 }] });
  await renderJob(device, /** @type {any} */ (job), store, nodeZlib, {});
  const statsFile = files.get("frame-000000.json");
  const image = files.get("frame-000000.png");
  const stats = statsFile ? JSON.parse(new TextDecoder().decode(statsFile)) : {};
  // Light in the stored frame, decoded from its log codes, in particles.
  let stored = 0;
  if (image) for (const code of (await decodeGrayPng16(image, nodeZlib)).samples) if (code) stored += (2 ** (code / 1024) - 1) / ONE;
  const direct = await renderOnce(job, {}, 0);
  const light = Number(accumulationSum(direct.lo, direct.hi)) / direct.unitsPerParticle;
  check(
    "session: a flux frame is stored in ONE units, with its units and drawn tally in the stats",
    stats.unitsPerParticle === 2 ** 31 && stats.drawn === stats.landed && stats.unitSum === accumulationSum(direct.lo, direct.hi).toString() && Math.abs(stored / light - 1) < 2e-3,
    `${stored.toFixed(4)} particles of light in the stored frame, ${light.toFixed(4)} in the grid`,
  );
}

// ---- the same through the session: stop, run again, read the frame's stats ------
{
  const { files, store } = memoryFiles();
  const job = testJob({ frames: 1 });
  const opts = { initialBatch: 60_000, maxBatch: 60_000 };
  let batches = 0;
  const first = await renderJob(device, /** @type {any} */ (job), store, nodeZlib, { ...opts, shouldStop: () => batches >= 5, onProgress: () => void batches++ });
  const checkpointed = files.has("partial-000000.bin");
  const second = await renderJob(device, /** @type {any} */ (job), store, nodeZlib, opts);
  const file = files.get("frame-000000.json");
  const stats = file ? JSON.parse(new TextDecoder().decode(file)) : {};
  const whole = await renderOnce(job, opts, 0);
  check(
    "session: a stopped and continued frame reports its whole time and batches",
    first.stopped && checkpointed && second.rendered === 1 && stats.resumes === 1 && stats.batches === whole.batches && stats.seconds > 0 && !files.has("partial-000000.bin"),
    `${stats.batches} of ${whole.batches} batches over ${stats.resumes + 1} runs`,
  );
}

// ---- batch invariance -------------------------------------------------------
{
  for (const overrides of [{ splat: "bilinear", weighting: "flux", fluxRef: 8.5 }, { splat: "point", weighting: "flux", fluxRef: 8.5, fluxBits: 31 }]) {
    const job = testJob(overrides);
    const a = await renderOnce(job, { initialBatch: 50_000, maxBatch: 50_000, perInvocation: 7 });
    const b = await renderOnce(job, { initialBatch: 2 ** 20, perInvocation: 64 });
    check(`batch invariance, flux ${overrides.splat}${overrides.fluxBits ? `, ${overrides.fluxBits} bits` : ""}`, same(a.lo, b.lo) && same(a.hi, b.hi) && a.drawn === b.drawn && a.landed === b.landed, `${a.batches} vs ${b.batches} batches`);
  }
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
for (const law of [...LAWS, ...STATELESS_LAWS.map((l) => l.id)]) {
  const job = testJob();
  // src/stateless laws ride on the first sheet with their default params.
  const core = LAWS.indexOf(/** @type {any} */ (law));
  const stateless = STATELESS_LAWS.find((l) => l.id === law);
  job.planes = [{ ...job.planes[Math.max(0, core)], law, params: stateless ? [...stateless.defaults] : job.planes[core].params, particleCount: 200_000 }];
  const frame = 2;
  const out = await renderOnce(job, {}, frame);
  // Reference: same hash and law in doubles, same projection, point splat.
  const ref = new Float64Array(job.width * job.height);
  const path = new CameraPath(/** @type {any} */ (job.camera));
  const cam = cameraBasis(path.atFrame(frame, job.frames));
  // Camera motion blur: the pose moves with each particle's shutter instant.
  const shutterSpan = job.shutter / (job.frames - 1);
  const tMid = frame / (job.frames - 1);
  const plane = job.planes[0];
  const h0 = planeHomography(cam, /** @type {any} */ (plane), job.width, job.height);
  const ho = planeHomography(cameraBasis(path.at(tMid - shutterSpan / 2)), /** @type {any} */ (plane), job.width, job.height);
  const hc = planeHomography(cameraBasis(path.at(tMid + shutterSpan / 2)), /** @type {any} */ (plane), job.width, job.height);
  const time = job.timeOffset + (frame / job.fps) * job.timeScale;
  const span = (job.shutter / job.fps) * job.timeScale;
  for (let i = 0; i < plane.particleCount; i++) {
    const key = particleKey(i, plane.seed);
    const s = u01(draw(key, 6)) - 0.5;
    const t = time + span * s;
    const h = h0.map((v, i) => v + s * (hc[i] - ho[i]));
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
  // Ribbons folds space (stretch 40 against at most 4 for the others), so the
  // same f32 rounding moves about ten times as many particles across a pixel
  // edge. A wrong formula would move most of them, not a fraction of a percent.
  const limit = (stateless?.cost.stretch ?? 0) > 10 ? 0.005 : 0.002;
  check(`CPU cross-check, ${law}`, moved < limit, `${(moved * 100).toFixed(4)}% of particles in a different pixel`);
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
  check("resume from checkpoint", saved !== null && same(whole.lo, resumed.lo) && same(whole.hi, resumed.hi) && whole.landed === resumed.landed && whole.drawn === resumed.drawn && resumed.gpuEvaluated === whole.gpuEvaluated, `resumed at plane ${saved?.cursor.plane}, offset ${saved?.cursor.offset}`);
}

// ---- trillion kernel behind the same renderer ---------------------------------
for (const kernel of ["trillion", "trillion-strata"]) {
  for (const splat of ["point", "bilinear"]) {
    const job = testJob({ splat });
    const n = job.planes.reduce((s, p) => s + p.particleCount, 0);
    const out = await renderOnce(job, { kernel });
    const sum = accumulationSum(out.lo, out.hi);
    check(`${kernel}: conservation, ${splat}`, sum === BigInt(n) * BigInt(ONE) && out.landed === BigInt(n) && out.drawn === BigInt(n) && out.gpuEvaluated === BigInt(n), `${sum / BigInt(ONE)} of ${n}, in frame ${out.landed}, drawn ${out.drawn}`);
  }
  {
    const job = testJob();
    job.camera = [{ t: 0, target: [0.4, 0.2, 0], yaw: 0.3, pitch: -0.2, distance: 1.6, fovY: 0.7 }];
    const a = await renderOnce(job, { kernel });
    const b = await renderOnce(job);
    const inGrid = accumulationSum(a.lo, a.hi) / BigInt(ONE);
    // Different hashing for shutter and splat, so compare counts, not pixels.
    const rel = Math.abs(Number(a.landed - b.landed)) / Number(b.landed);
    check(`${kernel}: in-frame count matches offline kernel`, a.landed === inGrid && rel < 0.01, `${a.landed} vs ${b.landed} (${(rel * 100).toFixed(3)}%)`);
  }
  {
    // A src/stateless law through both kernels: same in-frame count.
    const job = testJob();
    job.planes = [{ ...job.planes[0], law: "galaxy", params: [...STATELESS_LAWS.find((l) => l.id === "galaxy").defaults] }];
    const a = await renderOnce(job, { kernel });
    const b = await renderOnce(job);
    const rel = Math.abs(Number(a.landed - b.landed)) / Math.max(1, Number(b.landed));
    check(`${kernel}: stateless law (galaxy) matches offline`, b.landed > 0n && rel < 0.01, `${a.landed} vs ${b.landed}`);
  }
  {
    const job = testJob({ splat: "bilinear" });
    const x = await renderOnce(job, { kernel, initialBatch: 50_000, maxBatch: 50_000 });
    const y = await renderOnce(job, { kernel, initialBatch: 2 ** 20 });
    check(`${kernel}: batch invariance`, same(x.lo, y.lo) && same(x.hi, y.hi), `${x.batches} vs ${y.batches} batches`);
    /** @type {any} */
    let saved = null;
    const controller = new AbortController();
    let batches = 0;
    try {
      await renderOnce(job, { kernel, initialBatch: 50_000, maxBatch: 50_000 }, 1, {
        signal: controller.signal,
        checkpoint: { everyMs: 1e9, save: async (cursor, acc) => void (saved = { cursor, ...acc }) },
        onProgress: () => {
          if (++batches === 7) controller.abort();
        },
      });
    } catch (e) {
      if (/** @type {Error} */ (e).name !== "AbortError") throw e;
    }
    const resumed = saved ? await renderOnce(job, { kernel, initialBatch: 50_000, maxBatch: 50_000 }, 1, { resume: saved }) : null;
    check(`${kernel}: cancel and resume exactly`, resumed !== null && same(x.lo, resumed.lo) && same(x.hi, resumed.hi) && resumed.landed === x.landed, saved ? `saved after ${saved.gpuEvaluated}` : "nothing saved");
  }
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
