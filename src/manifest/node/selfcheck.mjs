// @ts-check
/**
 * GPU self-checks, run by `npm run record -- verify` on the device that
 * re-renders, before any frame (and alone by `npm run record -- selfcheck`).
 * A second or two on a real GPU. They show that this device, driver and Dawn
 * build compute what the manifest's evidence relies on:
 *
 *   gpu count           the GPU's evaluated tally equals the particles in the
 *                       job, with odd batch sizes and odd work per invocation
 *   grid matches tally  the grid sum is exactly (in-frame count) x 65536 under
 *                       count weighting with point splats
 *   batch invariance    one batch per sheet and thousands of small batches give
 *                       a bit-identical grid
 *   resume              a frame stopped after its first batch and resumed from
 *                       the checkpoint ends bit-identical, with the same counts
 *   no GPU errors       the device reported no validation or out-of-memory errors
 *
 * Runs under tsx: it imports the TypeScript renderer directly.
 */
import { gridSha256 } from "../../offline/core/fingerprint";
import { ONE, totalParticles } from "../../offline/core/job";
import { StatelessRenderer, accumulationSum } from "../../offline/core/renderer";

const PARAMS = {
  kepler: [0.3, 3.2, 0.03, 1.1, 0.03, 0.22, 0.03, 0],
  vortex: [12, 0.6, 0.3, 0.25, 0.7, 0, 0, 0],
  lissajous: [3, 2, 6, 0.03, 0.2, 0.3, 0.2, 0.92],
};

/**
 * Three tilted sheets, one per law, all comfortably in view. Counts are odd so
 * batch and invocation tails are exercised.
 * @returns {import("../../offline/core/job").OfflineJob}
 */
export function selfCheckJob() {
  const laws = /** @type {const} */ (["kepler", "vortex", "lissajous"]);
  return {
    version: 1,
    name: "record-selfcheck",
    width: 320,
    height: 180,
    fps: 30,
    frames: 2,
    timeScale: 1,
    timeOffset: 40,
    ssaa: 1,
    splat: "point",
    weighting: "count",
    fluxRef: 1,
    shutter: 0.5,
    near: 0.01,
    planes: laws.map((law, i) => ({
      position: [(i - 1) * 1.6, 0.1 * i, -0.3 * i],
      rotation: [0.2 * i, 0.1, 0.05 * i, Math.sqrt(1 - 0.04 * i * i - 0.01 - 0.0025 * i * i)],
      halfSize: [0.7, 0.7],
      law,
      seed: 7001 + i,
      particleCount: 200_003 + i * 49_999,
      params: PARAMS[law],
    })),
    camera: [{ t: 0, target: [0, 0, 0], yaw: 0.1, pitch: -0.1, distance: 9, fovY: 0.7 }],
  };
}

/** @param {{ lo: Uint32Array, hi: Uint32Array }} a @param {{ lo: Uint32Array, hi: Uint32Array }} b */
function sameGrid(a, b) {
  if (a.lo.length !== b.lo.length) return false;
  for (let i = 0; i < a.lo.length; i++) if (a.lo[i] !== b.lo[i] || a.hi[i] !== b.hi[i]) return false;
  return true;
}

/**
 * @param {GPUDevice} device
 * @param {string[]} gpuErrors uncaptured errors seen on the device so far
 * @returns {Promise<{ id: string, ok: boolean, detail: string }[]>}
 */
export async function selfChecks(device, gpuErrors) {
  const job = selfCheckJob();
  const total = BigInt(totalParticles(job));
  const errorsBefore = gpuErrors.length;
  /** @type {{ id: string, ok: boolean, detail: string }[]} */
  const checks = [];
  /** @param {string} id @param {boolean} ok @param {string} detail */
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  /** @param {{ lo: Uint32Array, hi: Uint32Array }} r */
  const hash = async (r) => ((await gridSha256(r.lo, r.hi, job.width, job.height)) ?? "no WebCrypto").slice(0, 16);

  /** @param {import("../../offline/core/renderer").RendererOptions} opts @param {import("../../offline/core/renderer").FrameHooks} hooks */
  async function render(opts, hooks = {}) {
    const r = await StatelessRenderer.create(device, job, opts);
    try {
      return await r.renderFrame(1, hooks);
    } finally {
      r.dispose();
    }
  }

  const small = await render({ perInvocation: 7, initialBatch: 40_009, maxBatch: 40_009 });
  const big = await render({ perInvocation: 64, initialBatch: 2 ** 30, maxBatch: 2 ** 30 });

  // Stop after the first batch by failing the first checkpoint save, then resume from what it saved.
  /** @type {any} */
  let saved = null;
  try {
    await render(
      { perInvocation: 13, initialBatch: 100_003, maxBatch: 100_003 },
      {
        checkpoint: {
          everyMs: 0,
          save: async (cursor, acc) => {
            saved = { cursor, ...acc };
            throw new Error("selfcheck-stop");
          },
        },
      },
    );
  } catch (e) {
    if (/** @type {Error} */ (e).message !== "selfcheck-stop") throw e;
  }
  const resumed = saved ? await render({ perInvocation: 13, initialBatch: 100_003, maxBatch: 100_003 }, { resume: saved }) : null;

  const counts = [small, big, resumed].map((r) => r?.gpuEvaluated ?? -1n);
  add("gpu count", counts.every((c) => c === total), `the GPU counted ${counts.join(", ")} for ${total} particles (small batches, one batch per sheet, resumed)`);

  const sum = accumulationSum(small.lo, small.hi);
  add(
    "grid matches tally",
    sum === small.landed * BigInt(ONE) && small.landed * 100n >= total * 99n,
    `grid sum ${sum} = ${small.landed} in frame x ${ONE}; ${total - small.landed} particles outside`,
  );

  const invariant = sameGrid(small, big);
  add("batch invariance", invariant, invariant ? `grid ${await hash(big)} either way` : `grids differ: ${await hash(small)} vs ${await hash(big)}`);

  const resumedOk = resumed !== null && sameGrid(resumed, big) && resumed.landed === big.landed;
  add(
    "resume",
    resumedOk,
    resumed === null ? "no checkpoint was taken" : `stopped at sheet ${saved.cursor.plane}, particle ${saved.cursor.offset}; resumed to grid ${await hash(resumed)}`,
  );

  const fresh = gpuErrors.slice(errorsBefore);
  add("no GPU errors", fresh.length === 0, fresh.length === 0 ? "none reported" : fresh[0]);
  return checks;
}
