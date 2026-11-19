// The perf HUD's arithmetic, without a GPU or a page: frame pacing, the fit
// estimate, turning raw timestamps and tally strips into numbers, and wording.
// The GPU side (pass timer, light tally) is checked in perf-hud.verify.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { particlesThatFit } from "./fit";
import { FrameStats } from "./frameStats";
import { tidyRendererName } from "./gpuFacts";
import { sumStrips } from "./lightTally";
import { boundMark, formatBytes, formatFps, formatMs, formatShare, gpuLoad, particlesPerSecond } from "./model";
import { collectPassTimes } from "./passTimer";

const near = (actual, expected, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("one hitch among smooth frames barely moves the average and sets the 1% low", () => {
  const stats = new FrameStats();
  for (let i = 0; i < 99; i++) stats.push(16, 1);
  stats.push(50, 9);
  const s = stats.summary(5000);
  assert.equal(s.frames, 100);
  near(s.avgMs, 16.34);
  near(s.fps, 1000 / 16.34, 0.01);
  near(s.low1Ms, 50); // the slowest hundredth of 100 frames is the one hitch
  near(s.low1Fps, 20);
  near(s.worstMs, 50);
  near(s.cpuMs, 1.08);
  near(s.cpuWorstMs, 9);
});

test("the summary covers only the newest frames that fit in the window", () => {
  const stats = new FrameStats();
  for (let i = 0; i < 100; i++) stats.push(100, 0); // old, slow
  for (let i = 0; i < 60; i++) stats.push(10, 0); // the newest 600 ms
  const s = stats.summary(500);
  assert.equal(s.frames, 50);
  near(s.avgMs, 10);
  assert.equal(stats.summary(5000).worstMs, 100);
});

test("pauses and nonsense intervals are not frames", () => {
  const stats = new FrameStats();
  assert.equal(stats.summary(), null);
  stats.push(2500, 1); // the tab was hidden
  stats.push(0, 1);
  stats.push(-3, 1);
  stats.push(Number.NaN, 1);
  assert.equal(stats.count, 0);
  stats.push(20, -1); // a clock that went backwards costs nothing
  assert.equal(stats.summary().cpuMs, 0);
});

test("the ring keeps the newest frames, oldest first", () => {
  const stats = new FrameStats(4);
  for (const ms of [1, 2, 3, 4, 5, 6]) stats.push(ms, 0);
  const out = new Float32Array(3);
  assert.equal(stats.recent(out), 3);
  assert.deepEqual([...out], [4, 5, 6]);
  const wide = new Float32Array(8);
  assert.equal(stats.recent(wide), 4);
  assert.deepEqual([...wide.subarray(0, 4)], [3, 4, 5, 6]);
  stats.reset();
  assert.equal(stats.count, 0);
});

const pass = (name, stage, ms) => ({ name, stage, ms, gpuPasses: 1 });

test("the fit estimate scales per-particle GPU time into the frame budget", () => {
  // 60 fps at 85% leaves 14.17 ms. Tone mapping (1 ms) and script (1.17 ms) do not scale: 12 ms for particles.
  const fit = particlesThatFit({
    particles: 1_000_000,
    passes: [pass("simulate", "simulate", 2), pass("atomic-raster", "rasterize", 4), pass("tonemap", "tonemap", 1)],
    cpuMs: 1000 / 60 * 0.85 - 13,
    targetFps: 60,
  });
  assert.equal(fit, 2_000_000);
});

test("the fit estimate never moves more than its step in one go, and says nothing without readings", () => {
  const passes = [pass("simulate", "simulate", 0.2)];
  assert.equal(particlesThatFit({ particles: 1_000_000, passes, cpuMs: 0, targetFps: 60 }), 8_000_000);
  assert.equal(particlesThatFit({ particles: 1_000_000, passes: [pass("simulate", "simulate", 400)], cpuMs: 0, targetFps: 60 }), 130_000);
  // Below the timer's 0.1 ms step the reading is mostly rounding: counted as one step, which errs low.
  assert.equal(
    particlesThatFit({ particles: 1_000_000, passes: [pass("simulate", "simulate", 0.01)], cpuMs: 0, targetFps: 60 }, { maxStep: 1000 }),
    140_000_000,
  );
  assert.equal(particlesThatFit({ particles: 1_000_000, passes: [], cpuMs: 0, targetFps: 60 }), null);
  assert.equal(particlesThatFit({ particles: 0, passes, cpuMs: 0, targetFps: 60 }), null);
});

test("timestamps become per-pass times, and unwritten or backwards readings are dropped", () => {
  const ms = (n) => BigInt(Math.round(n * 1e6));
  const owners = [
    { name: "simulate", stage: "simulate" },
    { name: "simulate", stage: "simulate" },
    { name: "atomic-raster", stage: "rasterize" },
    { name: "tonemap", stage: "tonemap" },
    { name: "tonemap", stage: "tonemap" },
  ];
  const stamps = new BigUint64Array([
    ms(100), ms(101), // simulate, first GPU pass: 1 ms
    ms(101), ms(103.5), // simulate, second: 2.5 ms
    ms(104), ms(108), // atomic-raster: 4 ms
    0n, 0n, // never written
    ms(120), ms(110), // backwards
  ]);
  const time = collectPassTimes(stamps, owners, false);
  assert.deepEqual(time.passes.map((p) => [p.name, p.gpuPasses]), [["simulate", 2], ["atomic-raster", 1]]);
  near(time.passes[0].ms, 3.5);
  near(time.totalMs, 7.5);
  near(time.spanMs, 8); // 100 to 108, gaps between passes included
  assert.equal(collectPassTimes(new BigUint64Array(4), owners.slice(0, 2), false), null);
});

test("tally strips add up past 32 bits", () => {
  const words = new Uint32Array([4294967295, 0, 300, 2, 1, 3, 512, 7]);
  assert.deepEqual(sumStrips(words, 4096), { light: 4294967295 + 1 + 3 * 4294967296, peak: 512, lit: 9, pixels: 4096 });
});

test("the WebGL renderer string is cut down to the product name", () => {
  assert.equal(
    tidyRendererName("ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 (0x00001F02) Direct3D11 vs_5_0 ps_5_0, D3D11)"),
    "NVIDIA GeForce RTX 2070",
  );
  assert.equal(tidyRendererName("ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"), "Apple M2");
  assert.equal(tidyRendererName("ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)"), "Mesa Intel(R) UHD Graphics 620 (KBL GT2)");
  assert.equal(tidyRendererName("Mali-G78"), "Mali-G78");
});

test("numbers are worded the same everywhere", () => {
  assert.deepEqual([0.336, 4.06, 16.67, 120.4].map(formatMs), ["0.34 ms", "4.1 ms", "16.7 ms", "120 ms"]);
  assert.deepEqual([59.6, 9.97, 9.4, 143.8].map(formatFps), ["60 fps", "10 fps", "9.4 fps", "144 fps"]);
  assert.deepEqual([0.253, 0.004, 0, 1.2].map(formatShare), ["25%", "<1%", "0%", "120%"]);
  assert.deepEqual([16_777_216, 3_200_000_000, 12e9, 900].map(formatBytes), ["17 MB", "3.2 GB", "12 GB", "1 KB"]);
  assert.deepEqual([formatMs(Number.NaN), formatFps(Infinity), formatShare(Number.NaN)], ["-", "-", "-"]);
  assert.deepEqual(["exact", "about", "atLeast"].map(boundMark), ["", "~", "≥"]);
});

test("gpu load and particles per second exist only for realtime frames", () => {
  const stats = new FrameStats();
  for (let i = 0; i < 60; i++) stats.push(20, 1);
  const live = {
    state: "live",
    now: stats.summary(1000),
    gpu: { status: "on", passes: [], totalMs: 5, truncated: false },
    particles: { simulated: 2_000_000 },
  };
  near(gpuLoad(live), 0.25);
  near(particlesPerSecond(live), 100_000_000, 1);
  assert.equal(gpuLoad({ ...live, state: "offline" }), null);
  assert.equal(particlesPerSecond({ ...live, state: "paused" }), null);
  assert.equal(gpuLoad({ ...live, gpu: { ...live.gpu, status: "waiting" } }), null);
});
