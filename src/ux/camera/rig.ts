/**
 * CameraRig: a DOM-free camera rig for moving through the void.
 *
 * To plug it into the engine's `CameraController` contract, use
 * `createCamera()` from ./engine.
 *
 * The rig is a pivot (`target`), an orientation and a distance. The eye sits
 * at `target + orientation * (0, 0, distance)` and looks at the pivot. Every
 * input writes to a goal pose; the rendered pose chases the goal with
 * frame-rate independent smoothing, so motion always eases in and out.
 *
 * Usage:
 *   const cam = new CameraRig();
 *   cam.setViewport(canvas.width, canvas.height);
 *   // each frame
 *   cam.update(dtSeconds);
 *   device.queue.writeBuffer(ubo, 0, cam.viewProjection);
 *
 * See docs/ux/camera.md for the reasoning behind the numbers.
 */

import {
  clamp,
  damp,
  easeInOutCubic,
  lerp,
  mat4,
  mat4Mul,
  mat4Perspective,
  mat4View,
  quatAngle,
  quatCopy,
  quatFromAxisAngle,
  quatLook,
  quatMul,
  quatNormalize,
  quatRotate,
  quatSlerp,
  smoothstep,
  v3add,
  v3addScaled,
  v3copy,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3lerp,
  v3normalize,
  v3scale,
  v3sub,
} from "./math";
import type { Mat4, Quat, Vec3 } from "./math";

/** A rectangular sheet in the world that the camera can frame head-on. */
export interface PlaneTarget {
  id?: string | number;
  center: Vec3;
  /** Front-facing normal. Does not need to be normalized. */
  normal: Vec3;
  /** Which way is "up" on the sheet. Defaults to world up. */
  up?: Vec3;
  width: number;
  height: number;
}

export interface CameraPose {
  target: Vec3;
  orientation: Quat;
  distance: number;
}

export type CameraMode = "orbit" | "fly";
export type RotatePivot = "target" | "eye";

export interface IdleOptions {
  enabled: boolean;
  /** Seconds without input before the drift starts to fade in. */
  delay: number;
  /** Seconds the drift takes to reach full strength. */
  rampIn: number;
  /** Orbit speed around world up when nothing is focused, radians per second. */
  orbitRate: number;
  /** Side to side sway while a plane is focused, radians. */
  swayYaw: number;
  /** Slow nodding amplitude, radians. */
  swayPitch: number;
  /** Slow dolly in and out, as a fraction of distance. */
  breathe: number;
  /** Visit registered planes one after another while idle. */
  tour: boolean;
  /** Seconds to rest on each plane during a tour. */
  tourDwell: number;
}

export interface TransitionOptions {
  minDuration: number;
  maxDuration: number;
  /** Pull back mid-flight by this fraction of the travel distance. */
  arc: number;
  /** Margin around a focused plane. 1 = touching the viewport edge. */
  fitPadding: number;
}

export interface CameraOptions {
  /** Vertical field of view in radians. */
  fovY: number;
  /**
   * Near clip distance. Keep it well under minDistance: zoom stops minDistance
   * from a sheet, and a tilted sheet reaches closer to the eye than that at
   * the edges of the view.
   */
  near: number;
  /** May be Infinity. */
  far: number;
  /** Near maps to depth 1, far to 0. Recommended for very large worlds. */
  reverseZ: boolean;
  /** Closest the eye gets to the pivot, and so to a sheet it zooms in on. */
  minDistance: number;
  /** Farthest the eye backs away from the pivot. */
  maxDistance: number;
  /** "turntable" keeps the horizon level. "free" is an unconstrained trackball. */
  upMode: "turntable" | "free";
  worldUp: Vec3;
  /** Turntable only: how far the camera may look up or down, radians. */
  maxPitch: number;
  /** Time constant of the pose smoothing, seconds. 0 disables smoothing. */
  smoothing: number;
  /** Time constant of rotation inertia after releasing a drag, seconds. */
  rotateFriction: number;
  /** Time constant of pan inertia after releasing a drag, seconds. */
  panFriction: number;
  /**
   * Fly speed in "distances per second". With sheets registered the distance
   * is the clearance to the nearest one, so the camera covers ground in the
   * open and slows down among sheets. With none it is the distance to the pivot.
   */
  flySpeed: number;
  /**
   * With sheets registered, flying never counts the clearance as less than
   * this fraction of a typical sheet's shorter side, so a sheet is flown
   * through instead of being approached forever. Sideways and up or down
   * still slow to the depth of a sheet the camera looks at from closer than
   * this, so its particles slide past at a pace the eye can follow.
   */
  flyFloor: number;
  /**
   * With sheets registered and the pointer over open space, pan and zoom are
   * never scaled to less than this fraction of a typical sheet's shorter side.
   */
  openFloor: number;
  flyBoost: number;
  /** Time constant for fly acceleration and braking, seconds. */
  flyAccel: number;
  /** Soft sphere that the pivot is pulled back into. null = unbounded. See limitTo. */
  bounds: { center: Vec3; radius: number } | null;
  idle: IdleOptions;
  transition: TransitionOptions;
  /** Honor prefers-reduced-motion: no drift, no inertia, cuts instead of flights. */
  reducedMotion: boolean;
  initial: CameraPose;
  onFocusChange: ((plane: PlaneTarget | null) => void) | null;
}

