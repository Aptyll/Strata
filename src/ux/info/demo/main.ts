// Standalone demo of the information layer. A small CPU "engine" implements the
// parts of AppContext the HUD and the layer read, with the real behaviors (their
// names and descriptions are what the layer shows), so mountHud and mountInfo run
// here exactly as they do in the app. No WebGPU needed.

import { behaviors } from "../../../behaviors";
import type { AppContext, Behavior, PlaneBehaviorChange, PlaneDesc, PlaneInstance, Scene } from "../../../core/contracts";
import { mountHud } from "../../hud/wire";
import { mountInfo, type InfoRig } from "../index";

interface DemoPlane {
  desc: PlaneDesc;
  behavior: Behavior;
  capacity: number;
  activeCount: number;
  points: Float32Array;
}

const COLS = 4;
const ROWS = 2;
const DRAW_CAP = 3000;
const byId = new Map(behaviors.map((b) => [b.id, b]));
const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let scene: Scene = {
  version: 1,
  seed: 1,
  planes: Array.from({ length: COLS * ROWS }, (_, i): PlaneDesc => ({
    position: [i % COLS, Math.floor(i / COLS), 0],
    rotation: [0, 0, 0, 1],
    halfSize: [1, 1],
    behaviorId: behaviors[i % behaviors.length].id,
    particleCount: 250_000,
    seed: (i * 0.37) % 1,
  })),
  camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5, fovY: 1 },
  render: { brightness: 0.6 },
};
let planes: DemoPlane[] = [];
/** Stand-in for the frame-rate governor: when on, every other sheet draws half its particles. */
let thin = false;
/** Stand-in for sheets out of view: when on, the bottom row rests (stored, not simulated). */
let rest = false;

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
const app = {
  behaviors,
  get planes() {
    return planes as unknown as PlaneInstance[];
  },
  getScene: () => ({ ...scene, planes: planes.map((p) => p.desc) }),
  loadScene,
  updatePlane: () => {},
  setPlaneBehavior: (plane: PlaneInstance, change: PlaneBehaviorChange) => {
    const p = plane as unknown as DemoPlane;
    p.behavior = byId.get(change.behaviorId)!;
    Object.assign(p.desc, { behaviorId: change.behaviorId, params: change.params, seed: change.seed ?? p.desc.seed });
  },
  setRender: (patch: Partial<Scene["render"]>) => {
    Object.assign(scene.render, patch);
  },
  stats: () => ({ fps, particles: planes.reduce((n, p) => n + p.activeCount, 0), planes: planes.length }),
} as unknown as AppContext;

// A stand-in camera rig: the sheets are tiles, so picking is "which tile" and a double click faces one.
const tileAt = (ndcX: number, ndcY: number): DemoPlane | null => {
  const col = Math.floor(((ndcX + 1) / 2) * COLS);
  const row = Math.floor(((1 - ndcY) / 2) * ROWS);
  return planes[row * COLS + col] ?? null;
};
let focused: DemoPlane | null = null;
const rig: InfoRig = {
  get focused() {
    return focused ? { center: focused.desc.position } : null;
  },
  pick: (x, y) => {
    const p = tileAt(x, y);
    return p ? { center: p.desc.position } : null;
  },
};
const toNdc = (e: MouseEvent): [number, number] => [(e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2];
canvas.addEventListener("dblclick", (e) => (focused = tileAt(...toNdc(e))));
// Any drag moves the camera away, which is what ends a focus in the app.
canvas.addEventListener("pointermove", (e) => {
  if (e.buttons) focused = null;
});

const ui = mountHud(app, { hud: { persist: false, stats: location.hash === "#stats" }, shareLink: false });
// As sheets out of view do: stored, not simulated.
ui.hud.registerParam({
  id: "rest", label: "rest the bottom row", type: "toggle", value: false, persist: false,
  onChange: (on) => (rest = on),
});
// As holding the frame rate does: half the particles simulated.
ui.hud.registerParam({
  id: "thin", label: "thin every other sheet", type: "toggle", value: false, persist: false,
  onChange: (on) => (thin = on),
});
const info = mountInfo({ hud: ui.hud, app, canvas, rig, base: "/" });
if (location.hash === "#about") info.about.open();
if (location.hash === "#keys") ui.hud.toggleHelp();
if (location.hash === "#stats") focused = planes[2];
if (location.hash === "#rest") {
  ui.hud.setParam("rest", true);
  ui.hud.showStats();
}
Object.assign(window, { ui, app, info });

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  ui.update(dt);
  planes.forEach((p, i) => {
    const resting = rest && i >= COLS;
    p.activeCount = resting ? 0 : thin && i % 2 ? Math.round(p.capacity / 2) : p.capacity;
  });

  const dpr = Math.min(devicePixelRatio, 2);
  const w = Math.round(innerWidth * dpr);
  const h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const cw = w / COLS;
  const ch = h / ROWS;
  planes.forEach((plane, n) => {
    const ox = (n % COLS) * cw;
    const oy = Math.floor(n / COLS) * ch;
    ctx.strokeStyle = plane === focused ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.12)";
    ctx.strokeRect(ox + cw * 0.06, oy + ch * 0.06, cw * 0.88, ch * 0.88);
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, scene.render.brightness)})`;
    const p = plane.points;
    const shown = (p.length / 2) * (plane.activeCount / plane.capacity);
    for (let i = 0; i < shown * 2; i += 2) {
      // A slow swirl, only so the picture is alive. The real rules run on the GPU.
      const a = now * 0.0002 * (1 + (n % 3)) + Math.hypot(p[i], p[i + 1]) * 3;
      const x = p[i] * Math.cos(a) - p[i + 1] * Math.sin(a);
      const y = p[i] * Math.sin(a) + p[i + 1] * Math.cos(a);
      ctx.fillRect(ox + (x * 0.3 + 0.5) * cw, oy + (y * 0.3 + 0.5) * ch, dpr, dpr);
    }
  });
}
requestAnimationFrame(frame);
