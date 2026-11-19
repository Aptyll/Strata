// What coming back to Strata is like, without waiting a day and without WebGPU.
//
// The HUD, the dice and src/ux/returning run here exactly as in the app. A small
// CPU "engine" stands in for the simulation, and four buttons stand in for
// time: come back tomorrow, come back today, come back after the site gained
// something, or be a first-time visitor again. Storage is kept apart from the
// app's by a prefix, so playing here never touches a real visitor record.

import type { AppContext, Behavior, PlaneBehaviorChange, PlaneDesc, PlaneInstance, Scene } from "../../../core/contracts";
import { installTokens } from "../../design";
import { mountHud } from "../../hud/wire";
import { NEWS, STORE_KEY, dayKey, dayLabel, mountReturning } from "../index";

type Rule = (p: Float32Array, i: number, params: Record<string, number>, t: number, dt: number) => void;

// Stand-in behaviors: contract-shaped metadata, plus a CPU rule in place of WGSL.
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
  rings(p, i, { count, pace }, t, dt) {
    const x = p[i], y = p[i + 1], r = Math.hypot(x, y) + 1e-3;
    const push = Math.sin(r * count * Math.PI - t * pace) * 0.4;
    p[i] += ((x / r) * push - (y / r) * 0.15) * dt;
    p[i + 1] += ((y / r) * push + (x / r) * 0.15) * dt;
  },
};
const range = (def: number, min: number, max: number) => ({ default: def, min, max, step: 0.01 });
const behaviors: Behavior[] = [
  { id: "drift", wgsl: "", params: { speed: range(0.25, 0, 1), scale: range(4, 1, 12) } },
  { id: "orbit", wgsl: "", params: { spin: range(0.5, -2, 2), pull: range(0.15, 0, 1) } },
  { id: "wave", wgsl: "", params: { freq: range(6, 1, 20), amp: range(0.6, 0, 2), speed: range(0.3, 0, 1) } },
  { id: "rings", wgsl: "", params: { count: range(3, 1, 8), pace: range(1.5, 0, 4) } },
];
const byId = new Map(behaviors.map((b) => [b.id, b]));

// ---- a CPU engine with the few AppContext members the HUD, the dice and src/ux/returning touch ----
const POINTS = 4000;
const COLS = 3;
interface DemoPlane { desc: PlaneDesc; behavior: Behavior; capacity: number; activeCount: number; points: Float32Array }

installTokens();
const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let planes: DemoPlane[] = [];
let scene: Scene = {
  version: 1,
  seed: 1,
  planes: Array.from({ length: 6 }, (_, i): PlaneDesc => ({
    position: [i % COLS, Math.floor(i / COLS), 0], rotation: [0, 0, 0, 1], halfSize: [1, 1],
    behaviorId: behaviors[i % behaviors.length].id, particleCount: 20_000, seed: (i * 0.37) % 1,
  })),
  camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5, fovY: 1 },
  render: { brightness: 0.5 },
};

function loadScene(next: Scene): void {
  scene = next;
  planes = scene.planes.map((desc) => {
    const points = new Float32Array(POINTS * 2);
    for (let i = 0; i < points.length; i++) points[i] = Math.random() * 2 - 1;
    return { desc, behavior: byId.get(desc.behaviorId)!, capacity: desc.particleCount, activeCount: desc.particleCount, points };
  });
}
loadScene(scene);

const app = {
  behaviors,
  get planes() { return planes as unknown as PlaneInstance[]; },
  // Like the real engine: the scene handed out is the live one, and rolls and sliders write into it.
  getScene: () => scene,
  loadScene,
  updatePlane: () => {}, // rules read plane.desc.params every frame, so there is nothing to upload
  // Like the real engine: a roll swaps a plane's rule in place and the points carry on from where they are.
  setPlaneBehavior(plane: PlaneInstance, change: PlaneBehaviorChange) {
    const p = plane as unknown as DemoPlane;
    p.desc.behaviorId = change.behaviorId;
    p.desc.params = change.params;
    if (change.seed !== undefined) p.desc.seed = change.seed;
    p.behavior = byId.get(change.behaviorId)!;
  },
  setRender: (patch: Partial<Scene["render"]>) => void Object.assign(scene.render, patch),
  stats: () => ({ fps: 60, particles: planes.reduce((n, p) => n + p.activeCount, 0), planes: planes.length }),
} as unknown as AppContext;

