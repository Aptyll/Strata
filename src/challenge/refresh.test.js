// The screen's refresh rate and what it means for the search, checked by `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Ramp } from "./ramp";
import { capDisproved, measureRefresh, refreshFromIntervals, screenLimit } from "./refresh";

const near = (value, want, tolerance, what) =>
  assert.ok(Math.abs(value - want) <= tolerance, `${what}: ${value} is not within ${tolerance} of ${want}`);

test("the refresh rate is the median gap between frames", () => {
  near(refreshFromIntervals(Array(24).fill(16.67)), 60, 0.1, "60 Hz");
  near(refreshFromIntervals(Array(24).fill(33.33)), 30, 0.1, "30 Hz");
  near(refreshFromIntervals(Array(24).fill(6.94)), 144, 0.5, "144 Hz");
  // Jitter around the true gap, as timers give it.
  const jitter = Array.from({ length: 24 }, (_, i) => 16.67 + (i % 2 ? 0.8 : -0.8));
  near(refreshFromIntervals(jitter), 60, 3.1, "60 Hz with jitter");
});

test("slow frames while the page starts and doubled callbacks do not change the answer", () => {
  const starting = [16.7, 16.6, 180, 50.1, 16.7, 16.8, 33.4, 16.6, 0.3, 16.7, 16.7, 16.6, 16.8, 16.7, 16.7];
  near(refreshFromIntervals(starting), 60, 0.5, "60 Hz with a hitch");
  assert.equal(refreshFromIntervals([16.7, 16.7, 16.7]), 0, "too few frames to tell");
  assert.equal(refreshFromIntervals([400, 900, 250, 1200, 300, 700]), 0, "a page that was hidden tells nothing");
});

test("measuring reads frames from requestAnimationFrame and stops on its own", async () => {
  const clock = (gapMs) => {
    let now = 1000;
    let calls = 0;
    const raf = (cb) => {
      calls++;
      now += gapMs(calls);
      queueMicrotask(() => cb(now));
    };
    return { raf, calls: () => calls };
  };
  const steady = clock(() => 33.3);
  near(await measureRefresh(24, steady.raf), 30, 0.1, "a 30 Hz screen");
  assert.ok(steady.calls() <= 26, `24 gaps need 25 frames, used ${steady.calls()}`);

  const stalled = clock(() => 500);
  assert.equal(await measureRefresh(24, stalled.raf), 0, "no steady pace: unknown");
  assert.ok(stalled.calls() <= 24 * 4 + 2, "it gives up instead of waiting for ever");
});

test("a screen faster than the target leaves the test at the target", () => {
  assert.deepEqual(screenLimit(60, 30), { screenHz: null, passFps: 30 });
  assert.deepEqual(screenLimit(144, 30), { screenHz: null, passFps: 30 });
  assert.deepEqual(screenLimit(120, 60), { screenHz: null, passFps: 60 });
  assert.deepEqual(screenLimit(0, 30), { screenHz: null, passFps: 30 }, "an unknown screen is treated as fast");
});

test("a screen at the target or under it is held to its own refresh rate, with room for noise", () => {
  for (const [hz, target] of [[30, 30], [29.97, 30], [30.6, 30], [24, 30], [60, 60], [59.94, 60]]) {
    const limit = screenLimit(hz, target);
    assert.equal(limit.screenHz, hz, `${hz} Hz for ${target} fps is capped`);
    near(limit.passFps, hz * 0.95, 1e-9, "pass rate");
    // A window measured on such a screen reads within about 3 percent of the refresh rate.
    assert.ok(hz * 0.97 >= limit.passFps, "noise alone must not fail a window");
    // Missing one refresh in three reads as two thirds of the rate.
    assert.ok(hz * (2 / 3) < limit.passFps, "a missed refresh must fail it");
  }
});

// ---- the search itself on pretend screens (the ramp's own tests are in ramp.test.mjs) ----

const ROW = 65536;
const M = 1_000_000;

/**
 * A pretend GPU and screen. The GPU alone would run `limit` particles at `at`
 * fps and slows in proportion to the count; the screen shows at most
 * `refresh` frames a second. Each measured window is off by up to `noise`.
 */
