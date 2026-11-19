/**
 * Auto camera demo with no WebGPU: sheets from the app's scatter layout drawn
 * as dot clouds on a 2D canvas, and the director flying the shared camera rig.
 * C toggles the tour (on at load); any drag, wheel or camera key takes over.
 *   npm run dev, then open /src/ux/autocam/demo/   (?planes=64&seed=3)
 */
import { attachCameraInput, CameraRig } from "../../camera";
import { mat4TransformPoint } from "../../camera/math";
import type { Vec3 } from "../../camera/math";
import { seededRandom } from "../../../math";
import { scatterLayout, scatterRadius } from "../../../world/layout";
import type { PlaneInstance } from "../../../core/contracts";
import { AutoCamDirector } from "../director";
import { sheetsFrom } from "../shots";

const q = new URLSearchParams(location.search);
const planes = Number(q.get("planes")) || 32;
const seed = Number(q.get("seed")) || 1;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const ctx2d = canvas.getContext("2d")!;

const descs = scatterLayout({ planes, totalParticles: planes * 1e6, behaviorIds: ["a", "b", "c", "d"], seed });
// Only desc and capacity are read by sheetsFrom; uneven capacity gives the director favourites.
const instances = descs.map((desc, i) => ({ desc, capacity: desc.particleCount * (1 + (i % 5)), activeCount: 0 })) as unknown as PlaneInstance[];
const sheets = sheetsFrom(instances);

// A few hundred dots per sheet, more on brighter sheets.
const random = seededRandom(seed);
const dots: Vec3[] = [];
for (const s of sheets) {
  const n = Math.round(150 * (s.weight / 1e6));
  for (let i = 0; i < n; i++) {
    const u = (random() * 2 - 1) * s.hw;
    const v = (random() * 2 - 1) * s.hh;
    dots.push([s.center[0] + s.right[0] * u + s.up[0] * v, s.center[1] + s.right[1] * u + s.up[1] * v, s.center[2] + s.right[2] * u + s.up[2] * v]);
  }
}

const rig = new CameraRig({ initial: { target: [0, 0, 0], distance: 2.2 * scatterRadius(planes) } });
attachCameraInput(canvas, rig);
const director = new AutoCamDirector({ seed });
let on = true;

const takeOver = () => {
  on = false;
  director.stop();
};
canvas.addEventListener("pointerdown", takeOver);
canvas.addEventListener("wheel", takeOver, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyC") {
    on = !on;
    if (!on) director.stop();
  } else if (!e.code.startsWith("Shift")) takeOver();
});

let last = performance.now();
const frame = (now: number) => {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  rig.setViewport(w, h);
  if (on) {
    if (!director.active) director.start(rig.getPose());
    const pose = director.step(dt, () => ({ sheets, fovY: rig.options.fovY, aspect: w / h }));
    if (pose) rig.steer(pose, 1);
  }
  rig.update(dt);

  ctx2d.fillStyle = "#000";
  ctx2d.fillRect(0, 0, w, h);
  ctx2d.globalCompositeOperation = "lighter";
  ctx2d.fillStyle = "rgba(255,255,255,0.35)";
  const m = rig.viewProjection;
  const px = Math.max(1, devicePixelRatio);
  for (const d of dots) {
    // Behind the eye: w <= 0 flips the projection, skip.
    if (m[3] * d[0] + m[7] * d[1] + m[11] * d[2] + m[15] <= 0) continue;
    const p = mat4TransformPoint(m, d);
    if (p[0] < -1 || p[0] > 1 || p[1] < -1 || p[1] > 1) continue;
    ctx2d.fillRect((p[0] * 0.5 + 0.5) * w, (0.5 - p[1] * 0.5) * h, px, px);
  }
  ctx2d.globalCompositeOperation = "source-over";
  hud.textContent = `${on ? `auto camera: ${director.kind ?? "starting"}` : "you have the camera"}\nC toggles the tour; drag, wheel or keys take over`;
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
