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
 *     is true only when the GPU tally equals it exactly. `evaluatedBy` says
 *     who counted: "gpu" (every kernel now) or "host" (trillion-kernel stats
 *     from before it had a GPU tally summed dispatch sizes, which proves
 *     coverage, not work).
 *   - These frames are RENDERED (stateless, closed-form motion), never
 *     "simulated". `mode` says so in the file itself.
 *
 * Checking a render (docs/proof/reproduce.md):
 *   - checkManifest: the file on its own, no GPU.
 *   - compareManifests: a re-render against the published frames. Each frame
 *     is "identical" (same exact grid, gridSha256), "same picture" (same GPU
 *     count, tile brightness and in-frame count within SAME_PICTURE: what
 *     another GPU model gives, since f32 sin, cos, log and pow differ slightly
 *     between vendors) or "different".
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
 * The fields of a frame's stats that depend only on the integer grid. Integer
 * adds commute, so two renders of the same job match them exactly however the
 * work was batched, on the same GPU model, driver and browser or Dawn build.
 * Another GPU model computes f32 sin, cos, log and pow slightly differently,
 * so a few particles land one pixel over and landed, litPixels and the
 * histogram move a little: compare those renders with compareManifests, which
 * allows for it. Wall time and batch count are left out on purpose.
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
 * sum, landed count, lit pixels and histogram. Weaker than gridSha256, which
 * commits to every pixel; kept because stats written before gridSha256
 * existed have only this.
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
      // Stats written before `resumes` existed timed only a continued frame's last run.
      resumes: s.resumes ?? null,
      particlesPerSecond: Number(evaluated) / Math.max(s.seconds, 1e-9),
      gridHash: await gridHash(s),
      // Exact grid commitment and 16 x 9 tile brightness (src/offline/core/fingerprint.ts).
      gridSha256: s.gridSha256 ?? null,
      signature: s.signature ?? null,
      // Who counted evaluated. Stats written before the field existed came from the GPU-counting kernel.
      evaluatedBy: s.evaluatedBy ?? null,
      // Which kernel rendered it, so a re-render can use the same one.
      kernel: s.kernel ?? null,
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
      // true: the GPU counted every frame. false: some frame was counted by the host. null: not recorded.
      countedOnGpu: frames.length > 0 && frames.every((f) => f.evaluatedBy === "gpu") ? true : frames.some((f) => f.evaluatedBy === "host") ? false : null,
      gpuSeconds: seconds,
      particlesPerSecond: Number(evaluatedTotal) / Math.max(seconds, 1e-9),
    },
    frames,
    video: input.video ?? null,
    fullJob: input.includeJob === false ? null : job,
  };
}

/** @param {import("./manifest.d.mts").JobLike} job */
function summarizeSeeds(job) {
  const seeds = job.planes.map((p) => p.seed);
  const unique = new Set(seeds).size;
  return { first: seeds[0] ?? null, last: seeds[seeds.length - 1] ?? null, count: seeds.length, unique };
}


// ------------------------------------------------------------- checking ----

/** Signature codes per stop. Must match SIG_SCALE in src/offline/core/fingerprint.ts. */
const SIG_SCALE = 256;

/**
 * How close a re-render on another GPU model must come to count as the same
 * picture. First guesses, not yet measured across real GPUs: a different
 * frame or a different world lands far outside them, and the one-pixel moves
 * between GPU vendors should stay well inside.
 *   signature  relative L1 distance of the 16 x 9 tile brightness
 *   landed     relative difference of the in-frame count
 */
export const SAME_PICTURE = Object.freeze({ signature: 0.02, landed: 0.005 });

/**
 * Distance between two tile signatures: the summed absolute difference of
 * tile light over the larger total. 0 is identical; 0.01 means 1% of the light
 * sits in other tiles or at another brightness.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 */
export function signatureDistance(a, b) {
  if (a.length !== b.length || a.length === 0) return 1;
  let diff = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    const va = 2 ** (a[i] / SIG_SCALE) - 1;
    const vb = 2 ** (b[i] / SIG_SCALE) - 1;
    diff += Math.abs(va - vb);
    sa += va;
    sb += vb;
  }
  const total = Math.max(sa, sb);
  return total > 0 ? diff / total : 0;
}

/** |a - b| / max(a, b) of two decimal strings; 0 when both are 0. @param {string} a @param {string} b */
function relativeDifference(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  const larger = x > y ? x : y;
  return larger === 0n ? 0 : Number(x > y ? x - y : y - x) / Number(larger);
}

/** @param {number} x */
const pct = (x) => `${(100 * x).toFixed(3)}%`;
/** @param {string | null | undefined} h */
const short = (h) => (h ? h.slice(0, 12) : "none");
/** "frame 4" or "frames 4, 9 and 12 more". @param {number[]} xs */
const framesList = (xs) => `${xs.length === 1 ? "frame" : "frames"} ${xs.length > 10 ? `${xs.slice(0, 10).join(", ")} and ${xs.length - 10} more` : xs.join(", ")}`;

