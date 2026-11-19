/**
 * Hero compositions: hand-placed sheets and a fixed camera, for stills and
 * short clips at record scale.
 *
 *   heroA  close: four sheets fill the frame, one seen exactly edge-on as a
 *          thin line of light
 *   heroB  cathedral: a tall stack of floors crossed by two vertical sheets,
 *          deep black around it
 *   heroC  inside: the camera sits inside a cloud of sheets, depth in every
 *          direction
 *
 * A sheet can hold any number of particles. Past 2^32 it is split into
 * layers: planes with the same transform, law and params, each with its own
 * seed. Additive accumulation makes the layers one sheet with the summed
 * count, and every particle still has a unique identity.
 */
import type { Quat, Vec2, Vec3 } from "../../core/contracts";
import type { CameraKey, LawId, OfflineJob, OfflinePlane } from "./job";
import { pcg } from "./laws";
import { add, cameraBasis, dot, quatFromAxisAngle, quatMul, scale, sub } from "./math";
import { lawParams, randomRotation, rng, type ClusterOptions } from "./world";

/** Most particles one plane (layer) may hold. */
const LAYER_MAX = 3_900_000_000;

interface Sheet {
  position: Vec3;
  rotation: Quat;
  halfSize: Vec2;
  law: LawId;
  params: number[];
  /** Share of the world's particles on this sheet. Normalized over all sheets. */
  share: number;
}

const normalize = (v: Vec3): Vec3 => scale(v, 1 / Math.hypot(v[0], v[1], v[2]));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Rotation whose local X, Y, Z axes are the given orthonormal vectors. */
function quatFromAxes(x: Vec3, y: Vec3, z: Vec3): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return q;
}

const rotX = (a: number): Quat => quatFromAxisAngle([1, 0, 0], a);
const rotY = (a: number): Quat => quatFromAxisAngle([0, 1, 0], a);
const rotZ = (a: number): Quat => quatFromAxisAngle([0, 0, 1], a);

function buildJob(
  o: ClusterOptions,
  sheets: Sheet[],
  camera: Omit<CameraKey, "t">,
  look: { fluxRef: number; near: number; drift: number },
): OfflineJob {
  const seed = o.seed ?? 1;
  const totalShare = sheets.reduce((s, x) => s + x.share, 0);
  const planes: OfflinePlane[] = [];
  let assigned = 0;
  sheets.forEach((sheet, si) => {
    const count = si === sheets.length - 1 ? o.particles - assigned : Math.round((o.particles * sheet.share) / totalShare);
    assigned += count;
    const layers = Math.max(1, Math.ceil(count / LAYER_MAX));
    const base = Math.floor(count / layers);
    for (let l = 0; l < layers; l++) {
      planes.push({
        position: sheet.position,
        rotation: sheet.rotation,
        halfSize: sheet.halfSize,
        law: sheet.law,
        // pcg is a bijection, so distinct plane numbers give distinct seeds.
        seed: pcg((Math.imul(seed, 0x85ebca6b) + planes.length) >>> 0),
        particleCount: base + (l < count - base * layers ? 1 : 0),
        params: sheet.params,
      });
    }
  });
  // A still has one key. A clip drifts a little around it.
  const keys: CameraKey[] =
    o.frames > 1
      ? [
          { ...camera, t: 0, yaw: camera.yaw - look.drift / 2 },
          { ...camera, t: 1, yaw: camera.yaw + look.drift / 2 },
        ]
      : [{ ...camera, t: 0 }];
  return {
    version: 1,
    name: o.name,
    width: o.width,
    height: o.height,
    fps: o.fps,
    frames: o.frames,
    timeScale: o.timeScale ?? 1,
    timeOffset: 40,
    ssaa: o.ssaa ?? 1,
    splat: o.splat ?? "point",
    weighting: o.weighting ?? "flux",
    fluxRef: look.fluxRef,
    shutter: o.shutter ?? 0.5,
    near: look.near,
    planes,
    camera: keys,
  };
}

/** Params from the world generator, with a few fixed for a known look. */
function params(law: LawId, r: () => number, fixed: Record<number, number> = {}): number[] {
  const p = lawParams(law, r);
  for (const [i, v] of Object.entries(fixed)) p[Number(i)] = v;
  return p;
}

