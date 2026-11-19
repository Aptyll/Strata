/**
 * Dependency-free checks for the camera rig. `npm test` runs them through
 * ./camera.test.ts; to run them alone:
 *
 *   npx esbuild src/ux/camera/selftest.ts --bundle --format=esm | node --input-type=module
 *
 * The file imports nothing from Node, so it type checks under a browser-only
 * tsconfig, and it throws when a check fails.
 */

import { createCamera, orientationFromYawPitch, planeTargetFromDesc } from "./engine";
import { CameraRig } from "./rig";
import type { PlaneTarget } from "./rig";
import {
  mat4TransformPoint,
  quatAngle,
  quatFromAxisAngle,
  quatRotate,
  v3addScaled,
  v3dist,
  v3dot,
  v3len,
  v3sub,
} from "./math";
import type { Quat, Vec3 } from "./math";

let failures = 0;
let checks = 0;

const check = (name: string, ok: boolean, detail = ""): void => {
  checks++;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
};
const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;
const run = (cam: CameraRig, seconds: number, dt = 1 / 60): void => {
  for (let t = 0; t < seconds; t += dt) cam.update(dt);
};
const still = { idle: { enabled: false } };

// --- matrices ---------------------------------------------------------------
{
  const cam = new CameraRig({ ...still, near: 0.1, far: 100 });
  cam.setViewport(1600, 900);
  cam.update(1 / 60);
  const pivot: Vec3 = [0, 0, 0];
  const ndc = mat4TransformPoint(cam.viewProjection, pivot);
  check("pivot projects to screen center", near(ndc[0], 0) && near(ndc[1], 0), `${ndc}`);
  check("pivot depth inside 0..1", ndc[2] > 0 && ndc[2] < 1, `${ndc[2]}`);
  const v = mat4TransformPoint(cam.view, pivot);
  check("pivot is straight ahead at distance", near(v[2], -cam.distance, 1e-3), `${v}`);
  check("eye is distance from pivot", near(v3dist(cam.eye, pivot), 30, 1e-3));

  const nearPt = mat4TransformPoint(cam.projection, [0, 0, -0.1]);
  const farPt = mat4TransformPoint(cam.projection, [0, 0, -100]);
  check("near plane maps to depth 0", near(nearPt[2], 0, 1e-5), `${nearPt[2]}`);
  check("far plane maps to depth 1", near(farPt[2], 1, 1e-5), `${farPt[2]}`);

  const rz = new CameraRig({ ...still, near: 0.1, far: Infinity, reverseZ: true });
  rz.update(1 / 60);
  check(
    "reverse Z: near maps to depth 1",
    near(mat4TransformPoint(rz.projection, [0, 0, -0.1])[2], 1, 1e-5),
  );
  check(
    "reverse Z: far away approaches depth 0",
    mat4TransformPoint(rz.projection, [0, 0, -1e7])[2] < 1e-6,
  );

  // A point on the right edge of the pivot plane lands on NDC x = 1.
  const ray = cam.screenRay(1, 0);
  const t = cam.distance / v3dot(ray.direction, cam.forward);
  const edge: Vec3 = [
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  ];
  const edgeNdc = mat4TransformPoint(cam.viewProjection, edge);
  check("screenRay agrees with projection", near(edgeNdc[0], 1, 1e-3) && near(edgeNdc[1], 0, 1e-3), `${edgeNdc}`);
}

// --- orbit ------------------------------------------------------------------
{
  const cam = new CameraRig(still);
  cam.rotate(1.0, 0.2);
  run(cam, 2);
  check("orbit keeps distance to pivot", near(v3dist(cam.eye, [0, 0, 0]), 30, 1e-3));
  check("orbit keeps looking at pivot", near(v3dot(cam.forward, v3sub([0, 0, 0], cam.eye)) / 30, 1, 1e-4));
  check("turntable keeps horizon level", near(cam.right[1], 0, 1e-4), `${cam.right}`);

  cam.rotate(0, 10);
  run(cam, 2);
  const pitch = Math.asin(cam.forward[1]);
  check("pitch is clamped", near(pitch, (85 * Math.PI) / 180, 1e-3), `${pitch}`);
}

