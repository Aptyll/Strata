/**
 * Perf HUD: live frame, GPU and particle numbers for the Esc menu.
 *
 *   mountPerfHud({ hud: ui.hud, gpu, graph, sim, budget, hooks: loop.hooks });
 *
 * What it adds to the menu (nothing shows outside it):
 *
 *   summary header   "per second" (particles stepped per second), "in frame"
 *                    (particles the GPU counted inside the picture), "gpu load"
 *                    (GPU time as a share of the frame), "1% low", and a
 *                    "simulating" count that reads "paused" while an offline
 *                    render owns the GPU (menu.ts)
 *   perf page        three blocks: timing, particles, gpu (view.ts)
 *   perf page        "fit particles to target fps": sets the particle count
 *                    to an estimate from measured GPU time (fit.ts)
 *
 * Where the numbers come from:
 *
 *   frame pacing     two frame hooks time every frame (frameStats.ts)
 *   GPU ms per pass  timestamp queries, added to each pass from outside
 *                    through FrameGraph.observers (passTimer.ts)
 *   in frame         the compute rasterizer's light buffer, summed on the GPU
 *                    twice a second (lightTally.ts)
 *
 * GPU timing, the tally and all painting run only while the menu is open.
 * Closed, the cost is two clock reads and one ring buffer write a frame.
 */
import type { GpuContext, Pass, PlaneInstance } from "../../core/contracts";
import type { FrameObserver } from "../../core/frameGraph";
import { PARTICLE_STRIDE } from "../../gpu/shaderLib";
import { LIGHT_ONE } from "../../perf/shaders";
import { formatCount, type Hud } from "../hud/index.js";
import { particlesThatFit } from "./fit";
import { FrameStats, PAUSE_MS } from "./frameStats";
import { readGpuFacts, webglRendererName } from "./gpuFacts";
import { LightTallier } from "./lightTally";
import { attachPerfMenu, type PerfMenuHost } from "./menu";
import type { FrameTally, GpuTimingStatus, PerfSnapshot, PerfState } from "./model";
import { PassTimer, type PassTime } from "./passTimer";

export { particlesThatFit } from "./fit";
export { attachPerfMenu } from "./menu";
export type { PerfSnapshot } from "./model";

/** The parts of the HUD this module uses. */
export type PerfHudHost = PerfMenuHost & Pick<Hud, "registerParam" | "removeParam" | "setParam" | "on" | "announce" | "panelOpen">;

/** The two frame hooks this module adds, shaped like FrameHook in src/app/loop.ts. */
export interface PerfFrameHook {
  beforeCamera?(frame: { offline: boolean }): number | void;
  afterFrame?(frame: { offline: boolean }): void;
}

export interface PerfHudDeps {
  hud: PerfHudHost;
  gpu: Pick<GpuContext, "device" | "canvasFormat">;
  /** The app's frame graph: its passes get timed, and its size is the drawing buffer. */
  graph: {
    readonly passes: readonly Pass[];
    readonly observers: FrameObserver[];
    readonly width: number;
    readonly height: number;
  };
  /** Owner of the planes (the simulation). */
  sim: { readonly planes: readonly PlaneInstance[] };
  /** The frame rate target and the governor (src/app/budget.ts). */
  budget: { readonly useAdaptive: boolean; readonly targetFps: number; readonly adaptive: { readonly scale: number } };
  /**
   * The frame loop's hook list (src/app/loop.ts). Mount after every other hook
   * was pushed: this adds one hook at the front and one at the back, so the
   * script time it reports covers the whole frame.
   */
  hooks: PerfFrameHook[];
  /** Id of the HUD param that sets the particle count, for the fit action. Default "particles". */
  particlesParam?: string;
}

export interface PerfHud {
  /** Everything the menu shows, as numbers. Also what the fit action reads. */
  snapshot(): PerfSnapshot;
  dispose(): void;
}

/** Frames in the frame time graph: four seconds at 60 fps. */
const GRAPH_FRAMES = 240;
const PAINT_MS = 200;
const TALLY_MS = 500;
/**
 * No frame for this long means the world is paused: a few of the usual frame
 * times, at least QUIET_MS and at most the limit frameStats.ts puts on one frame.
 */
const QUIET_MS = 500;
const QUIET_FRAMES = 4;
/**
 * A GPU reading older than this is stale (the passes changed, or timing
 * stopped). Readings come back a few frames late, so at a couple of frames a
 * second a fresh one is already seconds old.
 */
const STALE_MS = 6000;
/** Share of each new GPU reading blended in: an average over about a dozen frames. Readings come in 0.1 ms steps. */
const GPU_SMOOTHING = 0.08;
/** Name of the compute rasterizer's pass in the app's graph (src/app/graph.ts). */
const LIGHT_PASS = "atomic-raster";
/** Deposits per particle with sub-pixel splats, each of which may round up by one unit of light (src/raster/kernel.ts). */
const SPLAT_DEPOSITS = 4;