function heroA(o: ClusterOptions): OfflineJob {
  const r = rng(o.seed ?? 1);
  const fovY = (40 * Math.PI) / 180;
  const camera = { target: [0.3, 0, -1.5] as Vec3, yaw: 0.12, pitch: -0.08, distance: 7, fovY };
  const cam = cameraBasis(camera);
  // The edge-on sheet: its plane contains the eye, so it projects to a line,
  // drawn along a steep diagonal of the screen.
  const center: Vec3 = [0.5, -0.1, -1.6];
  const toSheet = normalize(sub(center, cam.eye));
  const along = normalize(add(scale(cam.right, Math.cos(1.15)), scale(cam.up, Math.sin(1.15))));
  const normal = normalize(cross(toSheet, along));
  const inPlane = normalize(cross(normal, toSheet));
  const edgeOn = quatFromAxes(toSheet, inPlane, normal);
  // Sanity: the eye lies in the edge-on sheet's plane.
  if (Math.abs(dot(sub(cam.eye, center), normal)) > 1e-9) throw new Error("edge-on sheet is not edge-on");
  const sheets: Sheet[] = [
    { position: [-1.5, 0.35, -0.6], rotation: quatMul(rotX(-0.55), rotZ(0.4)), halfSize: [2.4, 2.4], law: "kepler", params: params("kepler", r, { 0: 0.3, 1: 3.4, 2: 0.03, 3: 1.1, 4: 0.03, 5: 0.2, 6: 0.03 }), share: 34 },
    { position: [2.7, -0.7, -2.6], rotation: quatMul(rotY(0.65), rotX(0.25)), halfSize: [2, 2], law: "vortex", params: params("vortex", r, { 0: 16, 1: 0.55, 2: 0.35, 3: 0.2 }), share: 22 },
    { position: [2.2, 1.6, -5], rotation: quatMul(rotX(0.35), rotY(-0.3)), halfSize: [1.9, 1.9], law: "lissajous", params: params("lissajous", r, { 0: 3, 1: 2, 2: 9 }), share: 16 },
    { position: center, rotation: edgeOn, halfSize: [3.6, 3.6], law: "kepler", params: params("kepler", r, { 0: 0.2, 1: -2.5 }), share: 28 },
  ];
  return buildJob(o, sheets, camera, { fluxRef: 6, near: 0.01, drift: 0.04 });
}

function heroB(o: ClusterOptions): OfflineJob {
  const r = rng((o.seed ?? 1) + 7);
  const fovY = (34 * Math.PI) / 180;
  const floors = 15;
  const spacing = 0.55;
  const sheets: Sheet[] = [];
  for (let i = 0; i < floors; i++) {
    const y = (i - (floors - 1) / 2) * spacing;
    // A spire: floors narrow toward the top.
    const half = 2.7 - 1.3 * (i / (floors - 1));
    const law: LawId = i % 5 === 2 ? "vortex" : i % 5 === 4 ? "lissajous" : "kepler";
    sheets.push({
      position: [0, y, 0],
      // Horizontal: the sheet's normal points up. A slow twist floor to floor.
      rotation: quatMul(rotY(i * 0.21), rotX(-Math.PI / 2)),
      halfSize: [half, half],
      law,
      params: params(law, r),
      share: half * half,
    });
  }
  // Two vertical sheets through the axis, like the walls of a nave.
  for (const a of [0.35, 0.35 + Math.PI / 2]) {
    sheets.push({ position: [0, 0, 0], rotation: rotY(a), halfSize: [2.2, 4.4], law: "vortex", params: params("vortex", r, { 0: 22, 1: 0.35 }), share: 2.2 });
  }
  const camera = { target: [0, 0.2, 0] as Vec3, yaw: 0.55, pitch: -0.16, distance: 19, fovY };
  return buildJob(o, sheets, camera, { fluxRef: 17, near: 0.01, drift: 0.12 });
}

function heroC(o: ClusterOptions): OfflineJob {
  const r = rng((o.seed ?? 1) + 13);
  const fovY = (72 * Math.PI) / 180;
  const eye: Vec3 = [0, 0, 0];
  const sheets: Sheet[] = [];
  while (sheets.length < 72) {
    // Uniform in a ball of radius 14, kept clear of the eye.
    const p: Vec3 = [r() * 2 - 1, (r() * 2 - 1) * 0.7, r() * 2 - 1];
    const d = Math.hypot(p[0], p[1], p[2]);
    if (d > 1 || d < 0.12) continue;
    const position = scale(p, 14);
    const dist = Math.hypot(...sub(position, eye));
    const half = 0.8 + 2.2 * r() * r();
    if (dist < half * 1.4) continue;
    const pick = r();
    const law: LawId = pick < 0.55 ? "kepler" : pick < 0.8 ? "vortex" : "lissajous";
    sheets.push({ position, rotation: randomRotation(r), halfSize: [half, half], law, params: params(law, r), share: half * half });
  }
  // The camera orbits its target at a tiny distance, so the eye sits at the origin.
  const camera = { target: [0, 0, -0.01] as Vec3, yaw: 0.3, pitch: 0.05, distance: 0.01, fovY };
  return buildJob(o, sheets, camera, { fluxRef: 3, near: 0.02, drift: 0.25 });
}

const STILL = { width: 3840, height: 2160, fps: 30, frames: 1, particles: 1_000_000_000_000, planes: 0 };

export interface Composition {
  defaults: ClusterOptions;
  build(o: ClusterOptions): OfflineJob;
}

/** Named compositions. `planes` in the options is ignored: layout decides it. */
export const COMPOSITIONS: Record<string, Composition> = {
  heroA: { defaults: { ...STILL, name: "heroA" }, build: heroA },
  heroB: { defaults: { ...STILL, name: "heroB" }, build: heroB },
  heroC: { defaults: { ...STILL, name: "heroC" }, build: heroC },
};