// --- smoothing is frame-rate independent --------------------------------------
{
  const a = new CameraRig(still);
  const b = new CameraRig(still);
  a.rotate(1, 0);
  b.rotate(1, 0);
  for (let i = 0; i < 3; i++) a.update(1 / 30);
  for (let i = 0; i < 24; i++) b.update(1 / 240);
  check("smoothing independent of frame rate", v3dist(a.eye, b.eye) < 0.05, `${v3dist(a.eye, b.eye)}`);
}

// --- inertia ----------------------------------------------------------------
{
  const cam = new CameraRig(still);
  cam.beginGesture();
  for (let i = 0; i < 20; i++) {
    cam.rotate(0.02, 0);
    cam.update(1 / 60);
  }
  cam.endGesture();
  const before = cam.getPose().orientation;
  run(cam, 0.5);
  const mid = cam.getPose().orientation;
  check("flick keeps rotating after release", quatAngle(before, mid) > 0.1, `${quatAngle(before, mid)}`);
  run(cam, 5);
  const late = cam.getPose().orientation;
  run(cam, 1);
  check("inertia comes to rest", quatAngle(late, cam.getPose().orientation) < 1e-4);

  const hold = new CameraRig(still);
  hold.beginGesture();
  for (let i = 0; i < 20; i++) {
    hold.rotate(0.02, 0);
    hold.update(1 / 60);
  }
  run(hold, 0.5); // finger rests before lifting
  hold.endGesture();
  const h0 = hold.getPose().orientation;
  run(hold, 1);
  check("stopping before release leaves no drift", quatAngle(h0, hold.getPose().orientation) < 1e-3);
}

// --- pan and zoom -------------------------------------------------------------
{
  const cam = new CameraRig(still);
  cam.setViewport(1000, 1000);
  cam.update(1 / 60);
  // Grab the world point under NDC (0.5, 0.25), drag it to the center.
  const ray = cam.screenRay(0.5, 0.25);
  const t = cam.distance / v3dot(ray.direction, cam.forward);
  const grabbed: Vec3 = [
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  ];
  cam.pan(-0.5, -0.25);
  run(cam, 2);
  const ndc = mat4TransformPoint(cam.viewProjection, grabbed);
  check("pan keeps the grabbed point under the pointer", near(ndc[0], 0, 1e-3) && near(ndc[1], 0, 1e-3), `${ndc}`);

  const z = new CameraRig(still);
  z.setViewport(1000, 1000);
  z.update(1 / 60);
  const r2 = z.screenRay(0.6, -0.4);
  const t2 = z.distance / v3dot(r2.direction, z.forward);
  const anchor: Vec3 = [
    r2.origin[0] + r2.direction[0] * t2,
    r2.origin[1] + r2.direction[1] * t2,
    r2.origin[2] + r2.direction[2] * t2,
  ];
  z.zoom(-1, 0.6, -0.4);
  run(z, 2);
  const a = mat4TransformPoint(z.viewProjection, anchor);
  check("zoom keeps the point under the pointer", near(a[0], 0.6, 1e-3) && near(a[1], -0.4, 1e-3), `${a}`);
  check("zoom scales distance", near(z.distance, 30 * Math.exp(-1), 1e-2), `${z.distance}`);

  z.zoom(-100);
  run(z, 2);
  check("zoom respects min distance", near(z.distance, z.options.minDistance, 1e-4), `${z.distance}`);
}

