// Standalone demo of the wired HUD. A small CPU "engine" implements the parts
// of AppContext the HUD uses, so mountHud runs here exactly as it does in the
// app: same dice, same menu, same stats. No WebGPU needed.

import type { AppContext, Behavior, PlaneDesc, PlaneInstance, Scene } from "../../../core/contracts";
import { mountHud } from "../wire";

type Rule = (p: Float32Array, i: number, params: Record<string, number>, t: number, dt: number) => void;

// Three stand-in behaviors: contract-shaped metadata plus a CPU rule in place of WGSL.
const RULES: Record<string, Rule> = {
  drift(p, i, { speed, scale }, t, dt) {
    const a = Math.sin(p[i] * scale + t) * Math.cos(p[i + 1] * scale - t * 0.7) * Math.PI * 2;
    p[i] += Math.cos(a) * speed * dt;
    p[i + 1] += Math.sin(a) * speed * dt;
  },
  orbit(p, i, { spin, pull }, _t, dt) {
    const x = p[i], y = p[i + 1], r = Math.hypot(x, y) + 1e-3;
    p[i] += ((-y / r) * spin - x * pull) * dt;
    p[i + 1] += ((x / r) * spin - y * pull) * dt;
    if (r < 0.05) { p[i] = Math.random() * 2 - 1; p[i + 1] = Math.random() * 2 - 1; }
  },
  wave(p, i, { freq, amp, speed }, t, dt) {
    p[i] += speed * dt;
    p[i + 1] += Math.cos(p[i] * freq + t * 2) * amp * dt;
  },
};
const behaviors: Behavior[] = [
  { id: "drift", label: "drift", wgsl: "", params: { speed: { default: 0.25, min: 0, max: 1, step: 0.01 }, scale: { default: 4, min: 1, max: 12, step: 0.1 } } },
  { id: "orbit", label: "orbit", wgsl: "", params: { spin: { default: 0.5, min: -2, max: 2, step: 0.01 }, pull: { default: 0.15, min: 0, max: 1, step: 0.01 } } },
  { id: "wave", label: "wave", wgsl: "", params: { freq: { default: 6, min: 1, max: 20, step: 0.1 }, amp: { default: 0.6, min: 0, max: 2, step: 0.01 }, speed: { default: 0.3, min: 0, max: 1, step: 0.01 } } },
];
const byId = new Map(behaviors.map((b) => [b.id, b]));

/** Points actually drawn per plane. The stats line still reports the full count. */
const DRAW_CAP = 5000;
interface DemoPlane { desc: PlaneDesc; behavior: Behavior; capacity: number; activeCount: number; points: Float32Array }

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const COLS = 3;
let planes: DemoPlane[] = [];
let scene: Scene = {
  version: 1,
  seed: 1,
  planes: Array.from({ length: 6 }, (_, i): PlaneDesc => ({
    position: [i % COLS, Math.floor(i / COLS), 0], rotation: [0, 0, 0, 1], halfSize: [1, 1],
    behaviorId: "drift", particleCount: 20_000, seed: (i * 0.37) % 1,
  })),
  camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5, fovY: 1 },
  render: { brightness: 0.5 },
};

function loadScene(next: Scene): void {
  scene = structuredClone(next);
  planes = scene.planes.map((desc) => {
    const points = new Float32Array(Math.min(desc.particleCount, DRAW_CAP) * 2);
    for (let i = 0; i < points.length; i++) points[i] = Math.random() * 2 - 1;
    return { desc, behavior: byId.get(desc.behaviorId)!, capacity: desc.particleCount, activeCount: desc.particleCount, points };
  });
}
loadScene(scene);

let fps = 60;
// Only the members the HUD and the roll code touch. The rest of AppContext (gpu, camera, passes) is the engine's business.
const app = {
  behaviors,
  get planes() { return planes as unknown as PlaneInstance[]; },
  getScene: () => ({ ...scene, planes: planes.map((p) => p.desc) }),
  loadScene,
  updatePlane: () => {}, // rules read plane.desc.params every frame, so there is nothing to upload
  setRender: (patch: Partial<Scene["render"]>) => { Object.assign(scene.render, patch); },
  stats: () => ({ fps, particles: planes.reduce((n, p) => n + p.activeCount, 0), planes: planes.length }),
} as unknown as AppContext;

const ui = mountHud(app, { hud: { persist: "strata.hud.demo", panelOpen: location.hash === "#menu" } });
Object.assign(window, { ui, app });

let last = performance.now();
let time = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  time += dt;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  ui.update(dt);

  const dpr = Math.min(devicePixelRatio, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `rgba(255,255,255,${Math.min(1, scene.render.brightness)})`;

  const rows = Math.ceil(planes.length / COLS);
  const cw = w / COLS, ch = h / rows;
  planes.forEach((plane, n) => {
    const rule = RULES[plane.behavior.id];
    const params: Record<string, number> = {};
    for (const [name, spec] of Object.entries(plane.behavior.params)) params[name] = plane.desc.params?.[name] ?? spec.default;
    const ox = (n % COLS) * cw, oy = Math.floor(n / COLS) * ch, p = plane.points;
    for (let i = 0; i < p.length; i += 2) {
      rule(p, i, params, time + plane.desc.seed * 10, dt);
      // wrap around the sheet, which spans [-1, 1] on both axes
      if (p[i] > 1) p[i] -= 2; else if (p[i] < -1) p[i] += 2;
      if (p[i + 1] > 1) p[i + 1] -= 2; else if (p[i + 1] < -1) p[i + 1] += 2;
      ctx.fillRect(ox + (p[i] * 0.46 + 0.5) * cw, oy + (p[i + 1] * 0.46 + 0.5) * ch, dpr, dpr);
    }
  });
}
requestAnimationFrame(frame);
