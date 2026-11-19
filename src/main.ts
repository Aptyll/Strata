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
import { KEYS, MOVES_CAMERA, createKeyRouter } from "./app/keys";
import { createFpsMeter, createFrameLoop } from "./app/loop";
import { readOptions, type AppOptions } from "./app/options";
import { createSceneHost } from "./app/scene";
import { mountSound } from "./audio";
import { mountCapture } from "./capture/app";
import type { AppContext, GpuContext } from "./core/contracts";
import { createParallaxCamera } from "./depth";
import { initGpu } from "./gpu/context";
import { mountRecord } from "./record";
import { mountPanels } from "./ui";
import { mountAutoCam } from "./ux/autocam";
import { attachCameraInput, createCamera } from "./ux/camera";
import { applyMobileBudget, mountMobileControls } from "./ux/mobile";
import { mountPerfHud } from "./ux/perf-hud";
import { detectCapability } from "./ux/experience/capability";
import { mountAppHints } from "./ux/experience/app-hints";
import { attachBrushes } from "./ux/experience/engine-brushes";
import { mountFallback } from "./ux/experience/fallback";
import { mountRecovery, reportBootFailure } from "./ux/recovery";
import { startStreamingWorld } from "./world";

const options = applyMobileBudget(readOptions(location.search), location.search); // phones get a smaller budget (src/ux/mobile)
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

if (options.challenge) {
  void import("./challenge/main").then((m) => m.startChallenge(canvas));
} else {
  // A throw during boot would otherwise leave a black page with no reason on it.
  startApp(canvas, options).catch((err) => reportBootFailure(err, { particles: options.particles }));
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
    mountFallback(document.body, cap.status === "ok" ? { ...cap, status: "device-failed" } : cap, {
      fullCount: options.particles,
      sheets: options.planes,
    });
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
    depth: options.depth,
    subpixel: options.subpixel,
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
    focusDist: () =>
      depthSprites && depthSprites.enabled !== false
        ? depthSprites.params.focusDist
        : render.computeRaster.depth && render.computeRaster.enabled !== false
          ? render.computeRaster.params.focusDist
          : camera.state.distance,
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
  const ui = mountAppHud({ app, canvas, scenes, render, budget, camera, view, options });
  mountMobileControls(ui.hud); // tap target for the Esc menu on touch screens
  const brushes = attachBrushes(canvas, view, () => sim.planes);
  // One plane ignites, then the world. Skipped with any input, ?intro=0, or ?world.
  const intro =
    options.intro && options.world === null
      ? mountIntro(canvas, camera, sim.planes, () => graph.width / Math.max(1, graph.height), {
          cameraKeys: keys.cameraTarget,
        })
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
  // Auto camera tour: C, the Esc menu or ?autocam=1; any camera input hands control back.
  const autocam = mountAutoCam({
    hud: ui.hud, canvas, camera, planes: () => sim.planes, busy: () => intro?.active, key: KEYS.autoCamera,
    cameraKeys: keys.cameraTarget, moveKeys: MOVES_CAMERA,
  });
  loop.hooks.push({ beforeCamera: (f) => autocam.step(f.dt) });
  if (streaming) loop.hooks.push({ afterCamera: (f) => streaming.tick(f.dt) });
  loop.hooks.push({ afterFrame: (f) => ui.update(f.dt) });
  loop.hooks.push({ afterFrame: (f) => hints.update(f.dt) });

  // ---- sound: off on every load; M or the Esc menu turns it on (src/audio, docs/audio.md) ----
  const sound = mountSound({
    app, hud: ui.hud, viewport: () => ({ width: graph.width, height: graph.height }), key: KEYS.sound,
  });
  loop.hooks.push({ afterFrame: (f) => sound.frame(f) });

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
    // Videos rendered while the sound is on carry it (src/audio).
    audio: (fps) => sound.recordingAudio(fps),
    keys: { screenshot: KEYS.screenshot, record: KEYS.record },
  });

  // ---- record: 1 trillion particle stills and clips via src/offline, in the menu or from ?record ----
  const record = mountRecord({ hud: ui.hud });
  // The record job has the GPU to itself: the world stops drawing while it runs.
  ui.hud.on("job", (id, running) => {
    if (id === "record") loop.offline = running;
  });
  if (options.record) setTimeout(() => record.start(), 500);

  // ---- live numbers in the Esc menu: frame pacing, GPU time per pass, particles the GPU counted (src/ux/perf-hud) ----
  // After every other loop hook: its two hooks bracket the frame, so the script time it shows covers them all.
  mountPerfHud({ hud: ui.hud, gpu, graph, sim, budget, hooks: loop.hooks });

  // ---- when the GPU fails later: device lost, or a particle count it cannot hold (src/ux/recovery) ----
  mountRecovery({
    device: gpu.device,
    scenes,
    notify: (text) => ui.hud.status(text, 8000),
    onLost: () => (loop.offline = true),
    busy: () => ui.hud.busy,
  });

  loop.start();
}