function device({ limit, at = 30, refresh = 60, noise = 0.01, seed = 1 }) {
  let s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return (count) => Math.min(refresh, (at * limit) / count) * (1 + (rand() * 2 - 1) * noise);
}

/** Run a ramp to the end the way main.ts does. Returns the number of windows it took. */
function search(ramp, fpsAt, maxWindows = 400) {
  let windows = 0;
  let count = ramp.count;
  while (ramp.phase !== "hold" && windows < maxWindows) {
    windows++;
    count = ramp.report(fpsAt(count), count, false);
  }
  return windows;
}

/** The ramp main.ts builds for a target on a screen with this refresh rate. */
function rampFor(targetFps, refresh) {
  const { screenHz, passFps } = screenLimit(refresh, targetFps);
  return new Ramp({ targetFps: passFps, start: 1_048_576, quantum: ROW, blind: screenHz !== null });
}

test("on a screen faster than the target the search lands just under the true limit", () => {
  for (const refresh of [60, 120, 144]) {
    for (let seed = 1; seed <= 12; seed++) {
      const ramp = rampFor(30, refresh);
      const windows = search(ramp, device({ limit: 40 * M, refresh, seed }));
      assert.equal(ramp.phase, "hold");
      assert.ok(ramp.record <= 40.5 * M && ramp.record >= 34 * M, `${refresh} Hz seed ${seed}: record ${ramp.record}`);
      assert.ok(ramp.recordFps >= 30, "the record held the target in every confirming window");
      assert.ok(windows <= 60, `took ${windows} windows`);
    }
  }
});

test("on a screen capped at the target the search still finds the limit", () => {
  // 30 Hz: a phone in low power mode, a browser's energy saver, a 30 Hz screen.
  for (const [target, refresh] of [[30, 30], [30, 29.97], [60, 60], [30, 24]]) {
    for (const noise of [0.01, 0.03]) {
      for (let seed = 1; seed <= 12; seed++) {
        const ramp = rampFor(target, refresh);
        const windows = search(ramp, device({ limit: 40 * M, at: refresh, refresh, seed, noise }));
        assert.equal(ramp.phase, "hold");
        assert.ok(ramp.record <= 43 * M && ramp.record >= 34 * M, `${refresh} Hz noise ${noise} seed ${seed}: record ${ramp.record}`);
        assert.ok(ramp.recordFps >= refresh * 0.95, "the record showed every refresh");
        assert.ok(windows <= 60, `took ${windows} windows`);
      }
    }
  }
});

test("the strict test on a capped screen is the failure this guards against", () => {
  // The same device with "at least 30" on a screen that shows exactly 30:
  // every window passes or fails on noise, and the record ends far under the 40M it holds.
  let lost = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const ramp = new Ramp({ targetFps: 30, start: 1_048_576, quantum: ROW });
    search(ramp, device({ limit: 40 * M, refresh: 30, seed }));
    if (ramp.record < 20 * M) lost++;
  }
  assert.ok(lost >= 8, `expected the strict rule to lose the limit, it did in ${lost} of 12 runs`);
});

test("a misread refresh is undone by the first window that beats it", () => {
  // A 60 Hz screen measured as 30 while the page started (late frames).
  const misread = screenLimit(30, 30);
  assert.equal(misread.screenHz, 30);
  // The first window of the search runs a small count and shows every refresh: 60 fps disproves the cap.
  assert.equal(capDisproved(misread.screenHz, 59.8), true);
  // On a screen that really is capped, a window reads at most about one frame over the refresh.
  for (const [hz, fps] of [[30, 30.9], [30, 31.5], [29.97, 30.8], [24, 25], [60, 61]]) {
    assert.equal(capDisproved(hz, fps), false, `${hz} Hz read as ${fps} fps`);
  }
  assert.equal(capDisproved(null, 144), false, "a screen that was never capped has nothing to undo");
  // Undone, the search is the plain one: the target itself, no blind climb.
  assert.deepEqual(screenLimit(0, 30), { screenHz: null, passFps: 30 });
});
