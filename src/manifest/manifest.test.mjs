// Run with: npm test -- manifest
import test from "node:test";
import assert from "node:assert/strict";
import { SAME_PICTURE, buildManifest, checkManifest, compareFrame, compareManifests, signatureDistance } from "./manifest.mjs";

const ONE = 65536n;
const job = {
  version: 1,
  name: "test-job",
  width: 64,
  height: 36,
  fps: 30,
  frames: 3,
  ssaa: 1,
  splat: "point",
  weighting: "count",
  planes: [
    { seed: 11, particleCount: 600 },
    { seed: 12, particleCount: 400 },
  ],
  camera: [{ t: 0 }],
};

/** Frame stats as renderJob writes them; landed particles add exactly ONE each. */
function stats(frame, landed, extra = {}) {
  return {
    frame,
    evaluated: "1000",
    evaluatedBy: "gpu",
    unitSum: String(BigInt(landed) * ONE),
    landed: String(landed),
    litPixels: 300 + frame,
    maxCode: 4000,
    hist: [1, 2, 3],
    seconds: 0.5,
    batches: 2,
    gridSha256: `${"ab".repeat(31)}${String(frame).padStart(2, "0")}`,
    signature: Array.from({ length: 144 }, (_, i) => (i % 7) * 300 + frame),
    ...extra,
  };
}

const build = (list, extra = {}) => buildManifest({ job, stats: list, commit: "abc123", ...extra });

test("signature distance: 0 for equal tiles, small for a small change, 1 for a mismatch in shape", () => {
  const a = [0, 256, 512, 768];
  assert.equal(signatureDistance(a, a), 0);
  const b = [0, 256, 512, 770]; // one tile 2/256 of a stop brighter
  const d = signatureDistance(a, b);
  assert.ok(d > 0 && d < 0.01, `distance ${d}`);
  assert.equal(signatureDistance(a, [0, 256]), 1);
  assert.equal(signatureDistance([0, 0], [0, 0]), 0);
});

test("buildManifest copies the fingerprints, who counted, and the video", async () => {
  const video = { file: "clip.mp4", bytes: 123, sha256: "f".repeat(64) };
  const m = await build([stats(0, 900), stats(1, 800)], { video });
  assert.equal(m.frames[0].gridSha256, stats(0, 900).gridSha256);
  assert.deepEqual(m.frames[1].signature, stats(1, 800).signature);
  assert.equal(m.frames[0].evaluatedBy, "gpu");
  assert.equal(m.totals.countedOnGpu, true);
  assert.equal(m.totals.eachLandedAddedOnce, true);
  assert.deepEqual(m.video, video);

  const host = await build([stats(0, 900), stats(1, 800, { evaluatedBy: "host" })]);
  assert.equal(host.totals.countedOnGpu, false);
  const old = await build([stats(0, 900, { evaluatedBy: undefined, gridSha256: undefined, signature: undefined })]);
  assert.equal(old.totals.countedOnGpu, null);
  assert.equal(old.frames[0].gridSha256, null);
  assert.equal(old.frames[0].signature, null);
  assert.equal(old.video, null);
});

test("compareFrame: the same exact grid is identical", async () => {
  const [r] = (await build([stats(0, 900)])).frames;
  const [c] = (await build([stats(0, 900)])).frames;
  assert.equal(compareFrame(r, c).verdict, "identical");
});

test("compareFrame: another GPU's grid with nearly the same tiles is the same picture", async () => {
  const [r] = (await build([stats(0, 900_000)])).frames;
  const moved = stats(0, 899_990, { gridSha256: "cd".repeat(32), litPixels: 301 });
  moved.signature = moved.signature.map((v, i) => (i === 5 ? v + 1 : v));
  const [c] = (await build([moved])).frames;
  const v = compareFrame(r, c);
  assert.equal(v.verdict, "same picture", v.reasons.join("; "));
  assert.ok(v.signatureDistance > 0 && v.signatureDistance <= SAME_PICTURE.signature);
  assert.ok(v.landedDifference > 0 && v.landedDifference <= SAME_PICTURE.landed);
});

test("compareFrame: a different picture, a short count, an edited file, or no signature is different", async () => {
  const [r] = (await build([stats(0, 900)])).frames;
  const other = stats(0, 900, { gridSha256: "cd".repeat(32) });
  other.signature = other.signature.map((v) => v + 200);
  assert.equal(compareFrame(r, (await build([other])).frames[0]).verdict, "different");

  const short = (await build([stats(0, 900, { evaluated: "999" })])).frames[0];
  assert.equal(compareFrame(r, short).verdict, "different");

  // Same grid hash, other counts: one of the files was edited.
  const edited = (await build([stats(0, 901, { gridSha256: stats(0, 900).gridSha256 })])).frames[0];
  const ve = compareFrame(r, edited);
  assert.equal(ve.verdict, "different");
  assert.match(ve.reasons.join(" "), /edited/);

  const unsigned = (await build([stats(0, 900, { gridSha256: "cd".repeat(32), signature: undefined })])).frames[0];
  assert.equal(compareFrame(r, unsigned).verdict, "different");
});

test("compareManifests: counts verdicts, lists frames the reference lacks, fails on another job", async () => {
  const ref = await build([stats(0, 900), stats(1, 800)]);
  const moved = stats(1, 799, { gridSha256: "cd".repeat(32) });
  const cand = await build([stats(0, 900), moved, stats(2, 700)]);
  const r = compareManifests(ref, cand);
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.equal(r.identical, 1);
  assert.equal(r.samePicture, 1);
  assert.deepEqual(r.missing, [2]);

  const otherJob = await buildManifest({ job: { ...job, name: "other" }, stats: [stats(0, 900)] });
  assert.equal(compareManifests(ref, otherJob).ok, false);
});

test("checkManifest passes a consistent manifest and catches edits", async () => {
  const good = await build([stats(0, 900), stats(1, 800), stats(2, 700)]);
  const checks = await checkManifest(good);
  const failed = checks.filter((c) => c.ok === false);
  assert.deepEqual(failed, []);
  assert.equal(checks.find((c) => c.id === "complete").ok, true);

  const failing = async (m) => (await checkManifest(m)).filter((c) => c.ok === false).map((c) => c.id);

  const landed = structuredClone(good);
  landed.frames[1].landed = "801"; // grid sum no longer landed x 65536
  assert.deepEqual(await failing(landed), ["one unit per landed particle"]);

  const host = await build([stats(0, 900), stats(1, 800, { evaluatedBy: "host" }), stats(2, 700)]);
  assert.deepEqual(await failing(host), ["counted on the GPU"]);

  const jobEdit = structuredClone(good);
  jobEdit.fullJob.planes[0].particleCount = 601;
  assert.ok((await failing(jobEdit)).includes("job hash"));

  const dup = structuredClone(good);
  dup.frames[2].frame = 1;
  assert.ok((await failing(dup)).includes("frame numbers"));

  const totals = structuredClone(good);
  totals.totals.evaluated = "1";
  assert.deepEqual(await failing(totals), ["totals"]);
});
