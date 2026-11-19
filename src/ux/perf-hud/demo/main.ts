// The perf HUD without an engine: a real HUD, the real perf page blocks and
// header facts (../menu.ts), and made-up snapshots that move like a running
// app. Every number on this page is invented; nothing here measures anything.
//
// Keys 1 to 9 switch between cases, each one a situation the page has to word
// honestly: a GPU with room, a GPU at its limit, stutter, counts that are
// exact, a floor or not a count at all, an offline render, no GPU timing.
// ?case=<id> opens on one.

import type { PassStage } from "../../../core/contracts";
import { createHud } from "../../hud/index.js";
import { particlesThatFit } from "../fit";
import { FrameStats } from "../frameStats";
import type { GpuFacts } from "../gpuFacts";
import { attachPerfMenu } from "../menu";
import type { GpuTimingStatus, PerfSnapshot, PerfState, TallyBound } from "../model";
import type { PassTime } from "../passTimer";

type PassRow = [name: string, stage: PassStage, ms: number, gpuPasses?: number];

interface Case {
  id: string;
  label: string;
  state?: PerfState;
  /** Typical time between frames, and an optional hitch every so many frames. */
  frameMs: number;
  hitch?: { every: number; ms: number };
  simulated: number;
  stored: number;
  passes: PassRow[];
  timing?: GpuTimingStatus;
  governor?: number;
  /** How the in-frame count can be trusted, "weighted" for depth cues, or null for a renderer without a light buffer. */
  tally: TallyBound | "weighted" | null;
  /** Share of the simulated particles that land inside the frame. */
  inFrame?: number;
  targetFps?: number;
  software?: boolean;
}

// The passes of the default app, in the order they run (src/app/graph.ts).
const COMPUTE: PassRow[] = [
  ["simulate", "simulate", 1.3],
  ["interplane-crossing", "interplane", 0.1],
  ["atomic-raster", "rasterize", 1.9, 2],
  ["interplane-streams", "rasterize", 0.2],
  ["tonemap", "tonemap", 0.6, 3],
];
const scale = (passes: PassRow[], k: number): PassRow[] =>
  passes.map(([name, stage, ms, n]) => [name, stage, stage === "tonemap" ? ms : ms * k, n]);

const CASES: Case[] = [
  { id: "room", label: "a GPU with room", frameMs: 16.67, simulated: 1_048_576, stored: 1_048_576, passes: COMPUTE, tally: "exact", inFrame: 0.71 },
  { id: "limit", label: "a GPU at its limit, holding 60", frameMs: 16.67, simulated: 9_900_000, stored: 16_000_000, passes: scale(COMPUTE, 4.3), governor: 0.62, tally: "exact", inFrame: 0.64 },
  { id: "slow", label: "too many particles", frameMs: 66.7, simulated: 64_000_000, stored: 64_000_000, passes: scale(COMPUTE, 18.6), tally: "exact", inFrame: 0.58 },
  { id: "stutter", label: "smooth on average, with hitches", frameMs: 16.67, hitch: { every: 55, ms: 50 }, simulated: 4_000_000, stored: 4_000_000, passes: scale(COMPUTE, 2), tally: "exact", inFrame: 0.7 },
  { id: "world", label: "streamed world, sheets fading", frameMs: 16.67, simulated: 6_200_000, stored: 21_000_000, passes: scale(COMPUTE, 3), tally: "atLeast", inFrame: 0.33 },
  { id: "splats", label: "sub-pixel splats", frameMs: 16.67, simulated: 2_000_000, stored: 2_000_000, passes: scale(COMPUTE, 1.8), tally: "about", inFrame: 0.69 },
  { id: "depth", label: "depth cues on", frameMs: 16.67, simulated: 2_000_000, stored: 2_000_000, passes: scale(COMPUTE, 2.2), tally: "weighted", inFrame: 0.69 },
  { id: "offline", label: "offline video render", state: "offline", frameMs: 16.67, simulated: 16_000_000, stored: 16_000_000, passes: scale(COMPUTE, 9), tally: "exact", inFrame: 0.6 },
  { id: "paused", label: "record render owns the GPU", state: "paused", frameMs: 16.67, simulated: 0, stored: 1_048_576, passes: [], tally: null },
  { id: "bare", label: "no GPU timestamps, software renderer, points", frameMs: 33.3, simulated: 300_000, stored: 300_000, passes: [], timing: "unavailable", tally: null, software: true, targetFps: 30 },
];

const hud = createHud({ persist: false, panelOpen: true, dice: false, idleMs: 0, autoFps: false });
const menu = attachPerfMenu(hud, { product: () => "NVIDIA GeForce RTX 2070" });

