import { createKeyRouter } from "./app/keys";
import { mountCapture } from "./capture/app";
import { behaviors, getBehavior } from "./behaviors";
import { measurePlanes, VisibleOnlyBudget } from "./core/budget";
import { TOKENS, type AppContext, type ParticleBudget, type Scene } from "./core/contracts";
import { FrameGraph } from "./core/frameGraph";
import { initGpu, writeGlobals } from "./gpu/context";
import { createPasses } from "./passes";
import { createAtomicRasterPass } from "./perf/atomicRasterPass";
import { PerfBudget } from "./perf/budget";
import { Simulation } from "./sim/simulation";
import { mountPanels } from "./ui";
import { attachCameraInput, createCamera, planeTargetFromDesc, poseFromState } from "./ux/camera";
import { formatCount } from "./ux/hud/index.js";
import { mountHud } from "./ux/hud/wire";
import { scatterLayout, scatterRadius } from "./world/layout";

// URL options:
//   ?particles=4000000&planes=48&behaviors=flow,galaxy&brightness=0.2&seed=1
//   &raster=points   draw with the point-list pass instead of the compute rasterizer
//   &adaptive=1      thin planes to hold the frame rate
//   &fps=60          frame rate the adaptive budget aims for
const query = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = Number(query.get(key));
  return query.has(key) && Number.isFinite(v) && v > 0 ? v : fallback;
};

const MIN_PARTICLES = 10_000;
const MAX_PARTICLES = 200_000_000;

function buildScene(particles: number, planes: number, brightness: number): Scene {
  const seed = Math.round(num("seed", 1));
  const ids = query.get("behaviors")?.split(",") ?? behaviors.map((b) => b.id);
  ids.forEach(getBehavior); // fail early on a typo
  return {
    version: 1,
    seed,
    planes: scatterLayout({ planes, totalParticles: particles, behaviorIds: ids, seed }),
    camera: { target: [0, 0, 0], yaw: 0.6, pitch: -0.35, distance: 2.2 * scatterRadius(planes), fovY: (50 * Math.PI) / 180 },
    render: { brightness },
  };
}

/** Centered text for the one case with nothing else to show: no WebGPU. */
function showMessage(text: string): void {
  const el = document.createElement("div");
  el.textContent = text;
  Object.assign(el.style, {
    position: "fixed", inset: "0", display: "grid", placeItems: "center", textAlign: "center",
    whiteSpace: "pre-line", pointerEvents: "none", font: TOKENS.font, letterSpacing: TOKENS.letterSpacing,
    color: TOKENS.color.foreground, opacity: String(TOKENS.opacityDim),
  });
  document.body.appendChild(el);
}

