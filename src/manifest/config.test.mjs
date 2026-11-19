// Run with: npm test -- config
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { totalParticles } from "../offline/core/job.ts";
import { expandJob, validateConfig } from "./config.ts";
import { pickFrames } from "./node/reproduce.mjs";

// npm test runs from the repository root, and the test is bundled elsewhere, so read from the working directory.
const load = (name) => validateConfig(JSON.parse(readFileSync(path.join(process.cwd(), "proof", name), "utf8")));

test("the committed trillion record config builds the claimed job", () => {
  const config = load("trillion-4k.json");
  const job = expandJob(config);
  assert.equal(totalParticles(job), 1_000_000_000_000);
  assert.equal(job.planes.length, 1024);
  assert.equal(new Set(job.planes.map((p) => p.seed)).size, 1024);
  assert.deepEqual([job.width, job.height, job.fps, job.frames], [3840, 2160, 60, 600]);
  assert.deepEqual([job.weighting, job.splat], ["count", "point"]);
  assert.deepEqual(job.camera, config.camera);
  assert.equal(job.name, "record-1T-3840x2160-600f");
});

test("the smoke config builds a small job of the same kind", () => {
  const job = expandJob(load("smoke.json"));
  assert.equal(totalParticles(job), 4_000_000);
  assert.deepEqual([job.weighting, job.splat], ["count", "point"]);
});

test("validateConfig says what is wrong", () => {
  const good = load("smoke.json");
  const bad = (patch) => () => validateConfig({ ...structuredClone(good), ...patch });
  assert.throws(bad({ format: "x" }), /format/);
  assert.throws(bad({ title: "" }), /title/);
  assert.throws(bad({ world: { ...good.world, weighting: "loud" } }), /weighting/);
  assert.throws(bad({ world: { ...good.world, particles: 1.5 } }), /particles/);
  assert.throws(bad({ camera: [{ t: 0, target: [0, 0], yaw: 0, pitch: 0, distance: 1, fovY: 1 }] }), /camera\[0\]/);
});

test("pickFrames: named frames and ranges, random picks, repeatable with a seed", () => {
  const available = Array.from({ length: 600 }, (_, i) => i);
  assert.deepEqual(pickFrames(available, { at: "5,0,10:13" }).picks, [0, 5, 10, 11, 12]);
  assert.throws(() => pickFrames([0, 1], { at: "7" }), /not in the manifest/);
  const random = pickFrames(available, { frames: 4 }).picks;
  assert.equal(new Set(random).size, 4);
  assert.ok(random.every((f) => f >= 0 && f < 600));
  assert.deepEqual(pickFrames(available, { frames: 3, seed: 42 }).picks, pickFrames(available, { frames: 3, seed: 42 }).picks);
  assert.equal(pickFrames([1, 2], { frames: 5 }).picks.length, 2);
  assert.deepEqual(pickFrames(available, { frames: 0 }).picks, []);
});
