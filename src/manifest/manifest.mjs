// @ts-check
/**
 * Render manifest: one JSON file per render that says exactly what the GPU
 * did, so anyone can check or reproduce a frame. Plain JavaScript with no
 * imports, so the app (browser), the Node CLI and plain `node` all share it.
 *
 * Honesty rules (docs/briefs/honest-counting.md):
 *   - Per-frame `evaluated` and `landed` are copied from the frame stats the
 *     GPU wrote (src/offline/core/develop.ts FrameStats). Nothing here is
 *     derived from the job's configured count.
 *   - `particlesPerFrame` (the job) is kept separate, and `allEvaluated`
 *     is true only when the GPU tally equals it exactly.
 *   - These frames are RENDERED (stateless, closed-form motion), never
 *     "simulated". `mode` says so in the file itself.
 *
 * Types: manifest.d.mts.
 */

export const MANIFEST_KIND = "strata-render-manifest";
export const MANIFEST_VERSION = 1;

const WORDING =
  "Rendered, not simulated: every particle's position is a closed-form function of its 64-bit key and time. " +
  "Nothing is stored per particle between frames. evaluated = particles the GPU ran through the kernel this frame; " +
  "landed = those whose position fell inside the picture. Under count weighting each landed particle adds exactly one unit " +
  "of light (checked per frame: unitSum = landed x 65536 for point splats). Under flux weighting a far particle's weight is " +
  "randomly rounded and often 0, so it is landed but drawn only in expectation.";

/** Units of light one particle adds under count weighting (src/offline/core/job.ts ONE). */
const ONE = 65536n;

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} s */
export const sha256OfText = (s) => sha256Hex(new TextEncoder().encode(s));

/** @param {Uint8Array} bytes */
export const sha256OfBytes = (bytes) => sha256Hex(bytes);

/**
 * The fields of a frame's stats that depend only on the integer grid, so two
 * renders of the same job on any GPU must match them exactly (integer adds
 * commute). Wall time and batch count are left out on purpose.
 * @param {import("./manifest.d.mts").FrameStatsLike} s
 */
export function gridFields(s) {
  return {
    evaluated: String(s.evaluated),
    landed: String(s.landed),
    unitSum: String(s.unitSum),
    litPixels: s.litPixels,
    maxCode: s.maxCode,
    hist: s.hist,
  };
}

/**
 * Hash of the grid-determined stats. Equal hashes mean the same exact grid
 * sum, landed count, lit pixels and histogram.
 * @param {import("./manifest.d.mts").FrameStatsLike} s
 */
export const gridHash = (s) => sha256OfText(JSON.stringify(gridFields(s)));

/** @param {import("./manifest.d.mts").JobLike} job */
export function totalParticles(job) {
  let n = 0;
  for (const p of job.planes) n += p.particleCount;
  return n;
}

/**
 * Build the manifest. Pure apart from hashing; the caller supplies
 * everything it knows (commit, adapter, look) and leaves the rest out.
 * @param {import("./manifest.d.mts").ManifestInput} input
 * @returns {Promise<import("./manifest.d.mts").RenderManifest>}
 */
