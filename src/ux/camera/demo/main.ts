/**
 * Standalone camera demo. No engine and no WebGPU: stand-in sheets of dots
 * are drawn on the CPU with the camera's own view-projection matrix, so the
 * feel of moving through the void can be judged and tuned on any browser.
 *
 *   npm run dev, then open /src/ux/camera/demo/
 *
 * URL options: ?tour=1 (idle tour), ?free=1 (trackball), ?sheets=40, ?dots=3000
 */

import { TOKENS } from "../../../core/contracts";
import type { PlaneDesc, Vec3 } from "../../../core/contracts";
import { attachCameraInput, createCamera, planeTargetFromDesc } from "../index";
import { quatFromAxisAngle, quatMul, quatRotate } from "../math";

const query = new URLSearchParams(location.search);
const SHEETS = Math.max(1, Number(query.get("sheets") ?? 28));
const DOTS = Math.max(1, Number(query.get("dots") ?? 2600));

// ---- a small deterministic world ----------------------------------------------

let seed = 0x9e3779b9;
const random = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1e6) / 1e6;
};

const planes: PlaneDesc[] = [];
for (let i = 0; i < SHEETS; i++) {
  const kind = i % 4;
  let rotation = quatFromAxisAngle([0, 1, 0], 0);
  let position: Vec3;
  if (kind === 0) {
    // A stack of parallel sheets receding in depth.
    position = [0, 0, -i * 1.5];
  } else if (kind === 1) {
    // A ring of sheets facing the center.
    const a = (i / SHEETS) * Math.PI * 2;
    position = [Math.sin(a) * 26, (random() - 0.5) * 8, Math.cos(a) * 26 - 20];
    rotation = quatFromAxisAngle([0, 1, 0], a + Math.PI);
  } else if (kind === 2) {
    // Floors and ceilings.
    position = [(random() - 0.5) * 50, (random() < 0.5 ? -1 : 1) * (8 + random() * 10), (random() - 0.5) * 50 - 20];
    rotation = quatFromAxisAngle([1, 0, 0], -Math.PI / 2);
  } else {
    // Loose, tilted sheets.
    position = [(random() - 0.5) * 70, (random() - 0.5) * 30, (random() - 0.5) * 70 - 20];
    rotation = quatMul(
      quatFromAxisAngle([0, 1, 0], random() * Math.PI * 2),
      quatFromAxisAngle([1, 0, 0], (random() - 0.5) * 1.2),
    );
  }
  planes.push({
    id: `sheet-${i}`,
    position,
    rotation,
    halfSize: [4 + random() * 4, 3 + random() * 3],
    behaviorId: ["swirl", "wave", "rings", "drift"][i % 4],
    particleCount: DOTS,
    seed: random(),
  });
}

// Per-dot constants: two random numbers each.
const dotSeeds = new Float32Array(SHEETS * DOTS * 2);
for (let i = 0; i < dotSeeds.length; i++) dotSeeds[i] = random();

/** Stand-in "behaviors": cheap closed-form motion in sheet space [-1, 1]^2. */
const dot = (behavior: string, a: number, b: number, t: number, out: Float32Array): void => {
  switch (behavior) {
    case "swirl": {
      const r = Math.sqrt(a);
      const ang = b * 6.2832 + t * (0.6 / (0.15 + r));
      out[0] = Math.cos(ang) * r;
      out[1] = Math.sin(ang) * r;
      return;
    }
    case "wave": {
      const x = a * 2 - 1;
      out[0] = x;
      out[1] = Math.sin(x * 5 + t * 1.3 + Math.floor(b * 7)) * 0.18 + (Math.floor(b * 7) / 3 - 1) * 0.8 + (b * 7 % 1 - 0.5) * 0.04;
      return;
    }
    case "rings": {
      const ring = (Math.floor(a * 6) + ((t * 0.08) % 1)) / 6;
      const ang = b * 6.2832 + ring * 3;
      out[0] = Math.cos(ang) * ring;
      out[1] = Math.sin(ang) * ring;
      return;
    }
    default: {
      out[0] = ((a + t * 0.03 * (0.3 + b)) % 1) * 2 - 1;
      out[1] = b * 2 - 1 + Math.sin(t * 0.7 + a * 20) * 0.03;
    }
  }
};

// ---- camera ---------------------------------------------------------------------

