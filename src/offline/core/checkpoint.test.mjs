/**
 * A checkpoint continues a frame only on the kernel that saved it. Kernels
 * differ in each particle's sample, in what they tally and, for flux, in grid
 * units, so a frame continued on another kernel would add two different
 * pictures together. Runs under `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packPartial, unpackPartial } from "./session";

// A checkpoint only reads the grid size and the job's fingerprint.
const job = { width: 4, height: 2, ssaa: 1, frames: 1, note: "checkpoint test" };
const cells = 8;
const acc = {
  lo: Uint32Array.from({ length: cells }, (_, i) => i * 3 + 1),
  hi: Uint32Array.from({ length: cells }, (_, i) => i & 1),
  landed: 5_000_000_123n,
  gpuEvaluated: 9_000_000_456n,
  drawn: 4_999_999_999n,
};
const progress = { seconds: 12.345, batches: 7, resumes: 1 };
const cursor = { plane: 2, offset: 123_456 };

test("checkpoint: continues on the kernel that saved it, every count intact", () => {
  for (const kernel of ["offline", "trillion", "trillion-strata"]) {
    const back = unpackPartial(job, 3, packPartial(job, 3, cursor, acc, progress, kernel), kernel);
    assert.ok(back, kernel);
    assert.deepEqual(back.cursor, cursor);
    assert.deepEqual([...back.lo], [...acc.lo]);
    assert.deepEqual([...back.hi], [...acc.hi]);
    assert.equal(back.landed, acc.landed);
    assert.equal(back.gpuEvaluated, acc.gpuEvaluated);
    assert.equal(back.drawn, acc.drawn);
    assert.equal(back.seconds, progress.seconds);
    assert.equal(back.batches, progress.batches);
    assert.equal(back.resumes, progress.resumes);
  }
});

test("checkpoint: refused by another kernel, frame or job", () => {
  const file = packPartial(job, 3, cursor, acc, progress, "trillion");
  assert.equal(unpackPartial(job, 3, file, "offline"), null);
  assert.equal(unpackPartial(job, 3, file, "trillion-strata"), null);
  assert.equal(unpackPartial(job, 4, file, "trillion"), null);
  assert.equal(unpackPartial({ ...job, note: "another job" }, 3, file, "trillion"), null);
});

test("checkpoint: a version 5 file, which has no kernel word, starts the frame over", () => {
  const v6 = new Uint32Array(packPartial(job, 3, cursor, acc, progress, "offline").buffer);
  // Version 5 had the same first 15 header words and nothing after them.
  const v5 = new Uint32Array(v6.length - 1);
  v5.set(v6.subarray(0, 15));
  v5.set(v6.subarray(16), 15);
  assert.equal(unpackPartial(job, 3, new Uint8Array(v5.buffer), "offline"), null);
});