/** The compute rasterizer (src/raster/pass.ts), as far as this module reads it. */
type LightPass = Pass & { readonly counts?: GPUBuffer; readonly subpixel?: boolean; readonly depth?: boolean };

/** Light one particle of this plane adds to its pixel, as the compute rasterizer rounds it (src/raster/kernel.ts). */
const hitLight = (plane: PlaneInstance) =>
  Math.floor(Math.min(16, Math.max(0, Math.fround(plane.desc.brightness ?? 1))) * LIGHT_ONE + 0.5);

/**
 * The light a drawn particle adds: `unit` when every drawn plane agrees (else
 * 0), and the most any of them adds. Sheets fading in, out or with distance
 * add less than the others, and then a light sum is no longer an exact count.
 */
function drawnLight(planes: readonly PlaneInstance[]): { unit: number; most: number } {
  let unit = -1;
  let most = 0;
  for (const plane of planes) {
    if (plane.activeCount <= 0) continue;
    const light = hitLight(plane);
    if (light === 0) continue; // adds nothing and is counted nowhere
    if (unit === -1) unit = light;
    else if (unit !== light) unit = 0;
    most = Math.max(most, light);
  }
  return unit === -1 ? { unit: LIGHT_ONE, most: LIGHT_ONE } : { unit, most };
}

/**
 * The time of the frame being drawn, as the browser stamps it: the value a
 * requestAnimationFrame callback is called with. Two stamps are a whole
 * number of display refreshes apart, so their difference shows dropped frames
 * and nothing else. A clock read inside the callback would add how late the
 * callback happened to start, which nobody sees on screen.
 */
function frameStamp(): number {
  const stamp = document.timeline?.currentTime;
  return typeof stamp === "number" ? stamp : performance.now();
}