// ---- time and storage that belong to this page only -------------------------------------------
const PREFIX = "returning-demo:";
const SHIFT = `${PREFIX}days`;
const HUD_KEY = "strata.hud.returning-demo";
const storage = {
  getItem: (key: string) => localStorage.getItem(PREFIX + key),
  setItem: (key: string, value: string) => localStorage.setItem(PREFIX + key, value),
};
const shift = Number(localStorage.getItem(SHIFT)) || 0;
const now = () => new Date(Date.now() + shift * 86_400_000);

const ui = mountHud(app, { hud: { persist: HUD_KEY } });
const returning = mountReturning({
  app,
  hud: ui.hud,
  storage,
  now,
  keys: {
    today: { key: "n", label: "today's world" },
    keep: { key: "k", label: "keep this world" },
    previous: { key: "backspace", label: "previous world (shift: next)" },
  },
});
Object.assign(window, { ui, app, returning });

/** Load the plain address again, as someone typing the site's name would. */
const comeBack = (days: number): void => {
  returning.remember();
  localStorage.setItem(SHIFT, String(shift + days));
  location.href = location.pathname;
};
document.getElementById("tomorrow")!.onclick = () => comeBack(1);
document.getElementById("today")!.onclick = () => comeBack(0);
// As if every line of NEWS had been added since the last visit: they arrive two a visit, in quiet moments.
document.getElementById("update")!.onclick = () => {
  const raw = storage.getItem(STORE_KEY);
  if (raw) storage.setItem(STORE_KEY, JSON.stringify({ ...JSON.parse(raw), news: 0 }));
  comeBack(1);
};
document.getElementById("first")!.onclick = () => {
  returning.dispose(); // or leaving the page would write the record back
  for (const key of [PREFIX + STORE_KEY, PREFIX + "strata.ux.v1", SHIFT, HUD_KEY, `${HUD_KEY}.rolled`, `${HUD_KEY}.stats`]) localStorage.removeItem(key);
  location.href = location.pathname;
};

const readout = document.getElementById("readout")!;
const describe = (): string => {
  const r = returning.record;
  const a = returning.arrival;
  const why = a.kind === "untouched" ? a.reason.replace("-", " ") : a.kind === "keep" ? "the address was kept" : a.kind;
  return [
    `it is ${dayLabel(dayKey(now()))}   visit ${r.visits}, on day ${r.days}`,
    `opened on: ${why}`,
    `kept ${r.kept.length}   news told ${r.news} of ${NEWS.length}`,
    "N today's world   K keep   backspace previous   R roll",
  ].join("\n");
};

// ---- draw ---------------------------------------------------------------------------------------
let last = performance.now();
let time = 0;
let sinceReadout = 1;
function frame(t: number): void {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  time += dt;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `rgba(255,255,255,${Math.min(1, scene.render.brightness)})`;
  const rows = Math.ceil(planes.length / COLS);
  const cell = Math.min(w / COLS, h / rows) * 0.8;
  planes.forEach((plane, index) => {
    const cx = (w / COLS) * ((index % COLS) + 0.5), cy = (h / rows) * (Math.floor(index / COLS) + 0.5);
    const rule = RULES[plane.behavior.id];
    const params: Record<string, number> = {};
    for (const [name, spec] of Object.entries(plane.behavior.params)) params[name] = plane.desc.params?.[name] ?? spec.default;
    const p = plane.points;
    for (let i = 0; i < p.length; i += 2) {
      rule(p, i, params, time + plane.desc.seed * 10, dt);
      if (p[i] > 1) p[i] -= 2; else if (p[i] < -1) p[i] += 2;
      if (p[i + 1] > 1) p[i + 1] -= 2; else if (p[i + 1] < -1) p[i + 1] += 2;
      ctx.fillRect(cx + p[i] * cell * 0.5, cy + p[i + 1] * cell * 0.5, dpr, dpr);
    }
  });

  ui.update(dt);
  returning.update(dt);
  if ((sinceReadout += dt) >= 0.5) {
    sinceReadout = 0;
    readout.textContent = describe();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