export async function buildManifest(input) {
  const { job } = input;
  const particles = totalParticles(job);
  const stats = [...input.stats].sort((a, b) => a.frame - b.frame);
  const frames = [];
  let seconds = 0;
  let evaluatedTotal = 0n;
  for (const s of stats) {
    const evaluated = BigInt(s.evaluated);
    evaluatedTotal += evaluated;
    seconds += s.seconds;
    frames.push({
      frame: s.frame,
      evaluated: String(s.evaluated),
      landed: String(s.landed),
      outside: (evaluated - BigInt(s.landed)).toString(),
      unitSum: String(s.unitSum),
      litPixels: s.litPixels,
      maxCode: s.maxCode,
      allEvaluated: evaluated === BigInt(particles),
      // Exactly one unit per landed particle: provable only for count + point.
      eachLandedAddedOnce:
        job.weighting === "count" && job.splat === "point" ? BigInt(s.unitSum) === BigInt(s.landed) * ONE : null,
      // Light in the grid, in particles: exact for count, the expected total for flux.
      lightParticles: (Number(BigInt(s.unitSum) / (ONE / 256n)) / 256).toString(),
      seconds: s.seconds,
      batches: s.batches,
      particlesPerSecond: Number(evaluated) / Math.max(s.seconds, 1e-9),
      gridHash: await gridHash(s),
      imageSha256: input.imageSha256?.[s.frame] ?? null,
    });
  }
  const jobJson = JSON.stringify(job);
  return {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    mode: "rendered-stateless",
    wording: WORDING,
    created: new Date().toISOString(),
    started: input.started ?? null,
    finished: input.finished ?? null,
    source: {
      repo: "https://github.com/Aptyll/Strata",
      commit: input.commit ?? null,
      renderer: input.renderer ?? "src/offline StatelessRenderer",
      entry: input.entry ?? null,
    },
    gpu: input.gpu ?? null,
    host: input.host ?? null,
    job: {
      name: job.name,
      sha256: await sha256OfText(jobJson),
      fingerprint: input.jobFingerprint ?? null,
      width: job.width,
      height: job.height,
      fps: job.fps,
      frames: job.frames,
      ssaa: job.ssaa,
      splat: job.splat,
      weighting: job.weighting,
      planes: job.planes.length,
      seeds: summarizeSeeds(job),
      camera: job.camera,
    },
    particlesPerFrame: particles,
    drawing: {
      weighting: job.weighting,
      splat: job.splat,
      exact: job.weighting === "count",
      meaning:
        job.weighting === "count"
          ? "count: every particle in frame adds exactly one unit of light"
          : "flux: weights randomly rounded (unbiased); far particles are drawn on average, many add nothing",
    },
    grade: input.look ?? null,
    totals: {
      framesComplete: frames.length,
      allEvaluated: frames.length > 0 && frames.every((f) => f.allEvaluated),
      evaluated: evaluatedTotal.toString(),
      eachLandedAddedOnce: frames.every((f) => f.eachLandedAddedOnce === true) && frames.length > 0 ? true : frames.some((f) => f.eachLandedAddedOnce === false) ? false : null,
      gpuSeconds: seconds,
      particlesPerSecond: Number(evaluatedTotal) / Math.max(seconds, 1e-9),
    },
    frames,
    fullJob: input.includeJob === false ? null : job,
  };
}

/** @param {import("./manifest.d.mts").JobLike} job */
function summarizeSeeds(job) {
  const seeds = job.planes.map((p) => p.seed);
  const unique = new Set(seeds).size;
  return { first: seeds[0] ?? null, last: seeds[seeds.length - 1] ?? null, count: seeds.length, unique };
}

/**
 * Compare a reproduction against a reference, frame by frame, on the
 * grid-determined fields only. Frames missing from either side are listed,
 * not failed, so a short clip can check part of a long render.
 * @param {import("./manifest.d.mts").RenderManifest} reference
 * @param {import("./manifest.d.mts").RenderManifest} candidate
 */
export function compareManifests(reference, candidate) {
  /** @type {string[]} */
  const problems = [];
  if (reference.job.sha256 !== candidate.job.sha256) problems.push(`job differs (${reference.job.sha256.slice(0, 12)} vs ${candidate.job.sha256.slice(0, 12)})`);
  const byFrame = new Map(reference.frames.map((f) => [f.frame, f]));
  let checked = 0;
  /** @type {number[]} */
  const missing = [];
  for (const c of candidate.frames) {
    const r = byFrame.get(c.frame);
    if (!r) {
      missing.push(c.frame);
      continue;
    }
    checked++;
    for (const k of /** @type {const} */ (["evaluated", "landed", "unitSum", "litPixels", "maxCode", "gridHash"])) {
      if (r[k] !== c[k]) problems.push(`frame ${c.frame}: ${k} ${r[k]} vs ${c[k]}`);
    }
    if (!c.allEvaluated) problems.push(`frame ${c.frame}: not every particle was evaluated`);
  }
  if (checked === 0) problems.push("no frame in common");
  return { ok: problems.length === 0, checked, missing, problems };
}