const WIDTH = 1920;
const HEIGHT = 1080;
const intervals = new Float32Array(240);
let stats = new FrameStats();
let current = CASES[0];
let frames = 0;
let owed = 0;
const wobble = (amount: number) => 1 + (Math.random() - 0.5) * 2 * amount;

function facts(c: Case): GpuFacts {
  return {
    adapter: c.software ? "google swiftshader" : "nvidia turing",
    software: c.software === true,
    timestamps: c.timing !== "unavailable",
    maxBufferBytes: 2_147_483_648,
    maxBindingBytes: 2_147_483_644,
    maxSheetParticles: Math.floor(2_147_483_644 / 16),
  };
}

/** Advance the made-up frame clock by `ms` and describe the moment. */
function snapshot(c: Case, ms: number): PerfSnapshot {
  const state = c.state ?? "live";
  if (state === "live") {
    owed += ms;
    while (owed > 0) {
      const hitch = c.hitch && ++frames % c.hitch.every === 0;
      const interval = hitch ? c.hitch!.ms : c.frameMs;
      stats.push(interval, 0.9 * wobble(0.3) + (hitch ? 6 : 0));
      owed -= interval;
    }
  }
  const timing = c.timing ?? (c.passes.length ? "on" : "waiting");
  const passes: PassTime[] = timing === "on" ? c.passes.map(([name, stage, t, gpuPasses = 1]) => ({ name, stage, ms: t * wobble(0.03), gpuPasses })) : [];
  const now = stats.summary(1000);
  const targetFps = c.targetFps ?? 60;
  const inFrame = Math.round(c.simulated * (c.inFrame ?? 0) * wobble(0.01));
  return {
    state,
    now,
    recent: stats.summary(5000),
    intervals,
    intervalCount: stats.recent(intervals),
    targetFps,
    governor: c.governor === undefined ? null : c.governor * wobble(0.02),
    gpu: { status: timing, passes, totalMs: passes.reduce((sum, p) => sum + p.ms, 0), truncated: false },
    particles: {
      simulated: c.simulated,
      stored: c.stored,
      bytesPerParticle: 16,
      width: WIDTH,
      height: HEIGHT,
      countable: c.tally !== null,
      tally:
        c.tally === null || state === "paused"
          ? null
          : {
              inFrame: c.tally === "weighted" ? null : inFrame,
              peak: c.tally === "weighted" ? null : Math.round(40 * wobble(0.1) * (c.simulated / 1_048_576)),
              bound: c.tally === "weighted" ? "about" : c.tally,
              litPixels: Math.round(WIDTH * HEIGHT * Math.min(0.97, 0.24 * Math.sqrt(c.simulated / 1_048_576))),
            },
    },
    fit: timing === "on" && state === "live" && now ? particlesThatFit({ particles: c.simulated, passes, cpuMs: now.cpuMs, targetFps }) : null,
    facts: facts(c),
    canvasFormat: "bgra8unorm",
  };
}

function show(c: Case): void {
  current = c;
  stats = new FrameStats();
  frames = 0;
  owed = 5000; // start with five seconds of history, as if the menu was opened on a running app
  hud.status(`case ${CASES.indexOf(c) + 1} of ${CASES.length}: ${c.label}\nmade-up numbers. keys 1 to 9 and 0 switch`);
  paint(0);
}

function paint(ms: number): void {
  const s = snapshot(current, ms);
  // The header's frame rate is the HUD's own stat; the app sets it from its fps meter.
  hud.setStat("fps", s.state === "live" && s.now ? s.now.fps : null);
  hud.setStats({ particles: current.simulated, total: current.stored, planes: 12 });
  hud.setFact("resolution", `${WIDTH}\u00d7${HEIGHT}`); // this page has no drawing buffer for the menu to measure
  menu.paint(s);
}

CASES.forEach((c, i) => {
  hud.registerShortcut({ key: String((i + 1) % 10), label: c.label, run: () => show(c) });
});
// The fit action as the app adds it, announcing instead of resizing a world.
hud.registerParam({
  id: "perf.fit", type: "action", label: "fit particles to target fps", group: "performance", page: "perf",
  run: () => {
    const s = snapshot(current, 0);
    if (s.fit === null) hud.announce("still measuring", "try again in a second");
    else hud.announce(`${s.fit.toLocaleString("en-US")} particles`, `estimated for ${s.targetFps} fps (demo: nothing was resized)`);
  },
});

const wanted = new URLSearchParams(location.search).get("case");
show(CASES.find((c) => c.id === wanted) ?? CASES[0]);
// Open on the timing section when the menu shows one section at a time.
document.querySelector<HTMLElement>('.sm-subtab[data-section="timing"]')?.click();

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  paint(Math.min(1000, now - last));
  last = now;
}, 200);