const canvas = document.getElementById("c") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;
const help = document.getElementById("help") as HTMLElement;
for (const el of [hud, help]) {
  el.style.font = TOKENS.font;
  el.style.letterSpacing = TOKENS.letterSpacing;
  el.style.opacity = String(TOKENS.opacityDim);
}
help.textContent =
  "drag orbit   right-drag pan   wheel zoom   double-click focus\n" +
  "WASD QE fly   F nearest   , . prev next   H home   space drift";

const camera = createCamera(
  { target: [0, 0, -20], yaw: 0.6, pitch: 0.3, distance: 70, fovY: (50 * Math.PI) / 180 },
  {
    upMode: query.get("free") ? "free" : "turntable",
    bounds: { center: [0, 0, -20], radius: 120 },
    maxDistance: 400,
    idle: { tour: query.get("tour") !== null },
  },
);
const rig = camera.rig;
rig.setPlanes(planes.map(planeTargetFromDesc));
attachCameraInput(canvas, rig);
canvas.focus();

// For poking at it from the console, and for automated checks.
(window as unknown as { strataCamera: unknown }).strataCamera = camera;

// ---- drawing ----------------------------------------------------------------------

const ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
let image = ctx.createImageData(1, 1);
let light = new Uint16Array(1);
let width = 1;
let height = 1;

const resize = (): void => {
  const scale = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, Math.round(canvas.clientWidth * scale));
  const h = Math.max(1, Math.round(canvas.clientHeight * scale));
  if (w === width && h === height) return;
  width = canvas.width = w;
  height = canvas.height = h;
  image = ctx.createImageData(w, h);
  light = new Uint16Array(w * h);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
};

const local = new Float32Array(2);
let last = performance.now();
let fps = 60;

const frame = (now: number): void => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  resize();

  camera.update(dt);
  const m = camera.viewProjection(width / height);
  const t = now / 1000;
  light.fill(0);

  for (let s = 0; s < planes.length; s++) {
    const p = planes[s];
    const right = quatRotate(p.rotation, [p.halfSize[0], 0, 0]);
    const up = quatRotate(p.rotation, [0, p.halfSize[1], 0]);
    const c = p.position;
    // Clip position is affine in sheet coordinates: clip = C + x * R + y * U.
    const cx = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
    const cy = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
    const cw = m[3] * c[0] + m[7] * c[1] + m[11] * c[2] + m[15];
    const rx = m[0] * right[0] + m[4] * right[1] + m[8] * right[2];
    const ry = m[1] * right[0] + m[5] * right[1] + m[9] * right[2];
    const rw = m[3] * right[0] + m[7] * right[1] + m[11] * right[2];
    const ux = m[0] * up[0] + m[4] * up[1] + m[8] * up[2];
    const uy = m[1] * up[0] + m[5] * up[1] + m[9] * up[2];
    const uw = m[3] * up[0] + m[7] * up[1] + m[11] * up[2];
    const base = s * DOTS * 2;
    for (let i = 0; i < DOTS; i++) {
      dot(p.behaviorId, dotSeeds[base + i * 2], dotSeeds[base + i * 2 + 1], t + p.seed * 100, local);
      const w = cw + local[0] * rw + local[1] * uw;
      if (w <= 0.05) continue;
      const x = ((cx + local[0] * rx + local[1] * ux) / w * 0.5 + 0.5) * width;
      const y = (0.5 - (cy + local[0] * ry + local[1] * uy) / w * 0.5) * height;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      light[(y | 0) * width + (x | 0)] += 90;
    }
  }

  const data = image.data;
  for (let i = 0, j = 0; i < light.length; i++, j += 4) {
    const v = light[i];
    data[j] = data[j + 1] = data[j + 2] = v > 255 ? 255 : v;
  }
  ctx.putImageData(image, 0, 0);

  const focused = rig.focused;
  hud.textContent =
    `${fps.toFixed(0)} fps   ${planes.length} sheets   ${(planes.length * DOTS / 1000).toFixed(0)}k dots\n` +
    `${rig.mode}${rig.isTransitioning ? "   flying" : ""}${focused ? `   on ${focused.id}` : ""}` +
    `${rig.idleAmount > 0 ? `   drifting ${(rig.idleAmount * 100).toFixed(0)}%` : ""}`;
  // The interface gets out of the way while the camera drifts on its own.
  help.style.opacity = String(TOKENS.opacityDim * (1 - rig.idleAmount));

  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