export type CameraOptionsInput = Partial<
  Omit<CameraOptions, "idle" | "transition" | "initial">
> & {
  idle?: Partial<IdleOptions>;
  transition?: Partial<TransitionOptions>;
  initial?: Partial<CameraPose>;
};

export interface FlyToOptions {
  /** Seconds. Omit to derive it from how far the camera has to travel. */
  duration?: number;
}

const DEG = Math.PI / 180;

const defaultInitialPose = (): CameraPose => ({
  target: [0, 0, 0],
  // Three-quarter view looking slightly down, so depth reads immediately.
  orientation: quatMul(
    quatFromAxisAngle([0, 1, 0], 0.6),
    quatFromAxisAngle([1, 0, 0], -0.35),
  ),
  distance: 30,
});

const defaults = (): CameraOptions => ({
  fovY: 50 * DEG,
  near: 0.02,
  far: 10000,
  reverseZ: false,
  minDistance: 0.05,
  maxDistance: 2000,
  upMode: "turntable",
  worldUp: [0, 1, 0],
  maxPitch: 85 * DEG,
  smoothing: 0.07,
  rotateFriction: 0.35,
  panFriction: 0.25,
  flySpeed: 1,
  flyFloor: 0.15,
  openFloor: 0.25,
  flyBoost: 4,
  flyAccel: 0.15,
  bounds: null,
  idle: {
    enabled: true,
    delay: 6,
    rampIn: 4,
    orbitRate: 0.035,
    swayYaw: 0.1,
    swayPitch: 0.04,
    breathe: 0.04,
    tour: false,
    tourDwell: 14,
  },
  transition: {
    minDuration: 0.6,
    maxDuration: 2.4,
    arc: 0.3,
    fitPadding: 1.12,
  },
  reducedMotion: false,
  initial: defaultInitialPose(),
  onFocusChange: null,
});

const copyPose = (p: CameraPose): CameraPose => ({
  target: v3copy(p.target),
  orientation: quatCopy(p.orientation),
  distance: p.distance,
});

interface Transition {
  from: CameraPose;
  to: CameraPose;
  t: number;
  duration: number;
  travel: number;
  focus: PlaneTarget | null;
  auto: boolean;
}

const X_AXIS: Vec3 = [1, 0, 0];
const Y_AXIS: Vec3 = [0, 1, 0];
const BACK: Vec3 = [0, 0, 1];
const FORWARD: Vec3 = [0, 0, -1];

/**
 * Zooming in on a sheet stops minDistance from it. Within this factor of that
 * depth the sheet counts as reached, and the next step in goes through it.
 */
const REACHED = 1.1;

export class CameraRig {
  readonly options: CameraOptions;

  /** World to camera. Column-major, updated by `update()`. */
  readonly view: Mat4 = mat4();
  /** Camera to WebGPU clip space (depth 0..1). */
  readonly projection: Mat4 = mat4();
  /** projection * view. */
  readonly viewProjection: Mat4 = mat4();

  /** Rendered camera position and basis, updated by `update()`. */
  eye: Vec3 = [0, 0, 0];
  forward: Vec3 = [0, 0, -1];
  right: Vec3 = [1, 0, 0];
  up: Vec3 = [0, 1, 0];
  /** Rendered distance from eye to pivot. */
  distance = 1;
  /** Eye speed in world units per second. Useful for motion-based effects. */
  speed = 0;
  /** 0..1, how strongly the idle drift is currently applied. */
  idleAmount = 0;
  mode: CameraMode = "orbit";

  private goal: CameraPose;
  private cur: CameraPose;
  private home: CameraPose;
  private aspect = 16 / 9;
  /** The limits the rig was created with: what limitTo falls back to with no sheets. */
  private readonly baseLimits: Pick<CameraOptions, "bounds" | "maxDistance">;

  private planes: PlaneTarget[] = [];
  /** Mean shorter side of the registered sheets, 0 with none: the unit navigation floors are given in. */
  private sheetSize = 0;
  private focusedPlane: PlaneTarget | null = null;
  private transition: Transition | null = null;

  // Inertia.
  private gestureActive = false;
  private accRot: [number, number] = [0, 0];
  private velRot: [number, number] = [0, 0];
  private rotPivot: RotatePivot = "target";
  private accPan: Vec3 = [0, 0, 0];
  private velPan: Vec3 = [0, 0, 0];

  // Fly.
  private move: Vec3 = [0, 0, 0];
  private moveBoost = false;
  private flyVel: Vec3 = [0, 0, 0];

  // Idle drift layer, composed on top of the pose at output time.
  private idleTime = 0;
  private driftTime = 0;
  private tourTime = 0;
  private driftWorldYaw = 0;
  private driftLocalYaw = 0;
  private driftPitch = 0;
  private driftDolly = 1;

  private hasPrevEye = false;