async function start(): Promise<void> {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;

  let gpu;
  try {
    gpu = await initGpu(canvas);
  } catch (err) {
    showMessage(`${(err as Error).message}\nStrata needs a WebGPU browser (recent Chrome, Edge or Safari).`);
    return;
  }

  // ---- frame graph -------------------------------------------------------
  const sim = new Simulation(gpu);
  const graph = new FrameGraph(gpu);
  graph.add(sim, ...createPasses(gpu), createAtomicRasterPass(gpu));
  const rasterizers = graph.passes.filter((p) => p.stage === "rasterize");
  // Exactly one rasterize pass draws the particles (each one clears the HDR target).
  const setRasterizer = (name: string) => rasterizers.forEach((p) => (p.enabled = p.name === name));
  setRasterizer(query.get("raster") === "points" ? "points" : "atomic-raster");

  // ---- budget ------------------------------------------------------------
  const fullBudget = new VisibleOnlyBudget();
  const adaptiveBudget = new PerfBudget();
  let budget: ParticleBudget = query.get("adaptive") === "1" ? adaptiveBudget : fullBudget;
  let targetFps = num("fps", 60);

  // ---- camera ------------------------------------------------------------
  const keys = createKeyRouter();
  const camera = createCamera();
  attachCameraInput(canvas, camera.rig, { keyTarget: keys.cameraTarget });

  // ---- scene -------------------------------------------------------------
  let particles = Math.round(num("particles", 2_000_000));
  let planeCount = Math.round(num("planes", 32));
  let total = 0;
  let scene = buildScene(particles, planeCount, num("brightness", 0.2));
  /** Camera of the last scene handed out, to tell "same camera" from "move the camera". */
  let handedOut = "";

  const loadScene = (next: Scene) => {
    scene = next;
    sim.setPlanes(scene.planes);
    total = sim.planes.reduce((n, p) => n + p.capacity, 0);
    camera.rig.setPlanes(scene.planes.map(planeTargetFromDesc));
    // A scene that came from getScene() (a dice roll, a param edit) keeps the camera exactly
    // where it is, drift and inertia included. Only a scene with a new camera moves it.
    if (JSON.stringify(scene.camera) !== handedOut) {
      camera.state = structuredClone(scene.camera);
      camera.rig.setHome(poseFromState(scene.camera));
    }
  };
  const getScene = (): Scene => {
    const cam = camera.snapshot();
    handedOut = JSON.stringify(cam);
    return { ...scene, camera: cam };
  };
  loadScene(scene);

  // ---- stats -------------------------------------------------------------
  let fps = 0;
  let fpsFrames = 0;
  let fpsSince = performance.now();

  const app: AppContext = {
    gpu,
    camera,
    behaviors,
    passes: graph.passes,
    get planes() {
      return sim.planes;
    },
    getScene,
    loadScene,
    addPlane: (desc) => {
      const plane = sim.addPlane(desc);
      total += plane.capacity;
      return plane;
    },
    removePlane: (plane) => {
      if (!sim.planes.includes(plane)) return;
      total -= plane.capacity;
      sim.removePlane(plane);
    },
    updatePlane: (plane) => sim.updatePlane(plane),
    setPlaneBehavior: (plane, change) => sim.setBehavior(plane, change),
    stats: () => ({
      fps,
      particles: sim.planes.reduce((n, p) => n + p.activeCount, 0),
      planes: sim.planes.length,
    }),
  };
  mountPanels(app);
  // Handy for poking at the engine from the console.
  (window as unknown as { strata: AppContext }).strata = app;

  // ---- HUD: dice, stats on H, settings on Esc ----------------------------
  const { hud, update: updateHud } = mountHud(app, { hud: { persist: false, autoFps: false } });
  hud.defineStat("total", { label: "total", format: formatCount });

  /** Rebuild the layout for a new particle or plane count, keeping the camera and brightness. */
  const rebuild = () => {
    const keep = getScene();
    const fresh = buildScene(particles, planeCount, keep.render.brightness);
    loadScene(fresh.planes.length === keep.planes.length ? { ...fresh, camera: keep.camera } : fresh);
  };

  const particlesParam = hud.registerParam({
    id: "particles", type: "range", scale: "log", live: false,
    min: MIN_PARTICLES, max: MAX_PARTICLES, value: particles, format: formatCount,
    onChange: (v) => {
      particles = Math.round(v);
      rebuild();
    },
  });
  hud.registerParam({
    id: "planes", type: "range", live: false, min: 1, max: 256, step: 1, value: planeCount,
    onChange: (v) => {
      planeCount = Math.round(v);
      rebuild();
    },
  });
  const brightnessParam = hud.registerParam({
    id: "brightness", type: "range", scale: "log", min: 0.005, max: 5, value: scene.render.brightness,
    onChange: (v) => (scene.render.brightness = v),
  });
  hud.registerParam({
    id: "rasterizer", type: "select", group: "performance",
    value: rasterizers.find((p) => p.enabled !== false)?.name,
    options: [
      { value: "atomic-raster", label: "compute" },
      { value: "points", label: "points" },
    ],
    onChange: setRasterizer,
  });
  hud.registerParam({
    id: "adaptive", label: "hold frame rate", type: "toggle", group: "performance", value: budget === adaptiveBudget,
    onChange: (on) => (budget = on ? adaptiveBudget : fullBudget),
  });
  hud.registerParam({
    id: "targetFps", label: "target fps", type: "range", group: "performance", min: 24, max: 240, step: 1, value: targetFps,
    onChange: (v) => (targetFps = v),
  });

  const scaleParticles = (factor: number) =>
    particlesParam.set(Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, particles * factor)));
  const scaleBrightness = (factor: number) => brightnessParam.set(scene.render.brightness * factor);
  hud.registerShortcut({ key: "]", label: "double particles", run: () => scaleParticles(2) });
  hud.registerShortcut({ key: "[", label: "halve particles", run: () => scaleParticles(0.5) });
  hud.registerShortcut({ key: "=", label: "brighter", run: () => scaleBrightness(1.25) });
  hud.registerShortcut({ key: "-", label: "dimmer", run: () => scaleBrightness(0.8) });
  hud.registerShortcut({ key: "g", label: "go to nearest plane", run: () => camera.rig.focusNearest() });

  // ---- frame loop --------------------------------------------------------
  let last = performance.now();
  let time = 0;
  let frame = 0;

  /** True while an offline render owns the loop: the realtime tick stops drawing. */
  let offline = false;

  /** Simulate and draw one frame, `dt` seconds after the previous one. */
  const renderFrame = (dt: number) => {
    time += dt;
    graph.resize();
    adaptiveBudget.setViewport(graph.width, graph.height);
    camera.update(dt);
    const viewProj = camera.viewProjection(graph.width / graph.height);
    writeGlobals(gpu, { viewProj, time, dt, frame, brightness: scene.render.brightness });

    // Offline renders are not in a hurry, so they always draw every particle.
    const counts = (offline ? fullBudget : budget).allocate({
      planes: measurePlanes(sim.planes, camera, viewProj),
      fps: fps || targetFps,
      targetFps,
    });
    sim.planes.forEach((plane, i) => (plane.activeCount = counts[i]));

    graph.run({ planes: sim.planes, camera, time, dt, frame });
    frame++;

    updateHud(dt);
    hud.setStat("total", total);
  };

  // ---- capture: P screenshot, V record, stills and offline video in the menu ----
  mountCapture({
    canvas,
    hud,
    maxTextureSize: gpu.device.limits.maxTextureDimension2D,
    addPass: (pass) => graph.add(pass),
    frame: renderFrame,
    flush: () => gpu.device.queue.onSubmittedWorkDone(),
    setOffline: (on) => (offline = on),
    setResolution: (size) => (graph.fixedSize = size),
  });

  const tick = (now: number) => {
    // Clamp dt so a background tab or a hitch does not explode the simulation.
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;

    fpsFrames++;
    if (now - fpsSince >= 250) {
      fps = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0;
      fpsSince = now;
    }

    if (!offline) renderFrame(dt);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

start();