export function mountPerfHud(deps: PerfHudDeps): PerfHud {
  const { hud, gpu, graph, sim, budget } = deps;
  const { device } = gpu;
  const particlesParam = deps.particlesParam ?? "particles";
  const stats = new FrameStats();
  const timer = new PassTimer(device);
  const tallier = new LightTallier(device);
  const facts = readGpuFacts(device);
  const intervals = new Float32Array(GRAPH_FRAMES);
  const clock = () => performance.now();
  let open = false;

  // ---- every frame: pacing and script time --------------------------------
  let stamp = 0;
  let lastStamp = 0;
  let scriptStart = 0;
  let lastFrameAt = -Infinity;
  let lastOffline = false;
  const first: PerfFrameHook = {
    beforeCamera() {
      stamp = frameStamp();
      scriptStart = clock();
    },
  };
  const last: PerfFrameHook = {
    afterFrame(frame) {
      const end = clock();
      // Pacing from before an offline render says nothing about the frames after it.
      if (frame.offline !== lastOffline) stats.reset();
      // Only a realtime frame that follows a realtime frame has a meaningful interval.
      if (!frame.offline && !lastOffline) stats.push(stamp - lastStamp, end - scriptStart);
      lastStamp = stamp;
      lastFrameAt = end;
      lastOffline = frame.offline;
      if (open) requestTally(end);
    },
  };
  deps.hooks.unshift(first);
  deps.hooks.push(last);

  // ---- GPU time per pass ----------------------------------------------------
  const smoothed = new Map<string, number>();
  let passNames = "";
  let gpuPasses: PassTime[] = [];
  let gpuTruncated = false;
  let gpuAt = -Infinity;
  timer.onResult = (time) => {
    const names = time.passes.map((p) => p.name).join("|");
    if (names !== passNames) {
      // The set of passes changed (another rasterizer, bloom off): old averages no longer apply.
      passNames = names;
      smoothed.clear();
    }
    gpuPasses = time.passes.map((p) => {
      const before = smoothed.get(p.name);
      const ms = before === undefined ? p.ms : before + (p.ms - before) * GPU_SMOOTHING;
      smoothed.set(p.name, ms);
      return { ...p, ms };
    });
    gpuTruncated = time.truncated;
    gpuAt = clock();
  };
  graph.observers.push(timer);

  // ---- particles in frame, counted on the GPU -------------------------------
  const lightPass = (): LightPass | undefined => {
    const pass = graph.passes.find((p) => p.name === LIGHT_PASS) as LightPass | undefined;
    return pass && pass.enabled !== false ? pass : undefined;
  };
  let tally: FrameTally | null = null;
  let tallyAt = -Infinity;
  let tallyAsked = -Infinity;
  const requestTally = (now: number) => {
    if (now - tallyAsked < TALLY_MS || tallier.busy) return;
    const pass = lightPass();
    const light = pass?.counts;
    if (!pass || !light) return; // another rasterizer is drawing: there is no light buffer to count
    tallyAsked = now;
    // What the frame just submitted did, read now so it matches that frame.
    const weighted = pass.depth === true; // depth cues: every particle adds its own amount
    const split = pass.subpixel === true; // sub-pixel splats: four deposits, each rounded at random
    const { unit, most } = drawnLight(sim.planes);
    tallier.request(light, (t) => {
      let inFrame: number | null = null;
      let peak: number | null = null;
      let bound: FrameTally["bound"] = "about";
      if (weighted) {
        // Light is not a count.
      } else if (unit > 0) {
        inFrame = Math.round(t.light / unit);
        peak = Math.round(t.peak / unit);
        if (!split && t.light % unit === 0) bound = "exact";
      } else {
        // Planes differ: no particle added more than `most` (plus rounding), which gives a floor.
        const ceiling = most + (split ? SPLAT_DEPOSITS : 0);
        inFrame = Math.ceil(t.light / ceiling);
        peak = Math.ceil(t.peak / ceiling);
        bound = "atLeast";
      }
      tally = { inFrame, peak, bound, litPixels: t.lit };
      tallyAt = clock();
    });
  };

  // ---- one snapshot of everything ---------------------------------------------
  const snapshot = (): PerfSnapshot => {
    const now = clock();
    const frame = stats.summary(1000);
    const quiet = Math.min(PAUSE_MS, Math.max(QUIET_MS, QUIET_FRAMES * (frame?.avgMs ?? 0)));
    const state: PerfState = now - lastFrameAt > quiet ? "paused" : lastOffline ? "offline" : "live";
    let simulated = 0;
    let stored = 0;
    for (const plane of sim.planes) {
      stored += plane.capacity;
      if (!plane.paused) simulated += plane.activeCount;
    }
    const fresh = now - gpuAt < STALE_MS && gpuPasses.length > 0;
    const status: GpuTimingStatus = timer.stopped ? "stopped" : !timer.supported ? "unavailable" : fresh ? "on" : "waiting";
    const passes = status === "on" ? gpuPasses : [];
    let totalMs = 0;
    for (const p of passes) totalMs += p.ms;
    const countable = lightPass() !== undefined;
    return {
      state,
      now: frame,
      recent: stats.summary(5000),
      intervals,
      intervalCount: stats.recent(intervals),
      targetFps: budget.targetFps,
      governor: budget.useAdaptive ? budget.adaptive.scale : null,
      gpu: { status, passes, totalMs, truncated: gpuTruncated },
      particles: {
        simulated,
        stored,
        bytesPerParticle: PARTICLE_STRIDE,
        width: graph.width,
        height: graph.height,
        countable,
        tally: countable && now - tallyAt < STALE_MS ? tally : null,
      },
      fit:
        status === "on" && state === "live" && frame
          ? particlesThatFit({ particles: simulated, passes, cpuMs: frame.cpuMs, targetFps: budget.targetFps })
          : null,
      facts,
      canvasFormat: gpu.canvasFormat,
    };
  };

  // ---- the menu: blocks on the perf page, facts in the header, one action ---------
  // The product name is asked for once, when the gpu block is first on screen: it makes a throwaway WebGL context.
  const menu = attachPerfMenu(hud, { product: webglRendererName });

  let raf = 0;
  let painted = -Infinity;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const now = clock();
    if (now - painted < PAINT_MS) return;
    painted = now;
    menu.paint(snapshot());
  };
  const setOpen = (on: boolean) => {
    open = on;
    timer.enabled = on;
    cancelAnimationFrame(raf);
    if (!on) return;
    // Numbers from the last time the menu was open describe another moment.
    smoothed.clear();
    gpuPasses = [];
    tally = null;
    tallyAsked = -Infinity;
    painted = -Infinity;
    raf = requestAnimationFrame(tick);
  };
  const offPanel = hud.on("panel", setOpen);
  if (hud.panelOpen) setOpen(true);

  // Needs GPU timing to estimate from. Without it "hold frame rate" is the tool.
  const FIT = "perf.fit";
  if (timer.supported) {
    hud.registerParam({
      id: FIT,
      type: "action",
      label: "fit particles to target fps",
      group: "performance",
      page: "perf",
      run: () => {
        const s = snapshot();
        if (s.fit === null) return hud.announce("still measuring", "try again in a second");
        const set = hud.setParam(particlesParam, s.fit);
        if (typeof set !== "number") return hud.announce("no particle count to set", "this world sizes itself");
        const fps = `${Math.round(s.targetFps)} fps`;
        // The slider has ends: say what was set, and what the estimate was when they differ.
        if (set < s.fit) hud.announce(`${formatCount(set)} particles`, `the most the slider sets, about ${formatCount(s.fit)} would fit ${fps}`);
        else if (set > s.fit) hud.announce(`${formatCount(set)} particles`, `the fewest the slider sets, about ${formatCount(s.fit)} would fit ${fps}`);
        else hud.announce(`${formatCount(set)} particles`, `estimated for ${fps}`);
      },
    });
  }

  return {
    snapshot,
    dispose() {
      cancelAnimationFrame(raf);
      offPanel();
      hud.removeParam(FIT);
      menu.dispose();
      const i = graph.observers.indexOf(timer);
      if (i >= 0) graph.observers.splice(i, 1);
      for (const hook of [first, last]) {
        const at = deps.hooks.indexOf(hook);
        if (at >= 0) deps.hooks.splice(at, 1);
      }
      timer.dispose();
      tallier.dispose();
    },
  };
}