  constructor(options: CameraOptionsInput = {}) {
    const d = defaults();
    this.options = {
      ...d,
      ...options,
      idle: { ...d.idle, ...options.idle },
      transition: { ...d.transition, ...options.transition },
      initial: { ...d.initial, ...options.initial },
    } as CameraOptions;
    this.options.worldUp = v3normalize(this.options.worldUp, [0, 1, 0]);
    this.baseLimits = { bounds: this.options.bounds, maxDistance: this.options.maxDistance };
    const init = copyPose(this.options.initial);
    init.orientation = quatNormalize(init.orientation);
    init.distance = this.clampDistance(init.distance);
    this.home = init;
    this.goal = copyPose(init);
    this.cur = copyPose(init);
    this.writeOutputs(0);
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------

  setViewport(width: number, height: number): void {
    if (width > 0 && height > 0) this.aspect = width / height;
  }

  /** Set the aspect ratio directly and refresh the matrices if it changed. */
  setAspect(aspect: number): void {
    if (!(aspect > 0) || !Number.isFinite(aspect) || aspect === this.aspect) return;
    this.aspect = aspect;
    this.writeOutputs(0);
  }

  /** Recompute matrices after changing an option such as fovY between frames. */
  refresh(): void {
    this.writeOutputs(0);
  }

  /**
   * Planes used for picking, next/previous, nearest and the idle tour. Pan,
   * zoom and fly are also scaled to them (see grab, zoom and flySpeed).
   */
  setPlanes(planes: PlaneTarget[]): void {
    this.planes = planes;
    let sum = 0;
    for (const plane of planes) sum += Math.min(plane.width, plane.height);
    this.sheetSize = planes.length > 0 ? sum / planes.length : 0;
  }

  /**
   * Keep the camera in reach of a fixed set of sheets. The pivot stays within
   * `reach` radii of the ball around them and the eye backs away at most
   * twice that far, so the world can shrink to a small cluster on screen but
   * cannot be lost by zooming out or flying off. With no sheets (a streamed
   * world has no fixed middle) the limits the rig was created with come back.
   */
  limitTo(planes: readonly PlaneTarget[], reach = 4): void {
    const o = this.options;
    if (planes.length === 0) {
      o.bounds = this.baseLimits.bounds;
      o.maxDistance = this.baseLimits.maxDistance;
      return;
    }
    let center: Vec3 = [0, 0, 0];
    for (const plane of planes) center = v3add(center, plane.center);
    center = v3scale(center, 1 / planes.length);
    let radius = 0;
    for (const plane of planes) {
      radius = Math.max(radius, v3dist(plane.center, center) + 0.5 * Math.hypot(plane.width, plane.height));
    }
    o.bounds = { center, radius: reach * radius };
    o.maxDistance = Math.max(2 * reach * radius, o.minDistance);
  }

  setHome(pose: CameraPose): void {
    this.home = copyPose(pose);
  }

  /** The pose currently on screen, including idle drift. */
  getPose(): CameraPose {
    return {
      target: v3copy(this.cur.target),
      orientation: this.outputOrientation(),
      distance: this.cur.distance * this.driftDolly,
    };
  }

  /** Jump to a pose with no animation. */
  setPose(pose: CameraPose): void {
    this.interact();
    const p = copyPose(pose);
    p.orientation = quatNormalize(p.orientation);
    p.distance = this.clampDistance(p.distance);
    this.goal = p;
    this.cur = copyPose(p);
    this.stopMomentum();
  }

  /** The pose the camera is easing toward (no idle drift). */
  getGoalPose(): CameraPose {
    return copyPose(this.goal);
  }

  /**
   * Scripted authority over the camera, for intros and guided moments. Each
   * call pulls the goal toward `pose` by `weight` (0..1); the usual smoothing
   * still applies. At weight 1 the script owns the camera, and when it stops
   * calling, the camera simply stays where it was left.
   */
  steer(pose: CameraPose, weight = 1): void {
    const w = clamp(weight, 0, 1);
    if (w <= 0) return;
    this.interact();
    this.stopMomentum();
    this.mode = "orbit";
    const g = this.goal;
    g.target = v3lerp(g.target, pose.target, w);
    g.orientation = quatSlerp(g.orientation, quatNormalize(pose.orientation), w);
    g.distance = this.clampDistance(
      Math.exp(lerp(Math.log(g.distance), Math.log(Math.max(pose.distance, 1e-9)), w)),
    );
  }

  /** Count as activity: restart the idle timer without moving anything. */
  wake(): void {
    this.bakeDrift();
    this.idleTime = 0;
    this.tourTime = 0;
  }

  get focused(): PlaneTarget | null {
    return this.focusedPlane;
  }

  get isTransitioning(): boolean {
    return this.transition !== null;
  }

  // ------------------------------------------------------------------
  // Direct manipulation. All of these are safe to call many times a frame.
  // ------------------------------------------------------------------

  /** Call when a drag or touch gesture starts. Enables release inertia. */
  beginGesture(): void {
    this.interact();
    this.gestureActive = true;
    this.accRot = [0, 0];
    this.velRot = [0, 0];
    this.accPan = [0, 0, 0];
    this.velPan = [0, 0, 0];
  }

  /** Call when the last pointer lifts. Whatever speed is left carries on. */
  endGesture(): void {
    this.gestureActive = false;
    if (this.options.reducedMotion) this.stopMomentum();
  }

  /**
   * Rotate by angles in radians. Positive yaw turns the camera left, positive
   * pitch tilts it up. With pivot "target" the eye orbits the pivot; with
   * pivot "eye" the camera looks around in place.
   */
  rotate(dYaw: number, dPitch: number, pivot: RotatePivot = "target"): void {
    this.interact();
    this.mode = pivot === "eye" ? "fly" : "orbit";
    this.applyRotation(this.goal, dYaw, dPitch, pivot);
    if (this.gestureActive) {
      this.accRot[0] += dYaw;
      this.accRot[1] += dPitch;
      this.rotPivot = pivot;
    }
  }

  /**
   * Call when a pan or pinch starts at a screen position (zoom does the same
   * itself). Puts the pivot at the depth of the sheet under that position,
   * so the gesture is scaled to what the pointer is on: a panned sheet stays
   * under the pointer, and a zoom closes in on the sheet instead of on
   * wherever the pivot was left. Over open space the pivot is kept at least
   * as far away as the nearest sheet ahead (and a quarter of a sheet), so a
   * pivot left right in front of the eye cannot make every control crawl.
   * Nothing moves on screen. Returns true when a sheet is under the position.
   */
  grab(ndcX = 0, ndcY = 0): boolean {
    this.interact();
    return this.anchorPivot(ndcX, ndcY, 0);
  }

  /**
   * Slide the pivot so the scene follows the pointer. Deltas are in
   * normalized device units: the full viewport width or height is 2.
   */
  pan(dxNdc: number, dyNdc: number): void {
    this.interact();
    const q = this.goal.orientation;
    const halfH = this.goal.distance * Math.tan(this.options.fovY * 0.5);
    const halfW = halfH * this.aspect;
    const r = quatRotate(q, X_AXIS);
    const u = quatRotate(q, Y_AXIS);
    const delta = v3add(v3scale(r, -dxNdc * halfW), v3scale(u, -dyNdc * halfH));
    this.goal.target = v3add(this.goal.target, delta);
    if (this.gestureActive) this.accPan = v3add(this.accPan, delta);
  }

  /**
   * Dolly toward or away from what is under (ndcX, ndcY). `logDelta` < 0
   * zooms in; the distance to that point is multiplied by exp(logDelta), and
   * the point stays under the pointer.
   *
   * With sheets registered the point is on the sheet under the pointer, so a
   * zoom closes in on something that is there. It stops minDistance from the
   * sheet, the closest look. The next step in goes through the sheet toward
   * whatever lies behind it, and over open space each step covers a share of
   * the way to the nearest sheet ahead: zooming in never stalls.
   */
  zoom(logDelta: number, ndcX = 0, ndcY = 0): void {
    this.interact();
    this.mode = "orbit";
    this.anchorPivot(ndcX, ndcY, logDelta < 0 ? this.options.minDistance * REACHED : 0);
    const g = this.goal;
    const oldD = g.distance;
    const newD = this.clampDistance(oldD * Math.exp(logDelta));
    if (newD === oldD) return;
    const halfH = oldD * Math.tan(this.options.fovY * 0.5);
    const halfW = halfH * this.aspect;
    const r = quatRotate(g.orientation, X_AXIS);
    const u = quatRotate(g.orientation, Y_AXIS);
    const anchor = v3add(
      g.target,
      v3add(v3scale(r, ndcX * halfW), v3scale(u, ndcY * halfH)),
    );
    g.target = v3add(anchor, v3scale(v3sub(g.target, anchor), newD / oldD));
    g.distance = newD;
  }

  /**
   * Fly input in camera space, each component in -1..1: x = right, y = up,
   * z = forward. Call with zeros to stop; the camera glides to rest.
   */
  setMove(x: number, y: number, z: number, boost = false): void {
    const active = x !== 0 || y !== 0 || z !== 0;
    if (active) {
      this.interact();
      this.mode = "fly";
    }
    this.move = [x, y, z];
    this.moveBoost = boost;
  }

  /** Kill inertia and fly velocity right now. */
  stopMomentum(): void {
    this.velRot = [0, 0];
    this.accRot = [0, 0];
    this.velPan = [0, 0, 0];
    this.accPan = [0, 0, 0];
    this.flyVel = [0, 0, 0];
  }

  // ------------------------------------------------------------------
  // Transitions and focus
  // ------------------------------------------------------------------

  /** Fly smoothly to a pose. Any user input interrupts the flight. */
  flyTo(pose: CameraPose, opts: FlyToOptions = {}): void {
    this.interact();
    this.startTransition(pose, null, false, opts.duration);
  }

  flyHome(opts: FlyToOptions = {}): void {
    this.flyTo(this.home, opts);
  }

  /** Frame a plane head-on, from whichever side the camera is already on. */
  focusPlane(plane: PlaneTarget, opts: FlyToOptions = {}): void {
    this.interact();
    this.startTransition(this.poseForPlane(plane), plane, false, opts.duration);
  }

  /** Focus the registered plane under a screen position. Returns false on a miss. */
  focusAt(ndcX: number, ndcY: number): boolean {
    const plane = this.pick(ndcX, ndcY);
    if (!plane) return false;
    this.focusPlane(plane);
    return true;
  }

  /** Focus the registered plane closest to the center of the view. */
  focusNearest(): boolean {
    const plane = this.nearestPlane();
    if (!plane) return false;
    this.focusPlane(plane);
    return true;
  }

  /** Step through registered planes. `direction` is +1 or -1. */
  focusNext(direction = 1): boolean {
    const plane = this.nextPlane(direction);
    if (!plane) return false;
    this.focusPlane(plane);
    return true;
  }

  /** The pose that frames a plane, without moving the camera. */
  poseForPlane(plane: PlaneTarget): CameraPose {
    const o = this.options;
    const n = v3normalize(plane.normal, [0, 0, 1]);
    const side = v3dot(v3sub(this.eye, plane.center), n) >= 0 ? 1 : -1;
    const back = v3scale(n, side);
    let upHint = plane.up ?? o.worldUp;
    if (Math.abs(v3dot(v3normalize(upHint, Y_AXIS), back)) > 0.99) upHint = this.up;
    const tan = Math.tan(o.fovY * 0.5);
    const fitH = plane.height * 0.5 / tan;
    const fitW = plane.width * 0.5 / (tan * this.aspect);
    return {
      target: v3copy(plane.center),
      orientation: quatLook(v3scale(back, -1), upHint),
      distance: this.clampDistance(Math.max(fitH, fitW) * o.transition.fitPadding),
    };
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** World-space ray through a screen position (NDC, y up). */
  screenRay(ndcX: number, ndcY: number): { origin: Vec3; direction: Vec3 } {
    const tan = Math.tan(this.options.fovY * 0.5);
    const dir = v3add(
      this.forward,
      v3add(
        v3scale(this.right, ndcX * tan * this.aspect),
        v3scale(this.up, ndcY * tan),
      ),
    );
    return { origin: v3copy(this.eye), direction: v3normalize(dir) };
  }

  /** The nearest registered plane hit by the ray through a screen position. */
  pick(ndcX: number, ndcY: number): PlaneTarget | null {
    const { origin, direction } = this.screenRay(ndcX, ndcY);
    return this.castRay(origin, direction)?.plane ?? null;
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  /** Advance the rig by `dt` seconds and refresh the matrices. */
  update(dt: number): void {
    const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    if (step > 0) {
      if (this.transition) {
        this.stepTransition(step);
      } else {
        this.stepFly(step);
        this.stepInertia(step);
        this.stepLevel(step);
        this.stepBounds(step);
        this.stepChase(step);
      }
      this.stepIdle(step);
    }
    this.writeOutputs(step);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private clampDistance(d: number): number {
    return clamp(d, this.options.minDistance, this.options.maxDistance);
  }

  /** Where the eye is heading: the goal pose's eye, without idle drift. */
  private goalEye(): Vec3 {
    const g = this.goal;
    return v3addScaled(g.target, quatRotate(g.orientation, BACK), g.distance);
  }

  /** A sheet's unit normal and its two in-plane axes. */
  private sheetAxes(plane: PlaneTarget): { n: Vec3; right: Vec3; up: Vec3 } {
    const n = v3normalize(plane.normal, [0, 0, 1]);
    let right = v3cross(plane.up ?? this.options.worldUp, n);
    if (v3len(right) < 1e-5) right = v3cross(BACK, n);
    right = v3normalize(right, X_AXIS);
    return { n, right, up: v3cross(n, right) };
  }

  /**
   * The nearest registered sheet a ray passes through, more than `beyond`
   * along it. `direction` is unit length.
   */
  private castRay(origin: Vec3, direction: Vec3, beyond = 0): { plane: PlaneTarget; t: number } | null {
    let best: PlaneTarget | null = null;
    let bestT = Infinity;
    for (const plane of this.planes) {
      const { n, right, up } = this.sheetAxes(plane);
      const denom = v3dot(direction, n);
      if (Math.abs(denom) < 1e-6) continue;
      const t = v3dot(v3sub(plane.center, origin), n) / denom;
      if (t <= beyond || t >= bestT) continue;
      const hit = v3sub(v3addScaled(origin, direction, t), plane.center);
      if (
        Math.abs(v3dot(hit, right)) <= plane.width * 0.5 &&
        Math.abs(v3dot(hit, up)) <= plane.height * 0.5
      ) {
        best = plane;
        bestT = t;
      }
    }
    return best ? { plane: best, t: bestT } : null;
  }

  /**
   * Put the pivot at the depth of what is under a screen position (see
   * grab). Sheets no deeper than `beyond` along the view axis are passed
   * over. Returns true when a sheet is under the position.
   */
  private anchorPivot(ndcX: number, ndcY: number, beyond: number): boolean {
    if (this.planes.length === 0) return false;
    const g = this.goal;
    const q = g.orientation;
    const tan = Math.tan(this.options.fovY * 0.5);
    const eye = this.goalEye();
    const forward = quatRotate(q, FORWARD);
    // Left unnormalized: its part along the view axis is 1, so t / |ray| is depth along that axis.
    const ray = v3add(
      forward,
      v3add(
        v3scale(quatRotate(q, X_AXIS), ndcX * tan * this.aspect),
        v3scale(quatRotate(q, Y_AXIS), ndcY * tan),
      ),
    );
    const len = v3len(ray);
    const hit = this.castRay(eye, v3scale(ray, 1 / len), beyond * len);
    if (hit) {
      this.setPivotDepth(hit.t / len);
      return true;
    }
    const open = this.openReach(eye, forward);
    if (open > g.distance) this.setPivotDepth(open);
    return false;
  }

  /**
   * Distance from a point to the closest point of any registered sheet,
   * Infinity with none. With `ahead` (a unit direction), sheets whose closest
   * point lies behind the point are left out.
   */
  private sheetClearance(point: Vec3, ahead?: Vec3): number {
    let best = Infinity;
    for (const plane of this.planes) {
      const { n, right, up } = this.sheetAxes(plane);
      const rel = v3sub(point, plane.center);
      const x = v3dot(rel, right);
      const y = v3dot(rel, up);
      const z = v3dot(rel, n);
      // Offset from the closest point of the rectangle to `point`, in the sheet's own axes.
      const dx = x - clamp(x, -plane.width * 0.5, plane.width * 0.5);
      const dy = y - clamp(y, -plane.height * 0.5, plane.height * 0.5);
      const d = Math.hypot(dx, dy, z);
      if (d >= best) continue;
      if (ahead) {
        const toward = -(dx * v3dot(right, ahead) + dy * v3dot(up, ahead) + z * v3dot(n, ahead));
        if (toward <= 0) continue;
      }
      best = d;
    }
    return best;
  }

  /**
   * What pan and zoom are scaled to when the pointer is over open space: the
   * clearance to the nearest sheet ahead, and never less than openFloor
   * sheets. 0 when no sheets are registered, which leaves the pivot alone.
   */
  private openReach(eye: Vec3, forward: Vec3): number {
    if (this.planes.length === 0) return 0;
    const ahead = this.sheetClearance(eye, forward);
    return Math.max(Number.isFinite(ahead) ? ahead : 0, this.options.openFloor * this.sheetSize);
  }

  /**
   * Put the pivot `depth` ahead of the eye along the view axis, in the goal
   * and in the pose on screen alike. Eye and orientation stay where they
   * are, so nothing moves; only what pan, zoom and orbit are scaled to changes.
   */
  private setPivotDepth(depth: number): void {
    const d = this.clampDistance(depth);
    for (const pose of [this.goal, this.cur]) {
      const back = quatRotate(pose.orientation, BACK);
      const eye = v3addScaled(pose.target, back, pose.distance);
      pose.target = v3addScaled(eye, back, -d);
      pose.distance = d;
    }
  }

  /** Any user input lands here: cancel flights, settle drift, reset idle. */
  private interact(): void {
    this.transition = null;
    this.bakeDrift();
    this.idleTime = 0;
    this.tourTime = 0;
    this.setFocused(null);
  }

  private setFocused(plane: PlaneTarget | null): void {
    if (plane === this.focusedPlane) return;
    this.focusedPlane = plane;
    this.options.onFocusChange?.(plane);
  }

  private applyRotation(
    pose: CameraPose,
    dYaw: number,
    dPitch: number,
    pivot: RotatePivot,
  ): void {
    const o = this.options;
    const eye =
      pivot === "eye"
        ? v3addScaled(pose.target, quatRotate(pose.orientation, BACK), pose.distance)
        : null;
    let q = pose.orientation;
    let pitch = dPitch;
    if (o.upMode === "turntable") {
      const f = quatRotate(q, FORWARD);
      const p = Math.asin(clamp(v3dot(f, o.worldUp), -1, 1));
      // A focus flight may leave the camera beyond the limit (looking straight
      // down at a floor plane). Never push further out, always allow back in.
      const lo = Math.min(-o.maxPitch, p);
      const hi = Math.max(o.maxPitch, p);
      pitch = clamp(p + dPitch, lo, hi) - p;
      q = quatMul(quatFromAxisAngle(o.worldUp, dYaw), q);
    } else {
      q = quatMul(q, quatFromAxisAngle(Y_AXIS, dYaw));
    }
    q = quatNormalize(quatMul(q, quatFromAxisAngle(X_AXIS, pitch)));
    pose.orientation = q;
    if (eye) pose.target = v3addScaled(eye, quatRotate(q, FORWARD), pose.distance);
  }

  private startTransition(
    pose: CameraPose,
    focus: PlaneTarget | null,
    auto: boolean,
    duration?: number,
  ): void {
    const o = this.options;
    this.bakeDrift();
    this.stopMomentum();
    this.mode = "orbit";
    const from = copyPose(this.cur);
    const to = copyPose(pose);
    to.orientation = quatNormalize(to.orientation);
    to.distance = this.clampDistance(to.distance);
    if (o.reducedMotion || duration === 0) {
      this.goal = to;
      this.cur = copyPose(to);
      this.transition = null;
      this.setFocused(focus);
      return;
    }
    const travel = v3dist(from.target, to.target);
    const refD = Math.max(Math.min(from.distance, to.distance), 1e-6);
    const angle = quatAngle(from.orientation, to.orientation);
    const zoomRatio = Math.abs(Math.log(to.distance / from.distance));
    const auto_ =
      o.transition.minDuration +
      0.3 * Math.log2(1 + travel / refD) +
      0.5 * (angle / Math.PI) +
      0.15 * zoomRatio;
    // Unattended tour flights are slower: nobody is waiting on them.
    const scale = auto ? 1.8 : 1;
    this.transition = {
      from,
      to,
      t: 0,
      duration:
        duration ??
        clamp(auto_, o.transition.minDuration, o.transition.maxDuration) * scale,
      travel,
      focus,
      auto,
    };
  }

  private stepTransition(dt: number): void {
    const tr = this.transition!;
    tr.t = Math.min(1, tr.t + dt / tr.duration);
    const e = easeInOutCubic(tr.t);
    const logD = lerp(Math.log(tr.from.distance), Math.log(tr.to.distance), e);
    const hump = this.options.transition.arc * tr.travel * Math.sin(Math.PI * e);
    const pose: CameraPose = {
      target: v3lerp(tr.from.target, tr.to.target, e),
      orientation: quatSlerp(tr.from.orientation, tr.to.orientation, e),
      distance: this.clampDistance(Math.exp(logD) + hump),
    };
    this.cur = pose;
    this.goal = copyPose(pose);
    if (tr.t >= 1) {
      this.transition = null;
      this.tourTime = 0;
      this.setFocused(tr.focus);
    }
  }

  private stepFly(dt: number): void {
    const o = this.options;
    const g = this.goal;
    let [x, y, z] = this.move;
    const l = Math.hypot(x, y, z);
    if (l > 1) {
      x /= l;
      y /= l;
      z /= l;
    }
    const q = g.orientation;
    const forward = quatRotate(q, FORWARD);
    // Speed is in distances per second: `along` the view axis and `across` it.
    let along = g.distance;
    let across = g.distance;
    if (l > 0 && this.planes.length > 0) {
      // With sheets around, the distance is the clearance to the nearest one, and never so
      // little that a sheet cannot be flown through.
      const eye = this.goalEye();
      const floor = Math.min(o.flyFloor * this.sheetSize, o.maxDistance);
      along = clamp(this.sheetClearance(eye), floor, o.maxDistance);
      // Sliding across a sheet seen from close up goes at its depth, so what is on screen
      // moves at the same pace however close the camera is.
      const seen = this.castRay(eye, forward, o.near);
      across = seen ? Math.min(along, Math.max(seen.t, o.minDistance)) : along;
    }
    const gain = o.flySpeed * (this.moveBoost ? o.flyBoost : 1);
    const desired = v3add(
      v3scale(v3add(v3scale(quatRotate(q, X_AXIS), x), v3scale(quatRotate(q, Y_AXIS), y)), across * gain),
      v3scale(forward, z * along * gain),
    );
    this.flyVel = v3lerp(this.flyVel, desired, damp(dt, o.flyAccel));
    if (v3len(this.flyVel) > 1e-5 * g.distance) {
      g.target = v3addScaled(g.target, this.flyVel, dt);
    } else if (l === 0) {
      this.flyVel = [0, 0, 0];
    }
  }

  private stepInertia(dt: number): void {
    const o = this.options;
    if (this.gestureActive) {
      // Estimate release velocity from recent input. Holding still before
      // letting go decays the estimate to zero, so a deliberate stop stays put.
      const a = damp(dt, 0.04);
      this.velRot[0] = lerp(this.velRot[0], this.accRot[0] / dt, a);
      this.velRot[1] = lerp(this.velRot[1], this.accRot[1] / dt, a);
      this.velPan = v3lerp(this.velPan, v3scale(this.accPan, 1 / dt), a);
      this.accRot = [0, 0];
      this.accPan = [0, 0, 0];
      return;
    }
    if (Math.hypot(this.velRot[0], this.velRot[1]) > 1e-4) {
      this.applyRotation(
        this.goal,
        this.velRot[0] * dt,
        this.velRot[1] * dt,
        this.rotPivot,
      );
      const k = Math.exp(-dt / o.rotateFriction);
      this.velRot[0] *= k;
      this.velRot[1] *= k;
    } else {
      this.velRot = [0, 0];
    }
    if (v3len(this.velPan) > 1e-4 * this.goal.distance) {
      this.goal.target = v3addScaled(this.goal.target, this.velPan, dt);
      this.velPan = v3scale(this.velPan, Math.exp(-dt / o.panFriction));
    } else {
      this.velPan = [0, 0, 0];
    }
  }

  /** Turntable only: ease any leftover roll back to a level horizon. */
  private stepLevel(dt: number): void {
    const o = this.options;
    if (o.upMode !== "turntable" || this.focusedPlane) return;
    const q = this.goal.orientation;
    const f = quatRotate(q, FORWARD);
    if (Math.abs(v3dot(f, o.worldUp)) > 0.97) return;
    const r = quatRotate(q, X_AXIS);
    const level = v3normalize(v3cross(f, o.worldUp), r);
    const roll = Math.atan2(v3dot(v3cross(level, r), f), v3dot(level, r));
    if (Math.abs(roll) < 1e-5) return;
    this.goal.orientation = quatNormalize(
      quatMul(quatFromAxisAngle(f, -roll * damp(dt, 0.35)), q),
    );
  }

  private stepBounds(dt: number): void {
    const b = this.options.bounds;
    if (!b) return;
    const off = v3sub(this.goal.target, b.center);
    const len = v3len(off);
    if (len <= b.radius) return;
    const pulled = b.radius + (len - b.radius) * Math.exp(-dt / 0.15);
    this.goal.target = v3addScaled(b.center, off, pulled / len);
    // Momentum must not keep pushing through the wall.
    this.velPan = v3scale(this.velPan, Math.exp(-dt / 0.05));
  }

  private stepChase(dt: number): void {
    const a = damp(dt, this.options.reducedMotion ? 0 : this.options.smoothing);
    const c = this.cur;
    const g = this.goal;
    const q = quatSlerp(c.orientation, g.orientation, a);
    const d = Math.exp(lerp(Math.log(c.distance), Math.log(g.distance), a));
    if (this.mode === "fly") {
      // Chase the eye, not the pivot, so looking around never swims.
      const eyeC = v3addScaled(c.target, quatRotate(c.orientation, BACK), c.distance);
      const eyeG = v3addScaled(g.target, quatRotate(g.orientation, BACK), g.distance);
      const eye = v3lerp(eyeC, eyeG, a);
      c.target = v3addScaled(eye, quatRotate(q, FORWARD), d);
    } else {
      c.target = v3lerp(c.target, g.target, a);
    }
    c.orientation = q;
    c.distance = d;
  }

  private stepIdle(dt: number): void {
    const o = this.options;
    const idle = o.idle;
    const g = this.goal;
    const userActive =
      this.gestureActive ||
      this.move[0] !== 0 ||
      this.move[1] !== 0 ||
      this.move[2] !== 0 ||
      Math.hypot(this.velRot[0], this.velRot[1]) > 1e-4 ||
      v3len(this.velPan) > 1e-4 * g.distance ||
      v3len(this.flyVel) > 1e-4 * g.distance ||
      (this.transition !== null && !this.transition.auto);
    if (userActive) {
      this.idleTime = 0;
      this.tourTime = 0;
    } else {
      this.idleTime += dt;
    }
    if (!idle.enabled || o.reducedMotion) {
      this.idleAmount = 0;
      return;
    }
    const amount = smoothstep((this.idleTime - idle.delay) / Math.max(idle.rampIn, 1e-3));
    this.idleAmount = amount;
    if (amount <= 0 || this.transition) return;

    this.driftTime += dt;
    const t = this.driftTime;
    // Incommensurate slow periods so the motion never visibly loops.
    this.driftPitch = idle.swayPitch * Math.sin(t * 0.11) * amount;
    this.driftDolly = Math.exp(idle.breathe * Math.sin(t * 0.07) * amount);
    if (this.focusedPlane || o.upMode === "free") {
      this.driftLocalYaw = idle.swayYaw * Math.sin(t * 0.19) * amount;
    } else {
      this.driftWorldYaw += idle.orbitRate * amount * dt;
    }

    if (idle.tour && this.planes.length > 0 && amount >= 1) {
      this.tourTime += dt;
      if (this.tourTime >= idle.tourDwell) {
        const next = this.nextPlane(1);
        if (next) {
          this.tourTime = 0;
          this.bakeDrift();
          this.startTransition(this.poseForPlane(next), next, true);
        }
      }
    }
  }

  /** Fold the drift layer into the pose so taking over never causes a jump. */
  private bakeDrift(): void {
    if (
      this.driftWorldYaw === 0 &&
      this.driftLocalYaw === 0 &&
      this.driftPitch === 0 &&
      this.driftDolly === 1
    ) {
      this.driftTime = 0;
      return;
    }
    this.cur.orientation = this.withDrift(this.cur.orientation);
    this.goal.orientation = this.withDrift(this.goal.orientation);
    this.cur.distance = this.clampDistance(this.cur.distance * this.driftDolly);
    this.goal.distance = this.clampDistance(this.goal.distance * this.driftDolly);
    this.driftWorldYaw = 0;
    this.driftLocalYaw = 0;
    this.driftPitch = 0;
    this.driftDolly = 1;
    this.driftTime = 0;
  }

  private withDrift(q: Quat): Quat {
    let out = q;
    if (this.driftWorldYaw !== 0) {
      out = quatMul(quatFromAxisAngle(this.options.worldUp, this.driftWorldYaw), out);
    }
    if (this.driftLocalYaw !== 0) {
      out = quatMul(out, quatFromAxisAngle(Y_AXIS, this.driftLocalYaw));
    }
    if (this.driftPitch !== 0) {
      out = quatMul(out, quatFromAxisAngle(X_AXIS, this.driftPitch));
    }
    return quatNormalize(out);
  }

  private outputOrientation(): Quat {
    return this.withDrift(this.cur.orientation);
  }

  private nearestPlane(): PlaneTarget | null {
    let best: PlaneTarget | null = null;
    let bestScore = -Infinity;
    for (const plane of this.planes) {
      const to = v3sub(plane.center, this.eye);
      const dist = v3len(to);
      if (dist < 1e-9) return plane;
      // Mostly "what am I looking at", with a mild preference for closer sheets.
      const score = v3dot(to, this.forward) / dist - 0.02 * Math.log(dist);
      if (score > bestScore) {
        bestScore = score;
        best = plane;
      }
    }
    return best;
  }

  private nextPlane(direction: number): PlaneTarget | null {
    const n = this.planes.length;
    if (n === 0) return null;
    const current = this.transition?.focus ?? this.focusedPlane;
    const i = current ? this.planes.indexOf(current) : -1;
    if (i < 0) return this.nearestPlane();
    const stepBy = direction >= 0 ? 1 : -1;
    return this.planes[(i + stepBy + n) % n];
  }

  private writeOutputs(dt: number): void {
    const o = this.options;
    const q = this.outputOrientation();
    const dist = this.cur.distance * this.driftDolly;
    const back = quatRotate(q, BACK);
    const eye = v3addScaled(this.cur.target, back, dist);
    if (dt > 0 && this.hasPrevEye) this.speed = v3dist(eye, this.eye) / dt;
    else if (!this.hasPrevEye) this.speed = 0;
    this.hasPrevEye = true;
    this.eye = eye;
    this.forward = v3scale(back, -1);
    this.right = quatRotate(q, X_AXIS);
    this.up = quatRotate(q, Y_AXIS);
    this.distance = dist;
    mat4View(this.view, eye, q);
    mat4Perspective(this.projection, o.fovY, this.aspect, o.near, o.far, o.reverseZ);
    mat4Mul(this.viewProjection, this.projection, this.view);
  }
}