// --- fly ----------------------------------------------------------------------
{
  const cam = new CameraRig(still);
  cam.update(1 / 60);
  const start = cam.eye;
  const fwd = cam.forward;
  cam.setMove(0, 0, 1);
  run(cam, 1);
  const moved = v3sub(cam.eye, start);
  check("fly moves forward", v3dot(moved, fwd) > 10 && near(v3dot(moved, fwd), v3len(moved), 1e-2), `${moved}`);
  check("fly switches mode", cam.mode === "fly");
  cam.setMove(0, 0, 0);
  run(cam, 3);
  const rest = cam.eye;
  run(cam, 1);
  check("fly glides to rest", v3dist(rest, cam.eye) < 1e-3);

  // Looking around in fly mode must not move the eye.
  const e0 = cam.eye;
  cam.rotate(0.7, 0.2, "eye");
  run(cam, 2);
  check("look-around pivots on the eye", v3dist(e0, cam.eye) < 1e-2, `${v3dist(e0, cam.eye)}`);
}

// --- focus ----------------------------------------------------------------------
{
  let focusEvents = 0;
  const cam = new CameraRig({ ...still, onFocusChange: () => focusEvents++ });
  cam.setViewport(1600, 900);
  const plane: PlaneTarget = {
    id: "tilted",
    center: [40, 5, -20],
    normal: [1, 0.3, 0.2],
    width: 16,
    height: 9,
  };
  const floor: PlaneTarget = { id: "floor", center: [0, -10, 0], normal: [0, 1, 0], width: 10, height: 10 };
  cam.setPlanes([plane, floor]);
  cam.update(1 / 60);
  cam.focusPlane(plane);
  check("focus starts a transition", cam.isTransitioning);

  // The flight must be continuous: no frame-to-frame teleport.
  let maxStep = 0;
  let prev = cam.eye;
  for (let i = 0; i < 600 && cam.isTransitioning; i++) {
    cam.update(1 / 60);
    maxStep = Math.max(maxStep, v3dist(prev, cam.eye));
    prev = cam.eye;
  }
  check("focus flight finishes", !cam.isTransitioning);
  check("focus flight has no jumps", maxStep < 3, `${maxStep}`);
  check("focused plane is reported", cam.focused === plane && focusEvents === 1);

  const n = v3sub(cam.eye, plane.center);
  const nHat: Vec3 = [1, 0.3, 0.2];
  const cos = v3dot(n, nHat) / (v3len(n) * v3len(nHat));
  // The camera started behind this plane, so it should stay on that side.
  check("camera faces the plane head-on, from its own side", near(cos, -1, 1e-4), `${cos}`);

  // All four corners inside the viewport, and the plane nearly fills it.
  const right = cam.right;
  const up = cam.up;
  let maxX = 0;
  let maxY = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const c: Vec3 = [
        plane.center[0] + right[0] * sx * 8 + up[0] * sy * 4.5,
        plane.center[1] + right[1] * sx * 8 + up[1] * sy * 4.5,
        plane.center[2] + right[2] * sx * 8 + up[2] * sy * 4.5,
      ];
      const p = mat4TransformPoint(cam.viewProjection, c);
      maxX = Math.max(maxX, Math.abs(p[0]));
      maxY = Math.max(maxY, Math.abs(p[1]));
    }
  }
  check("focused plane fits the viewport", maxX < 1 && maxY < 1, `${maxX} ${maxY}`);
  check("focused plane fills most of the viewport", Math.max(maxX, maxY) > 0.85, `${maxX} ${maxY}`);

  check("pick hits the focused plane at center", cam.pick(0, 0) === plane);
  check("pick misses outside the plane", cam.pick(0.99, 0.99) !== plane);

  // Interrupting: input cancels the flight where it is.
  cam.focusPlane(floor);
  run(cam, 0.3);
  const at = cam.eye;
  cam.rotate(0.0001, 0);
  check("input interrupts a flight", !cam.isTransitioning && cam.focused === null);
  cam.update(1 / 60);
  check("interrupt does not jump", v3dist(at, cam.eye) < 0.5, `${v3dist(at, cam.eye)}`);

  // Looking straight down at a floor plane works and can be dragged back out.
  cam.focusPlane(floor);
  run(cam, 4);
  check("can look straight down at a floor plane", near(cam.forward[1], -1, 1e-4), `${cam.forward}`);
  cam.rotate(0, 0.5);
  run(cam, 2);
  check("can drag back out of a straight-down view", cam.forward[1] > -0.95, `${cam.forward}`);

  check("focusNext cycles", cam.focusNext(1) && cam.isTransitioning);
  run(cam, 4);
  check("focusNext lands on a plane", cam.focused !== null);
}

