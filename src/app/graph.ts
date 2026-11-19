/**
 * Builds the app's frame graph: the simulation plus every pass the app can
 * draw with, registered in one place.
 *
 * Passes run stage by stage in PASS_ORDER (src/core/contracts.ts), and in
 * registration order within a stage. Several passes can do the rasterize
 * job; exactly one of them is enabled at a time (each clears the HDR
 * target), chosen with ?raster= or the "rasterizer" setting. Plane crossings
 * register after them because their draw pass adds onto the HDR target.
 *
 * Passes added later from outside: the capture pass (src/capture/app.ts,
 * through CaptureHost.addPass).
 */
import type { GpuContext, Pass, PassStage } from "../core/contracts";
import { FrameGraph } from "../core/frameGraph";
import type { DepthSpritePass } from "../depth";
import { createInterplane } from "../interplane/interplane.pass";
import { createPasses } from "../passes";
import { createAtomicRasterPass } from "../perf/atomicRasterPass";
import { createDensitySplatPass } from "../render/passes";
import { Simulation } from "../sim/simulation";

/** The interchangeable rasterize passes, in menu order. `url` is the ?raster= value. */
export const RASTERIZERS = [
  { url: "", pass: "atomic-raster", label: "compute" },
  { url: "points", pass: "points", label: "points (debug, f16 blend)" },
  { url: "splat", pass: "density-splat", label: "sub-pixel splats (debug)" },
  { url: "sprites", pass: "depth-sprites", label: "depth sprites (debug, f16 blend)" },
] as const;
const DEFAULT_RASTERIZER = "atomic-raster";

/** Of several passes that do the same job, runs only the named one. */
export interface PassChoice {
  readonly options: readonly Pass[];
  set(name: string): void;
  /** Name of the enabled pass. */
  current(): string | undefined;
}

export interface RenderGraph {
  graph: FrameGraph;
  /** Owns every plane's particles; it is also the graph's simulate pass. */
  sim: Simulation;
  rasterizer: PassChoice;
  /** Particles crossing between neighbouring planes (src/interplane). */
  interplane: { readonly passes: readonly Pass[]; readonly enabled: boolean; set(on: boolean): void };
  /** The depth sprites rasterizer, which sizes its fog and focus to the world. */
  depthSprites: DepthSpritePass | undefined;
}

export interface RenderGraphOptions {
  /** Short rasterizer name from the URL (AppOptions.raster). */
  raster: string;
  interplane: boolean;
  /** Light per particle, read every frame by passes that need it. */
  brightness: () => number;
}

export function createRenderGraph(gpu: GpuContext, options: RenderGraphOptions): RenderGraph {
  const sim = new Simulation(gpu);
  const graph = new FrameGraph(gpu);
  graph.add(
    sim, // simulate: every plane's behavior (src/sim)
    ...createPasses(gpu), // src/passes/*.pass.ts in filename order: points, depth sprites, tonemap
    createAtomicRasterPass(gpu), // rasterize: compute rasterizer, the default (src/perf)
    createDensitySplatPass({ energy: options.brightness }), // rasterize: sub-pixel splats (src/render)
  );

  const rasterizer = choosePass(graph, "rasterize");
  rasterizer.set(RASTERIZERS.find((r) => r.url === options.raster)?.pass ?? DEFAULT_RASTERIZER);
  const depthSprites = rasterizer.options.find((p) => p.name === "depth-sprites") as DepthSpritePass | undefined;

  // Registered after the choice above, so its rasterize pass runs after whichever rasterizer is on.
  const crossings = createInterplane();
  graph.add(...crossings.passes);
  const interplane = {
    passes: crossings.passes,
    get enabled() {
      return crossings.passes[0].enabled !== false;
    },
    set(on: boolean) {
      crossings.passes.forEach((p) => (p.enabled = on));
    },
  };
  interplane.set(options.interplane);

  return { graph, sim, rasterizer, interplane, depthSprites };
}

function choosePass(graph: FrameGraph, stage: PassStage): PassChoice {
  const options = graph.passes.filter((p) => p.stage === stage);
  return {
    options,
    set: (name) => options.forEach((p) => (p.enabled = p.name === name)),
    current: () => options.find((p) => p.enabled !== false)?.name,
  };
}
