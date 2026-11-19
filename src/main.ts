import { behaviors, getBehavior } from "./behaviors";
import { OrbitCamera } from "./camera";
import { measurePlanes, VisibleOnlyBudget } from "./core/budget";
import type { AppContext, ParticleBudget, Scene } from "./core/contracts";
import { FrameGraph } from "./core/frameGraph";
import { initGpu, writeGlobals } from "./gpu/context";
import { Overlay } from "./overlay";
import { createPasses } from "./passes";
import { Simulation } from "./sim/simulation";
import { mountPanels } from "./ui";
import { scatterLayout, scatterRadius } from "./world/layout";

// URL options: ?particles=4000000&planes=48&behaviors=flow,galaxy&brightness=0.2&seed=1
const query = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = Number(query.get(key));
  return query.has(key) && Number.isFinite(v) && v > 0 ? v : fallback;
};

function defaultScene(particles: number): Scene {
  const planes = Math.round(num("planes", 32));
  const seed = Math.round(num("seed", 1));
  const ids = query.get("behaviors")?.split(",") ?? behaviors.map((b) => b.id);
  ids.forEach(getBehavior); // fail early on a typo
  return {
    version: 1,
    seed,
    planes: scatterLayout({ planes, totalParticles: particles, behaviorIds: ids, seed }),
    camera: { target: [0, 0, 0], yaw: 0.6, pitch: 0.35, distance: 2.2 * scatterRadius(planes), fovY: (50 * Math.PI) / 180 },
    render: { brightness: num("brightness", 0.2) },
  };
}

async function start(): Promise<void> {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const overlay = new Overlay(document.getElementById("overlay")!);

  let gpu;
  try {
    gpu = await initGpu(canvas);
  } catch (err) {
    overlay.message(`${(err as Error).message}\nStrata needs a WebGPU browser (recent Chrome, Edge or Safari).`);
    return;
  }

  const sim = new Simulation(gpu);
  const graph = new FrameGraph(gpu);
  graph.add(sim, ...createPasses(gpu));
  const camera = new OrbitCamera(canvas);
  const budget: ParticleBudget = new VisibleOnlyBudget();

  let total = 0;
  let scene = defaultScene(Math.round(num("particles", 2_000_000)));
  const loadScene = (next: Scene) => {
    scene = next;
    sim.setPlanes(scene.planes);
    total = sim.planes.reduce((n, p) => n + p.capacity, 0);
    camera.state = structuredClone(scene.camera);
  };
  loadScene(scene);

  const app: AppContext = {
    gpu,
    camera,
    behaviors,
    passes: graph.passes,
    get planes() {
      return sim.planes;
    },
    getScene: () => ({ ...scene, camera: structuredClone(camera.state) }),
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
      fps: overlay.fps,
      particles: sim.planes.reduce((n, p) => n + p.activeCount, 0),
      planes: sim.planes.length,
    }),
  };
  mountPanels(app);
  // Handy for poking at the engine from the console.
  (window as unknown as { strata: AppContext }).strata = app;

  // [ and ] halve / double the particle count, - and = change brightness.
  window.addEventListener("keydown", (e) => {
    if (e.key === "[" || e.key === "]") {
      const factor = e.key === "]" ? 2 : 0.5;
      const cam = structuredClone(camera.state);
      loadScene({
        ...scene,
        planes: scene.planes.map((p) => ({ ...p, particleCount: Math.max(1, Math.round(p.particleCount * factor)) })),
      });
      camera.state = cam;
    } else if (e.key === "-" || e.key === "=") {
      scene.render.brightness *= e.key === "=" ? 1.25 : 0.8;
    }
  });

  let last = performance.now();
  let time = 0;
  let frame = 0;

  const tick = (now: number) => {
    // Clamp dt so a background tab or a hitch does not explode the simulation.
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    time += dt;

    graph.resize();
    camera.update(dt);
    const viewProj = camera.viewProjection(graph.width / graph.height);
    writeGlobals(gpu, { viewProj, time, dt, frame, brightness: scene.render.brightness });

    const counts = budget.allocate({
      planes: measurePlanes(sim.planes, camera, viewProj),
      fps: overlay.fps || 60,
      targetFps: 60,
    });
    sim.planes.forEach((plane, i) => (plane.activeCount = counts[i]));

    graph.run({ planes: sim.planes, camera, time, dt, frame });
    frame++;

    const stats = app.stats();
    overlay.tick(total, stats.particles, stats.planes);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

start();