// --- roll leveling ----------------------------------------------------------------
{
  const cam = new CameraRig(still);
  const tilted: PlaneTarget = { center: [0, 0, 0], normal: [0, 0, 1], up: [1, 1, 0], width: 4, height: 4 };
  cam.focusPlane(tilted);
  run(cam, 4);
  check("focus honors the plane's own up (rolled view)", Math.abs(cam.right[1]) > 0.5, `${cam.right}`);
  run(cam, 3);
  check("rolled view is stable while focused", Math.abs(cam.right[1]) > 0.5);
  cam.rotate(0.3, 0);
  run(cam, 4);
  check("horizon levels after the user takes over", near(cam.right[1], 0, 1e-2), `${cam.right}`);
}

// --- idle drift ---------------------------------------------------------------------
{
  const cam = new CameraRig();
  run(cam, 5);
  check("no drift before the idle delay", cam.idleAmount === 0);
  const e0 = cam.eye;
  run(cam, 1);
  check("camera is still before the idle delay", v3dist(e0, cam.eye) < 1e-6);
  run(cam, 10);
  check("drift fades in when idle", cam.idleAmount === 1 && cam.speed > 0, `${cam.idleAmount} ${cam.speed}`);
  check("drift is slow", cam.speed < 0.06 * cam.distance, `${cam.speed}`);

  // Taking over must not jump, and must stop the drift.
  const before = cam.eye;
  const qBefore = cam.getPose().orientation;
  cam.beginGesture();
  cam.update(1 / 60);
  check("grabbing during drift does not jump", v3dist(before, cam.eye) < 1e-3 && quatAngle(qBefore, cam.getPose().orientation) < 1e-3);
  check("grabbing stops the drift", cam.idleAmount === 0);
  cam.endGesture();

  const rm = new CameraRig({ reducedMotion: true });
  rm.update(1 / 60);
  const r0 = rm.eye;
  run(rm, 30);
  check("reduced motion: no idle drift", v3dist(r0, rm.eye) < 1e-9);
  rm.focusPlane({ center: [5, 0, 0], normal: [0, 0, 1], width: 2, height: 2 });
  rm.update(1 / 60);
  check("reduced motion: focus is a cut", !rm.isTransitioning && rm.focused !== null);
}

// --- tour -------------------------------------------------------------------------
{
  const planes: PlaneTarget[] = [
    { id: 0, center: [0, 0, 0], normal: [0, 0, 1], width: 8, height: 8 },
    { id: 1, center: [0, 0, -12], normal: [0, 0, 1], width: 8, height: 8 },
    { id: 2, center: [20, 0, 0], normal: [1, 0, 0], width: 8, height: 8 },
  ];
  const seen = new Set<unknown>();
  const cam = new CameraRig({
    idle: { tour: true, delay: 1, rampIn: 1, tourDwell: 2 },
    onFocusChange: (p) => p && seen.add(p.id),
  });
  cam.setPlanes(planes);
  run(cam, 60);
  check("idle tour visits every plane", seen.size === 3, `${[...seen]}`);
  cam.rotate(0.1, 0);
  run(cam, 0.5);
  check("input ends the tour", !cam.isTransitioning && cam.focused === null);
}

// --- bounds -------------------------------------------------------------------------
{
  const cam = new CameraRig({ ...still, bounds: { center: [0, 0, 0], radius: 50 } });
  cam.setMove(1, 0, 0, true);
  run(cam, 20);
  cam.setMove(0, 0, 0);
  run(cam, 5);
  const pose = cam.getPose();
  check("pivot is pulled back inside the bounds", v3len(pose.target) <= 50.5, `${v3len(pose.target)}`);
}

