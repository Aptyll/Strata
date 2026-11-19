// Ramp logic against a simulated GPU: frame time = fixed overhead + cost per
// particle, so the true limit at the target is known exactly. Windows can be
// spoiled by hiccups, which only ever make a window read slower.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Ramp } from "./ramp.ts";

const ROW = 65536;
const TARGET = 30;

/**
 * A simulated device: `overheadMs` of every frame does not scale with the
 * count, `msPerMillion` does, `refresh` caps the frame rate and `maxCount`
 * (optional) is the most particles the engine can allocate.
 */

/** Noah's RTX 2070 in Challenge sim mode: 216M particles took 18.94 ms of GPU time at 47.7 fps. */
const RTX2070 = { overheadMs: 1000 / 47.7 - 18.94, msPerMillion: 18.94 / 216.27, refresh: 60 };

const trueFps = (d, count) => Math.min(d.refresh, 1000 / (d.overheadMs + (d.msPerMillion * count) / 1e6));
const limit = (d) => ((1000 / TARGET - d.overheadMs) / d.msPerMillion) * 1e6;

/** Small seeded generator, so every run of the test sees the same windows. */
const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/**
 * Runs the ramp to "hold". `measure` turns the true rate into a window's
 * reading; `spoil` (optional) marks a window at a count as a hiccup that reads
 * 20 fps.
 */
function run(d, measure, start = 1_000_000, spoil = undefined) {
  const ramp = new Ramp({ targetFps: TARGET, start, quantum: ROW });
  let windows = 0;
  while (ramp.phase !== "hold") {
    assert.ok(windows < 400, `ramp did not settle (phase ${ramp.phase} at ${ramp.count})`);
    const applied = Math.min(ramp.count, d.maxCount ?? Infinity);
    const fps = spoil?.(applied) ? 20 : measure(trueFps(d, applied), windows);
    windows++;
    ramp.report(fps, applied, applied >= (d.maxCount ?? Infinity));
  }
  return { ramp, windows };
}

test("without noise the record lands within the tolerance below the limit", () => {
  const { ramp } = run(RTX2070, (fps) => fps);
  const L = limit(RTX2070);
  assert.ok(ramp.record > 0.95 * L && ramp.record <= L, `record ${ramp.record}, limit ${Math.round(L)}`);
  assert.ok(trueFps(RTX2070, ramp.record) >= TARGET);
  assert.equal(ramp.stop, "fps");
});

test("hiccup windows do not walk the record down (the 2070 run)", () => {
  // One window in five reads a third of the real rate, as the 2070 did (16 fps, then 49).
  const L = limit(RTX2070);
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = rng(seed);
    const { ramp } = run(RTX2070, (fps) => (r() < 0.2 ? fps / 3 : fps));
    assert.ok(ramp.record > 0.9 * L, `seed ${seed}: record ${ramp.record} vs limit ${Math.round(L)}`);
    assert.ok(trueFps(RTX2070, ramp.record) >= TARGET, `seed ${seed}: record cannot really hold the target`);
  }
});

test("a failed window is measured again, three in a row count", () => {
  const ramp = new Ramp({ targetFps: TARGET, start: 100 * ROW, quantum: ROW });
  assert.equal(ramp.report(20, 100 * ROW), 100 * ROW, "first fail: measure the same count again");
  assert.equal(ramp.report(20, 100 * ROW), 100 * ROW, "second fail: again");
  assert.equal(ramp.remeasured, 2);
  assert.equal(ramp.phase, "climb");
  const next = ramp.report(20, 100 * ROW);
  assert.equal(ramp.phase, "refine", "third fail in a row: believed");
  assert.equal(next, 50 * ROW);
});

test("a pass between failed windows clears them", () => {
  const ramp = new Ramp({ targetFps: TARGET, start: 100 * ROW, quantum: ROW });
  ramp.report(20, 100 * ROW);
  ramp.report(20, 100 * ROW);
  assert.equal(ramp.report(31, 100 * ROW), 125 * ROW, "the pass counts and the climb goes on");
  assert.equal(ramp.phase, "climb");
});

