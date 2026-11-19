/**
 * The app's frame loop. One frame, in order:
 *
 *   1. size the drawing buffer to the canvas (or to a capture's fixed size)
 *   2. hooks.beforeCamera   may steer the camera; returns an exposure multiplier
 *   3. camera.update
 *   4. hooks.afterCamera    things that follow the camera (world streaming)
 *   5. write the Globals uniform: view, time, brightness x exposure, pointer brushes
 *   6. the budget picks each plane's particle count
 *   7. hooks.afterBudget    may lower those counts in place (the opening's reveal)
 *   8. apply the counts, encode and submit the frame graph
 *   9. hooks.afterFrame     per-frame UI (HUD stats, roll transitions)
 *
 * Hooks run in the order they were pushed. renderFrame() is also what offline
 * capture calls to step the world at a fixed dt; while `offline` is true the
 * realtime tick keeps measuring fps but draws nothing.
 *
 * Two clocks. The world steps by `dt`, which the realtime tick caps at 1/30 s:
 * below 30 fps the simulation runs in slow motion instead of taking steps too
 * big to be stable. The camera and the pointer forces follow `wallDt`, the
 * real time since the last frame, so the person's hand never goes into slow
 * motion with the world: at 15 fps a drag, a flick or a W press still moves
 * the camera as far per second as at 60.
 */
import { measurePlanes } from "../core/budget";
import type { CameraController, GpuContext } from "../core/contracts";
import type { FrameGraph } from "../core/frameGraph";
import { writeGlobals } from "../gpu/context";
import type { Simulation } from "../sim/simulation";
import type { BudgetChoice } from "./budget";

/** Frames per second over the last quarter second or so. */
export interface FpsMeter {
  readonly value: number;
  /** Count one frame at `now` milliseconds. */
  tick(now: number): void;
}

export function createFpsMeter(windowMs = 250): FpsMeter {
  let value = 0;
  let frames = 0;
  let since = performance.now();
  return {
    get value() {
      return value;
    },
    tick(now) {
      frames++;
      if (now - since >= windowMs) {
        value = (frames * 1000) / (now - since);
        frames = 0;
        since = now;
      }
    },
  };
}

/** Longest real-time step the camera and pointer take in one frame, so a hitch or a background tab is not one giant move. */
const MAX_WALL_STEP = 0.1;

export interface FrameInfo {
  /** Seconds simulated this frame. */
  dt: number;
  /**
   * Seconds of real time since the previous frame (capped at 0.1). Equal to `dt` except below
   * 30 fps, where `dt` is capped lower. Use it for anything that follows the person, not the world.
   */
  wallDt: number;
  /** True while an offline render drives the loop. */
  offline: boolean;
}

/** Optional steps a feature adds to every frame. See the order at the top of this file. */
export interface FrameHook {
  /** Before the camera moves. May steer the camera. Return a brightness multiplier (nothing means 1). */
  beforeCamera?(frame: FrameInfo): number | void;
  afterCamera?(frame: FrameInfo): void;
  /** `counts` holds each plane's particle count for this frame; lower entries in place. */
  afterBudget?(counts: number[], frame: FrameInfo): void;
  afterFrame?(frame: FrameInfo): void;
}

export interface FrameLoopDeps {
  gpu: GpuContext;
  graph: FrameGraph;
  sim: Simulation;
  camera: CameraController;
  budget: BudgetChoice;
  fps: FpsMeter;
  /** Light per particle before exposure, read every frame. */
  brightness: () => number;
  /** Packed pointer brushes for this frame (MAX_BRUSHES x BRUSH_FLOATS floats). `dt` is real time. */
  brushes: (dt: number) => Float32Array;
}

export interface FrameLoop {
  readonly hooks: FrameHook[];
  /** True while an offline render owns the loop: the realtime tick stops drawing. */
  offline: boolean;
  /**
   * Simulate and draw one frame, `dt` seconds after the previous one. `wallDt` is the real
   * time that passed, for the camera and the pointer; leave it out and it is `dt`, which is
   * what an offline render wants (its frames are evenly spaced whatever the clock says).
   */
  renderFrame(dt: number, wallDt?: number): void;
  /** Start the realtime requestAnimationFrame loop. */
  start(): void;
}

export function createFrameLoop(deps: FrameLoopDeps): FrameLoop {
  const { gpu, graph, sim, camera, budget, fps } = deps;
  const hooks: FrameHook[] = [];
  let last = performance.now();
  let time = 0;
  let frame = 0;

  const loop: FrameLoop = {
    hooks,
    offline: false,

    renderFrame(dt, wallDt = dt) {
      const info: FrameInfo = { dt, wallDt, offline: loop.offline };
      time += dt;
      graph.resize();
      budget.adaptive.setViewport(graph.width, graph.height);

      let exposure = 1;
      for (const hook of hooks) {
        const e = hook.beforeCamera?.(info);
        if (typeof e === "number") exposure *= e;
      }
      camera.update(wallDt);
      for (const hook of hooks) hook.afterCamera?.(info);

      const viewProj = camera.viewProjection(graph.width / graph.height);
      // Pointer forces: hold still on a sheet to pull, right button or Shift to push.
      const brushes = deps.brushes(wallDt);
      writeGlobals(gpu, { viewProj, time, dt, frame, brightness: deps.brightness() * exposure, brushes });

      const counts = budget.forFrame(info.offline).allocate({
        planes: measurePlanes(sim.planes, camera, viewProj),
        fps: fps.value || budget.targetFps,
        targetFps: budget.targetFps,
      });
      for (const hook of hooks) hook.afterBudget?.(counts, info);
      sim.planes.forEach((plane, i) => (plane.activeCount = counts[i]));

      graph.run({ planes: sim.planes, camera, time, dt, frame });
      frame++;
      for (const hook of hooks) hook.afterFrame?.(info);
    },

    start() {
      const tick = (now: number) => {
        const elapsed = (now - last) / 1000;
        // Clamp dt so a background tab or a hitch does not explode the simulation.
        const dt = Math.min(elapsed, 1 / 30);
        last = now;
        fps.tick(now);
        if (!loop.offline) loop.renderFrame(dt, Math.min(elapsed, MAX_WALL_STEP));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  };
  return loop;
}