/** @param {import("./manifest.d.mts").GpuInfo} g */
export const gpuName = (g) => [g.vendor, g.architecture, g.device, g.description, g.name].filter(Boolean).join(" ") || "unknown GPU";

/** Stats that a frame's exact grid fixes. */
const GRID_STATS = /** @type {const} */ (["evaluated", "landed", "unitSum", "litPixels", "maxCode", "gridHash"]);

/**
 * Verdict for one frame of a re-render (c) against the published frame (r):
 *   identical     the same exact grid: equal gridSha256 (or, for frames
 *                 without one, equal grid-determined stats) and equal counts.
 *                 Expected on the same GPU model, driver and browser or Dawn
 *                 build, from the same commit.
 *   same picture  the same GPU count of evaluated particles, and tile
 *                 brightness and in-frame count within SAME_PICTURE. Expected
 *                 on another GPU model.
 *   different     anything else.
 * @param {import("./manifest.d.mts").ManifestFrame} r
 * @param {import("./manifest.d.mts").ManifestFrame} c
 * @returns {import("./manifest.d.mts").FrameVerdict}
 */
export function compareFrame(r, c) {
  /** @type {string[]} */
  const reasons = [];
  if (r.evaluated !== c.evaluated) reasons.push(`evaluated ${r.evaluated} published, ${c.evaluated} here`);
  if (!c.allEvaluated) reasons.push("this render did not evaluate every particle");
  const statsEqual = GRID_STATS.every((k) => r[k] === c[k]);
  const sameGrid = r.gridSha256 && c.gridSha256 ? r.gridSha256 === c.gridSha256 : statsEqual;
  const landedDifference = relativeDifference(r.landed, c.landed);
  const distance = Array.isArray(r.signature) && Array.isArray(c.signature) ? signatureDistance(r.signature, c.signature) : null;
  /** @type {import("./manifest.d.mts").FrameVerdict["verdict"]} */
  let verdict = "different";
  if (reasons.length) verdict = "different";
  else if (sameGrid && statsEqual) verdict = "identical";
  else if (sameGrid) reasons.push("same grid hash but different counts, so one of the two files was edited");
  else if (distance !== null && distance <= SAME_PICTURE.signature && landedDifference <= SAME_PICTURE.landed) verdict = "same picture";
  else if (distance === null) reasons.push(`the grids differ (${short(r.gridSha256)} vs ${short(c.gridSha256)}) and a signature is missing, so the pictures cannot be compared`);
  else
    reasons.push(
      `tile brightness differs by ${pct(distance)} (limit ${pct(SAME_PICTURE.signature)}), ` +
        `the in-frame count by ${pct(landedDifference)} (limit ${pct(SAME_PICTURE.landed)})`,
    );
  return { frame: c.frame, verdict, reasons, signatureDistance: distance, landedDifference };
}

/**
 * Compare a re-render (candidate) with the published manifest (reference),
 * frame by frame. Frames the reference lacks are listed in `missing`, not
 * failed, so a few frames can check a long render. Fails on a different job,
 * on any "different" frame, or when no frame is in common.
 * @param {import("./manifest.d.mts").RenderManifest} reference
 * @param {import("./manifest.d.mts").RenderManifest} candidate
 */
export function compareManifests(reference, candidate) {
  /** @type {string[]} */
  const problems = [];
  if (reference.job.sha256 !== candidate.job.sha256) problems.push(`job differs (${short(reference.job.sha256)} vs ${short(candidate.job.sha256)})`);
  const byFrame = new Map(reference.frames.map((f) => [f.frame, f]));
  /** @type {import("./manifest.d.mts").FrameVerdict[]} */
  const frames = [];
  /** @type {number[]} */
  const missing = [];
  for (const c of candidate.frames) {
    const r = byFrame.get(c.frame);
    if (!r) {
      missing.push(c.frame);
      continue;
    }
    const v = compareFrame(r, c);
    frames.push(v);
    if (v.verdict === "different") problems.push(`frame ${c.frame}: ${v.reasons.join("; ")}`);
  }
  if (frames.length === 0) problems.push("no frame in common");
  /** @param {string} verdict */
  const count = (verdict) => frames.filter((f) => f.verdict === verdict).length;
  return {
    ok: problems.length === 0,
    checked: frames.length,
    missing,
    problems,
    frames,
    identical: count("identical"),
    samePicture: count("same picture"),
    different: count("different"),
  };
}

/**
 * Check a manifest on its own, with no GPU: the embedded job hashes to the
 * recorded value, every frame's count is the whole world and was counted on
 * the GPU, count-weighted point frames added exactly one unit per landed
 * particle, the totals add up, and which evidence and provenance it carries.
 * ok: true passes, false fails, null is a note that fails nothing.
 * @param {import("./manifest.d.mts").RenderManifest} m
 * @returns {Promise<import("./manifest.d.mts").ManifestCheck[]>}
 */