// --- pan, zoom and fly are scaled to the sheets -------------------------------------------
{
  // The eye sits at z = 30 looking down -Z, with the pivot at the origin. Two sheets face it
  // well beyond the pivot: A at depth 90 and B another 40 behind.
  const level: Quat = [0, 0, 0, 1];
  const A: PlaneTarget = { id: "A", center: [0, 0, -60], normal: [0, 0, 1], width: 60, height: 60 };
  const B: PlaneTarget = { id: "B", center: [0, 0, -100], normal: [0, 0, 1], width: 60, height: 60 };
  const make = (planes: PlaneTarget[] = [A, B], distance = 30, target: Vec3 = [0, 0, 0]): CameraRig => {
    const cam = new CameraRig({ ...still, initial: { target, orientation: level, distance } });
    cam.setViewport(1000, 1000);
    cam.setPlanes(planes);
    cam.update(1 / 60);
    return cam;
  };
  /** Where the eye is heading, read back from the goal pose. */
  const goalEye = (cam: CameraRig): Vec3 => {
    const g = cam.getGoalPose();
    return v3addScaled(g.target, quatRotate(g.orientation, [0, 0, 1]), g.distance);
  };
  /** The point of the plane z = `z` under a screen position. */
  const under = (cam: CameraRig, ndcX: number, ndcY: number, z: number): Vec3 => {
    const ray = cam.screenRay(ndcX, ndcY);
    return v3addScaled(ray.origin, ray.direction, (z - ray.origin[2]) / ray.direction[2]);
  };
  const min = make().options.minDistance;

  // Grab: the pivot goes to the sheet under the pointer and nothing moves on screen.
  {
    const cam = make();
    const eye = cam.eye;
    const q = cam.getPose().orientation;
    check("grab reports the sheet under the pointer", cam.grab(0.3, 0.2));
    cam.update(1 / 60);
    check("grab moves nothing on screen", v3dist(eye, cam.eye) < 1e-9 && quatAngle(q, cam.getPose().orientation) < 1e-9);
    check("grab puts the pivot at the depth of the sheet", near(cam.getGoalPose().distance, 90, 1e-6), `${cam.getGoalPose().distance}`);
    check("grab misses over open space", !make([{ ...A, center: [100, 0, -60] }]).grab(0, 0));
  }

  // Pan: the sheet the drag started on stays under the pointer, however far the pivot was from it.
  {
    const cam = make();
    const grabbed = under(cam, 0.5, 0.25, -60);
    cam.grab(0.5, 0.25);
    cam.pan(-0.5, -0.25);
    run(cam, 2);
    const ndc = mat4TransformPoint(cam.viewProjection, grabbed);
    check("pan keeps the grabbed sheet under the pointer", near(ndc[0], 0, 1e-3) && near(ndc[1], 0, 1e-3), `${ndc}`);
  }

  // Zoom: closes in on the sheet under the pointer, which stays under the pointer.
  {
    const cam = make();
    const anchor = under(cam, 0.3, 0.2, -60);
    cam.zoom(-0.5, 0.3, 0.2);
    run(cam, 2);
    const ndc = mat4TransformPoint(cam.viewProjection, anchor);
    check("zoom keeps the sheet point under the pointer", near(ndc[0], 0.3, 1e-3) && near(ndc[1], 0.2, 1e-3), `${ndc}`);
    check("zoom closes in on the sheet, not on the pivot", near(cam.eye[2] + 60, 90 * Math.exp(-0.5), 1e-2), `${cam.eye[2] + 60}`);
  }

  // Scrolling in never stalls: it reaches the closest look at A, goes through it, does the same
  // at B, and keeps going over the open space behind.
  {
    const cam = make();
    let closestA = Infinity;
    let closestB = Infinity;
    let smallestShare = Infinity;
    let z = goalEye(cam)[2];
    for (let notch = 0; notch < 120; notch++) {
      cam.zoom(-0.15, 0.3, 0.2);
      cam.update(1 / 60);
      const next = goalEye(cam)[2];
      // What a notch has to make progress against: the sheet ahead, or the open-space floor.
      const ahead = z > -60 ? z + 60 : z > -100 ? z + 100 : Infinity;
      smallestShare = Math.min(smallestShare, (z - next) / Math.min(ahead, 0.25 * 60));
      z = next;
      if (z > -60) closestA = Math.min(closestA, z + 60);
      else if (z > -100) closestB = Math.min(closestB, z + 100);
    }
    check("zoom stops for a closest look at the sheet", closestA >= min * 0.999 && closestA <= min * 1.2, `${closestA}`);
    check("the next notch goes through the sheet", closestB < Infinity);
    check("zoom stops for a closest look at the sheet behind", closestB >= min * 0.999 && closestB <= min * 1.2, `${closestB}`);
    check("zoom carries on over open space", z < -100 - 10, `${z}`);
    check("every notch makes progress", smallestShare > 0.08, `${smallestShare}`);
  }

  // One huge step lands on the closest look instead of going through, and backing out from
  // there is as fine as getting in.
  {
    const cam = make();
    cam.zoom(-100);
    check("a huge zoom step stops at the sheet", near(goalEye(cam)[2] + 60, min, 1e-9), `${goalEye(cam)[2] + 60}`);
    cam.zoom(0.15);
    check("zooming out from the closest look is just as fine", near(goalEye(cam)[2] + 60, min * Math.exp(0.15), 1e-9), `${goalEye(cam)[2] + 60}`);
    cam.zoom(-100);
    cam.zoom(-100);
    check("pushing on from the closest look goes through", near(goalEye(cam)[2] + 100, min, 1e-9), `${goalEye(cam)[2] + 100}`);
  }

  // A pivot left right in front of the eye, over open space: grab puts it back out at the
  // nearest sheet ahead, so pan and zoom are not scaled to almost nothing.
  {
    const aside: PlaneTarget = { ...A, center: [100, 0, -60] };
    const cam = make([aside], 0.05, [0, 0, 29.95]);
    const eye = cam.eye;
    cam.grab(0, 0);
    cam.update(1 / 60);
    check("grab over open space moves nothing on screen", v3dist(eye, cam.eye) < 1e-9);
    check("grab over open space reaches for the nearest sheet ahead", near(cam.getGoalPose().distance, Math.hypot(70, 90), 1e-6), `${cam.getGoalPose().distance}`);
  }

  // Fly: fast in the open, slower toward a sheet, and through it rather than toward it forever.
  {
    const cam = make();
    cam.setMove(0, 0, 1);
    run(cam, 1);
    const first = 30 - cam.eye[2];
    check("fly speed follows the clearance to the nearest sheet", first > 30 && first < 60, `${first}`);
    run(cam, 11);
    check("fly goes through a sheet", cam.eye[2] < -60, `${cam.eye[2]}`);

    // Looking at a sheet from 0.2 away: sideways goes at that depth, forward goes through.
    const close = make([A], 0.2, [0, 0, -60]);
    close.setMove(1, 0, 0);
    run(close, 1);
    check("sliding across a sheet seen up close is slow", close.eye[0] > 0.1 && close.eye[0] < 0.25, `${close.eye[0]}`);
    close.setMove(0, 0, 1);
    run(close, 1);
    check("flying forward from up close goes through", close.eye[2] < -63, `${close.eye[2]}`);

    // The eye in the plane of a sheet, looking along it: nothing is in front to slow down for.
    const inPlane = new CameraRig({
      ...still,
      initial: { target: [-5, 0, -60], orientation: quatFromAxisAngle([0, 1, 0], Math.PI / 2), distance: 5 },
    });
    inPlane.setPlanes([A]);
    inPlane.update(1 / 60);
    const start = inPlane.eye;
    inPlane.setMove(1, 0, 0);
    run(inPlane, 1);
    check("the camera is never stuck in the plane of a sheet", v3dist(start, inPlane.eye) > 3, `${v3dist(start, inPlane.eye)}`);
  }

  // Limits: the world can be zoomed out to a small cluster, not out of sight.
  {
    const cam = make();
    cam.limitTo([A, B]);
    const radius = 20 + 0.5 * Math.hypot(60, 60);
    check("limitTo bounds the pivot around the sheets", cam.options.bounds !== null && v3dist(cam.options.bounds.center, [0, 0, -80]) < 1e-9 && near(cam.options.bounds.radius, 4 * radius, 1e-9));
    cam.zoom(100);
    check("zooming out stops with the sheets still in sight", near(cam.getGoalPose().distance, 8 * radius, 1e-6), `${cam.getGoalPose().distance}`);
    cam.limitTo([]);
    check("limitTo with no sheets restores the original limits", cam.options.bounds === null && cam.options.maxDistance === 2000);
  }
}