test("the record still needs its confirming windows in a row", () => {
  const ramp = new Ramp({ targetFps: TARGET, start: 100 * ROW, quantum: ROW });
  // Counts below 112 rows hold the target, counts above do not.
  while (ramp.phase !== "confirm") ramp.report(ramp.count < 112 * ROW ? 31 : 29, ramp.count);
  const c = ramp.count;
  ramp.report(31, c);
  ramp.report(31, c);
  ramp.report(20, c); // a hiccup breaks the run of passes
  assert.equal(ramp.phase, "confirm");
  ramp.report(31, c);
  ramp.report(31, c);
  assert.equal(ramp.phase, "confirm", "only two passes since the hiccup");
  ramp.report(31, c);
  assert.equal(ramp.phase, "hold");
  assert.equal(ramp.record, c);
});

test("a count that keeps flipping between pass and fail is a fail, and the ramp ends", () => {
  const d = RTX2070;
  const L = limit(d);
  let flip = false;
  const { ramp } = run(d, (fps) => {
    // Within 3% of the limit, windows alternate between just above and just below the target.
    if (Math.abs(fps - TARGET) / TARGET < 0.03) return (flip = !flip) ? TARGET + 0.5 : TARGET - 0.5;
    return fps;
  });
  assert.ok(ramp.record > 0.85 * L && ramp.record <= L, `record ${ramp.record}`);
});

test("a memory ceiling with headroom confirms the ceiling and does not reopen", () => {
  const d = { ...RTX2070, maxCount: 100 * 1_000_000 };
  const { ramp } = run(d, (fps) => fps);
  assert.equal(ramp.stop, "ceiling");
  assert.equal(ramp.reopens, 0);
  assert.ok(ramp.record > 0 && ramp.record <= d.maxCount);
});

test("a device that cannot hold the target at the smallest count gives up", () => {
  const slow = { overheadMs: 50, msPerMillion: 1, refresh: 60 };
  const { ramp } = run(slow, (fps) => fps);
  assert.equal(ramp.stop, "floor");
  assert.equal(ramp.record, 0);
});

test("a false fail that sent the search down is undone by the confirming count's headroom", () => {
  // Three hiccups in a row at the first count above 240M make it look like a
  // real fail, so the bracket closes far too low. The candidate then passes
  // with lots of headroom, which reopens the search.
  const L = limit(RTX2070);
  const seen = new Map();
  let spoiled = -1;
  const { ramp } = run(RTX2070, (fps) => fps, 1_000_000, (count) => {
    const n = (seen.get(count) ?? 0) + 1;
    seen.set(count, n);
    if (spoiled === -1 && count > 240e6) spoiled = count;
    return count === spoiled && n <= 3;
  });
  assert.ok(ramp.reopens >= 1, "the search reopened");
  assert.ok(ramp.record > 0.95 * L, `record ${ramp.record} vs limit ${Math.round(L)}`);
  assert.ok(trueFps(RTX2070, ramp.record) >= TARGET);
});

test("reopening is bounded: a cliff the linear model cannot see ends the ramp after two reopens", () => {
  // Above 200M every window reads 20 fps, as if memory started paging. The
  // candidate below the cliff has lots of headroom, so it reopens the search,
  // but only twice: then it is confirmed.
  const { ramp, windows } = run(RTX2070, (fps) => fps, 1_000_000, (count) => count > 200e6);
  assert.equal(ramp.reopens, 2);
  assert.equal(ramp.stop, "fps");
  assert.ok(ramp.record > 0.9 * 200e6 && ramp.record <= 200e6, `record ${ramp.record}`);
  assert.ok(windows < 120, `${windows} windows`);
});

test("a climb from a small count always moves on", () => {
  // 1.25 times one, two or three quanta rounds back down to the same count,
  // which the climb used to try for ever (reachable with ?start=).
  const slow = { overheadMs: 0, msPerMillion: 1000 / TARGET / 2, refresh: 36 }; // holds 2M at the target
  for (const start of [ROW, 2 * ROW, 3 * ROW]) {
    const { ramp } = run(slow, (fps) => fps, start);
    assert.ok(ramp.record > 0.95 * 2e6 && ramp.record <= 2e6, `start ${start}: record ${ramp.record}`);
  }
});