export async function checkManifest(m) {
  /** @type {import("./manifest.d.mts").ManifestCheck[]} */
  const checks = [];
  /** @param {string} id @param {boolean | null} ok @param {string} detail */
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  add("format", m.kind === MANIFEST_KIND && m.version === MANIFEST_VERSION, `${m.kind} version ${m.version}`);

  if (m.fullJob) {
    const sha = await sha256OfText(JSON.stringify(m.fullJob));
    add("job hash", sha === m.job.sha256, sha === m.job.sha256 ? `the embedded job hashes to ${short(sha)}` : `the embedded job hashes to ${short(sha)}, the manifest says ${short(m.job.sha256)}`);
    const total = totalParticles(m.fullJob);
    add("particles per frame", total === m.particlesPerFrame, `${total} in the embedded job, ${m.particlesPerFrame} claimed`);
  } else add("job hash", null, "no embedded job, so frames cannot be re-rendered from this file alone");

  const frames = m.frames;
  const n = frames.length;
  const seen = new Set();
  /** @type {number[]} */
  const badNumbers = [];
  for (const f of frames) {
    if (seen.has(f.frame) || !(Number.isInteger(f.frame) && f.frame >= 0 && f.frame < m.job.frames)) badNumbers.push(f.frame);
    seen.add(f.frame);
  }
  add("frame numbers", n > 0 && badNumbers.length === 0, n === 0 ? "no frames" : badNumbers.length ? `duplicate or out of range: ${framesList(badNumbers)}` : `${n} distinct frames between 0 and ${m.job.frames - 1}`);
  add("complete", n === m.job.frames ? true : null, `${n} of ${m.job.frames} frames`);

  const world = BigInt(m.particlesPerFrame);
  const notAll = frames.filter((f) => BigInt(f.evaluated) !== world).map((f) => f.frame);
  add("every particle evaluated", n > 0 && notAll.length === 0, notAll.length ? `${framesList(notAll)} did not count exactly ${world}` : `every frame counted exactly ${world}`);

  const byHost = frames.filter((f) => f.evaluatedBy === "host").map((f) => f.frame);
  const unknown = frames.filter((f) => f.evaluatedBy !== "gpu" && f.evaluatedBy !== "host").length;
  add(
    "counted on the GPU",
    byHost.length ? false : unknown || n === 0 ? null : true,
    byHost.length
      ? `${framesList(byHost)} were counted by the host from dispatch sizes (trillion kernel before it had a GPU tally), which shows the dispatches covered the world but is not a GPU tally`
      : unknown
        ? `${unknown} of ${n} frames do not say who counted: the manifest was made before it copied evaluatedBy (the frame stats files may say)`
        : "every frame by the kernel's own GPU tally",
  );

  if (m.job.weighting === "count" && m.job.splat === "point") {
    const off = frames.filter((f) => BigInt(f.unitSum) !== BigInt(f.landed) * ONE).map((f) => f.frame);
    add("one unit per landed particle", n > 0 && off.length === 0, off.length ? `${framesList(off)}: the grid sum is not landed x 65536` : "the grid sum is landed x 65536 in every frame");
  } else add("one unit per landed particle", null, `not provable from the grid sum with ${m.job.weighting} weighting and ${m.job.splat} splats`);

  const sum = frames.reduce((a, f) => a + BigInt(f.evaluated), 0n);
  const t = m.totals;
  const totalsOk = t.framesComplete === n && t.evaluated === sum.toString() && t.allEvaluated === (n > 0 && notAll.length === 0);
  add("totals", totalsOk, totalsOk ? `${n} frames, ${sum} evaluations in all` : `the totals say ${t.framesComplete} frames and ${t.evaluated} evaluations; the frames add up to ${n} and ${sum}`);

  const hashed = frames.filter((f) => f.gridSha256).length;
  add("grid hashes", n > 0 && hashed === n ? true : null, hashed === n ? "every frame commits to its exact grid (gridSha256)" : `${hashed} of ${n} frames have gridSha256; the others can be compared by their stats only`);
  const signed = frames.filter((f) => Array.isArray(f.signature)).length;
  add(
    "signatures",
    n > 0 && signed === n ? true : null,
    signed === n ? "every frame has a tile signature, so another GPU model can check the picture" : `${signed} of ${n} frames have a tile signature; without one, a re-render on another GPU model cannot be told from a different picture`,
  );

  const commit = m.source?.commit ?? null;
  add("commit", commit && !commit.endsWith("-dirty") ? true : null, !commit ? "not recorded" : commit.endsWith("-dirty") ? `${commit}: rendered with local changes, so the commit alone may not reproduce it` : commit);
  const kernels = [...new Set(frames.map((f) => f.kernel ?? "not recorded"))];
  add("kernel", null, `${kernels.join(" and ")}${kernels.includes("not recorded") ? " (verify then assumes offline, or trillion where the host counted)" : ""}`);
  add("gpu", null, m.gpu ? gpuName(m.gpu) : "not recorded");
  add("video", null, m.video ? `${m.video.file}, ${m.video.bytes} bytes, sha256 ${m.video.sha256}` : "no video hash recorded");
  return checks;
}
