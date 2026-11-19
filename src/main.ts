/**
 * Strata entry point (index.html loads this).
 *
 * ?challenge opens Challenge mode (src/challenge). Otherwise startApp() boots
 * the world; read it top to bottom as the boot sequence. Each step lives in a
 * small module under src/app/ (docs/CODEMAP.md has the map):
 *
 *   options.ts  every URL option          graph.ts   the passes the app draws with
 *   budget.ts   particles per plane       scene.ts   the scene and its planes
 *   context.ts  the AppContext for UI     hud.ts     menu entries, stats, app keys
 *   keys.ts     who owns which key        intro.ts   the first-run opening
 *   loop.ts     the frame loop and its hooks
 *
 * Order matters in places: modules that listen to the same DOM events must
 * register in this order (noted below), and HUD entries appear in the order
 * they are registered.
 */
import { createBudgetChoice } from "./app/budget";
import { createAppContext } from "./app/context";
import { createRenderGraph } from "./app/graph";
import { mountAppHud } from "./app/hud";
import { mountIntro } from "./app/intro";
import { KEYS, createKeyRouter } from "./app/keys";
import { createFpsMeter, createFrameLoop } from "./app/loop";
import { readOptions, type AppOptions } from "./app/options";
import { createSceneHost } from "./app/scene";
import { mountCapture } from "./capture/app";
import type { AppContext, GpuContext } from "./core/contracts";
import { createParallaxCamera } from "./depth";
import { initGpu } from "./gpu/context";
import { mountRecord } from "./record";
import { mountPanels } from "./ui";
import { attachCameraInput, createCamera } from "./ux/camera";
import { detectCapability } from "./ux/experience/capability";
import { mountAppHints } from "./ux/experience/app-hints";
import { attachBrushes } from "./ux/experience/engine-brushes";
import { mountFallback } from "./ux/experience/fallback";
import { startStreamingWorld } from "./world";

const options = readOptions(location.search);
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

if (options.challenge) {
  void import("./challenge/main").then((m) => m.startChallenge(canvas));
} else {
  void startApp(canvas, options);
}

async function startApp(canvas: HTMLCanvasElement, options: AppOptions): Promise<void> {
  // ---- GPU, or a small CPU-drawn plane and a note on how to get the real thing
  let gpu: GpuContext;
  try {
    gpu = await initGpu(canvas);
  } catch (err) {
    console.warn(err);
    canvas.remove();
    const cap = await detectCapability();
    mountFallback(document.body, cap.status === "ok" ? { ...cap, status: "device-failed" } : cap);
    return;
  }

  // ---- engine: frame graph, budget, camera, scene ------------------------
  // Light per particle, read while drawing so it follows scene loads and the brightness setting.
  // Captures at a fixed size multiply it by captureGain (set in setResolution below); depth
  // sprites size and dim themselves from the target height, so they skip it.
  let captureGain = 1;
  const particleLight = () =>
    scenes.current.render.brightness * (render.rasterizer.current() === "depth-sprites" ? 1 : captureGain);
  const render = createRenderGraph(gpu, {
    raster: options.raster,
    interplane: options.interplane,
    brightness: particleLight,
  });
  const { graph, sim, depthSprites } = render;
  const budget = createBudgetChoice(options);
  const keys = createKeyRouter();
  const camera = createCamera();
  attachCameraInput(canvas, camera.rig, { keyTarget: keys.cameraTarget });
  // Pointer parallax (src/depth): the eye slides sideways with the pointer while the focus
  // distance holds still on screen. `view` is what gets drawn; `camera` is what input and scenes move.
  const view = createParallaxCamera(camera, {
    enabled: options.parallax,
    focusDist: () => (depthSprites && depthSprites.enabled !== false ? depthSprites.params.focusDist : camera.state.distance),
  });
  view.attach(canvas);
  const scenes = createSceneHost({ sim, camera, depthSprites, options });
  const fps = createFpsMeter();

  // ---- the AppContext that UI and feature code work through --------------
  const app = createAppContext({ gpu, camera, sim, passes: graph.passes, scenes, fps });
  const streaming =
    options.world === null ? null : startStreamingWorld(app, { seed: options.world, maxParticles: options.particles });
  scenes.streaming = streaming;
  mountPanels(app); // src/ui/*.panel.ts behind Tab; there are none yet
  (window as unknown as { strata: AppContext }).strata = app; // handy for poking at the engine from the console

  // ---- people: HUD, pointer forces, the opening ----------------------------
  // Brushes swallow a held pointer's moves, so they must register after the HUD's own pointer listeners.
  const ui = mountAppHud({ app, canvas, scenes, render, budget, camera, view });
  const brushes = attachBrushes(canvas, view, () => sim.planes);
  // One plane ignites, then the world. Skipped with any input, ?intro=0, or ?world.
  const intro =
    options.intro && options.world === null
      ? mountIntro(canvas, camera, sim.planes, () => graph.width / Math.max(1, graph.height))
      : null;

  // One-line gesture hints and the die's breathing, on one schedule; never during the opening.
  const hints = mountAppHints({ canvas, hud: ui.hud, isOpening: () => intro?.active ?? false });

  // ---- frame loop ----------------------------------------------------------
  const loop = createFrameLoop({
    gpu, graph, sim, budget, fps,
    camera: view,
    brightness: particleLight,
    brushes: (dt) => brushes.update(dt, performance.now()),
  });
  if (intro) {
    loop.hooks.push({
      // The opening is for people watching live; offline renders skip it.
      beforeCamera: (f) => (!f.offline && intro.active ? intro.step(f.dt, sim.planes) : 1),
      afterBudget: (counts, f) => {
        if (!f.offline) intro.reveal(counts);
      },
    });
  }
  if (streaming) loop.hooks.push({ afterCamera: (f) => streaming.tick(f.dt) });
  loop.hooks.push({ afterFrame: (f) => ui.update(f.dt) });
  loop.hooks.push({ afterFrame: (f) => hints.update(f.dt) });

  // ---- capture: P screenshot, V record, stills and offline video in the menu ----
  mountCapture({
    canvas,
    hud: ui.hud,
    maxTextureSize: gpu.device.limits.maxTextureDimension2D,
    addPass: (pass) => graph.add(pass),
    frame: (dt) => loop.renderFrame(dt),
    flush: () => gpu.device.queue.onSubmittedWorkDone(),
    setOffline: (on) => (loop.offline = on),
    setResolution: (size) => {
      // Points and splats put a fixed amount of light per particle into one pixel, so a capture
      // taller than the window would come out darker than what was on screen. The vertical field
      // of view is fixed, so pixels per radian follow the height.
      captureGain = size ? (size.height / Math.max(1, graph.height)) ** 2 : 1;
      graph.fixedSize = size;
    },
    keys: { screenshot: KEYS.screenshot, record: KEYS.record },
  });

  // ---- record: 1 trillion particle stills and clips via src/offline, in the menu or from ?record ----
  const record = mountRecord({ hud: ui.hud });
  // The record job has the GPU to itself: the world stops drawing while it runs.
  ui.hud.on("job", (id, running) => {
    if (id === "record") loop.offline = running;
  });
  if (options.record) setTimeout(() => record.start(), 500);

  loop.start();
}