// --- robustness ----------------------------------------------------------------------
{
  const cam = new CameraRig();
  cam.update(NaN);
  cam.update(-1);
  cam.update(10);
  cam.setViewport(0, 0);
  cam.update(1 / 60);
  let finite = true;
  for (const v of cam.viewProjection) if (!Number.isFinite(v)) finite = false;
  check("matrices stay finite under bad input", finite);
  const q = cam.getPose().orientation;
  check("orientation stays normalized", near(Math.hypot(...q), 1, 1e-6));
  check("basis is orthonormal", near(v3dot(cam.right, cam.up), 0) && near(v3len(quatRotate(q, [0, 0, 1])), 1));
}

// --- engine contract adapter ------------------------------------------------------------
{
  const state = { target: [1, 2, 3] as Vec3, yaw: 0.8, pitch: -0.4, distance: 12, fovY: 1 };
  const cam = createCamera(state, still);
  cam.update(1 / 60);
  const s = cam.snapshot();
  check(
    "state round-trips through the rig",
    near(s.yaw, 0.8) && near(s.pitch, -0.4) && near(s.distance, 12) && near(s.fovY, 1) && v3dist(s.target, [1, 2, 3]) < 1e-6,
    JSON.stringify(s),
  );
  check("eye() is distance from target", near(v3dist(cam.eye(), [1, 2, 3]), 12, 1e-4));
  const wide = Array.from(cam.viewProjection(2));
  const tall = Array.from(cam.viewProjection(0.5));
  check("viewProjection follows the aspect it is given", near(wide[0] * 4, tall[0], 1e-4) || near(Math.hypot(wide[0], wide[4], wide[8]) * 4, Math.hypot(tall[0], tall[4], tall[8]), 1e-4));
  cam.state.yaw = 0;
  cam.state.pitch = 0;
  cam.update(1 / 60);
  check("writing state fields moves the camera", v3dist(cam.eye(), [1, 2, 15]) < 1e-4, `${cam.eye()}`);
  cam.state = { target: [0, 0, 0], yaw: Math.PI / 2, pitch: 0, distance: 5, fovY: 1 };
  cam.update(1 / 60);
  check("assigning state moves the camera", v3dist(cam.eye(), [5, 0, 0]) < 1e-4, `${cam.eye()}`);
  cam.state = { target: [0, 0, 0], yaw: 0.6, pitch: -0.35, distance: 14, fovY: 1 };
  cam.update(1 / 60);
  // Negative pitch looks down: eye = target + distance * (cp*sy, -sp, cp*cy), here with p = -0.35.
  const want: Vec3 = [14 * Math.cos(0.35) * Math.sin(0.6), 14 * Math.sin(0.35), 14 * Math.cos(0.35) * Math.cos(0.6)];
  check("negative pitch puts the eye above the target", v3dist(cam.eye(), want) < 1e-4, `${cam.eye()}`);

  const target = planeTargetFromDesc({
    position: [0, 0, 0],
    rotation: orientationFromYawPitch(Math.PI / 2, 0),
    halfSize: [2, 1],
    behaviorId: "x",
    particleCount: 1,
    seed: 0,
  });
  check("plane desc maps to a pickable target", near(target.normal[0], 1) && target.width === 4 && target.height === 2, JSON.stringify(target));
}

console.log(`${checks - failures}/${checks} camera checks passed`);
if (failures > 0) throw new Error(`${failures} camera checks failed`);
