// Orbit camera for a world of planes.
//
// The rig keeps a `goal` and a damped `state`. Input writes to the goal, the
// state chases it, so every motion has weight and nothing teleports. It
// implements the shared CameraController contract, so the engine can use it
// directly or copy the behaviour into its own camera: inertia, idle drift,
// and flying to a plane to view it face-on.

import type { CameraController, CameraState, Mat4, PlaneDesc, Quat, Vec2, Vec3 } from '../../core/contracts';
import { angleDelta, clamp, damp, lerp, m4, v3 } from './math';

/**
 * A sheet as the experience layer sees it: where it is and which way it
 * faces. Derived from a PlaneDesc with planeFromDesc().
 */
export interface Plane {
  /** World position of the sheet's middle. */
  center: Vec3;
  /** Unit normal. */
  normal: Vec3;
  /** Unit axis along the sheet's local +x (width). */
  u: Vec3;
  /** Unit axis along the sheet's local +y (height). */
  v: Vec3;
  /** Half extents in world units. */
  halfSize: Vec2;
}

/** Pose without the lens: what input and the intro steer. */
export interface CameraPose {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
}

export interface CameraRigOptions {
  fovY?: number;
  near?: number;
  far?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Seconds for the camera to cover half the distance to its goal. */
  halfLife?: number;
  /** Seconds without input before the camera starts to drift on its own. */
  idleDelay?: number;
  /** Drift speed in radians per second once fully ramped. */
  idleSpeed?: number;
}

export interface CameraMatrices {
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  invViewProj: Mat4;
  eye: Vec3;
}

const MAX_PITCH = 1.35;

function rotate(q: Quat, p: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v + 2w(q x v) + 2 q x (q x v)
  const t = v3.scale(v3.cross([x, y, z], p), 2);
  return v3.add(v3.add(p, v3.scale(t, w)), v3.cross([x, y, z], t));
}

/** Local +x, +y of the sheet become u, v; local +z is the normal. */
export function planeFromDesc(desc: Pick<PlaneDesc, 'position' | 'rotation' | 'halfSize'>): Plane {
  return {
    center: [desc.position[0], desc.position[1], desc.position[2]],
    u: rotate(desc.rotation, [1, 0, 0]),
    v: rotate(desc.rotation, [0, 1, 0]),
    normal: rotate(desc.rotation, [0, 0, 1]),
    halfSize: [desc.halfSize[0], desc.halfSize[1]],
  };
}

export class CameraRig implements CameraController {
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
  halfLife: number;
  idleDelay: number;
  idleSpeed: number;

  /** Where the camera is right now. */
  state: CameraState;
  /** Where it is heading. Input writes here. */
  goal: CameraPose;
  idleTime = 0;
  driftEnabled = true;
  /** Used by viewProjection(); set it from the canvas each frame. */
  aspect = 1;
  /** Extra damping while flying to a plane, so long moves feel slower. */
  private flight = 0;

  constructor(opts: CameraRigOptions = {}) {
    this.near = opts.near ?? 0.01;
    this.far = opts.far ?? 500;
    this.minDistance = opts.minDistance ?? 0.05;
    this.maxDistance = opts.maxDistance ?? 60;
    this.halfLife = opts.halfLife ?? 0.12;
    this.idleDelay = opts.idleDelay ?? 5;
    this.idleSpeed = opts.idleSpeed ?? 0.035;
    this.state = { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 3, fovY: opts.fovY ?? (50 * Math.PI) / 180 };
    this.goal = { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 3 };
  }

  get fovY(): number {
    return this.state.fovY;
  }

  /** Jump with no animation. Used before the first frame, and on replay. */
  snap(pose: Partial<CameraPose>): void {
    this.goal = clonePose({ ...this.goal, ...pose });
    Object.assign(this.state, clonePose(this.goal));
  }

  /** Mark that the person touched the camera. Stops the idle drift. */
  touch(): void {
    this.idleTime = 0;
  }

  /** Orbit by a drag measured in pixels. */
  orbit(dxPx: number, dyPx: number, viewportHeight: number): void {
    // One viewport height of drag is about 200 degrees: fast enough to flip
    // the stack from face-on to edge-on in a single short stroke.
    const k = 3.5 / Math.max(1, viewportHeight);
    this.goal.yaw -= dxPx * k;
    this.goal.pitch = clamp(this.goal.pitch + dyPx * k, -MAX_PITCH, MAX_PITCH);
    this.touch();
  }

  /** Multiply the camera distance. factor < 1 moves in. */
  zoom(factor: number): void {
    this.goal.distance = clamp(this.goal.distance * factor, this.minDistance, this.maxDistance);
    this.touch();
  }

  /**
   * Fly to a plane and face it squarely.
   * @param aspect viewport width / height
   * @param fill fraction of the view the sheet should occupy
   */
  focusPlane(plane: Plane, aspect: number, fill = 0.86): void {
    // Approach from whichever side of the sheet we are already on.
    const toCam = v3.sub(this.eye(), plane.center);
    const n = v3.dot(toCam, plane.normal) >= 0 ? plane.normal : v3.scale(plane.normal, -1);
    const yaw = Math.atan2(n[0], n[2]);
    const pitch = Math.asin(clamp(n[1], -1, 1));
    const tanY = Math.tan(this.fovY / 2);
    const fitH = plane.halfSize[1] / tanY;
    const fitW = plane.halfSize[0] / (tanY * aspect);
    this.goal.target = [plane.center[0], plane.center[1], plane.center[2]];
    // Take the short way round rather than unwinding accumulated turns.
    this.goal.yaw = this.state.yaw + angleDelta(this.state.yaw, yaw);
    this.goal.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH);
    this.goal.distance = clamp(Math.max(fitH, fitW) / fill, this.minDistance, this.maxDistance);
    this.flight = 1;
    this.touch();
  }

  /** Fly to an arbitrary pose (used for "back to overview"). */
  flyTo(pose: Partial<CameraPose>): void {
    const next = clonePose({ ...this.goal, ...pose });
    next.yaw = this.state.yaw + angleDelta(this.state.yaw, next.yaw);
    this.goal = next;
    this.flight = 1;
    this.touch();
  }

  /**
   * @param dt seconds
   * @param override a pose the intro wants, and how hard it wants it (0..1)
   */
  update(dt: number, override?: { pose: CameraPose; weight: number }): void {
    const g = this.goal;

    if (override && override.weight > 0) {
      // While the intro has full authority it writes the goal directly, so
      // when it lets go the camera simply stays where it was left.
      const w = override.weight;
      g.target = v3.lerp(g.target, override.pose.target, w);
      g.yaw = lerp(g.yaw, override.pose.yaw, w);
      g.pitch = lerp(g.pitch, override.pose.pitch, w);
      g.distance = lerp(g.distance, override.pose.distance, w);
      this.idleTime = 0;
    } else {
      this.idleTime += dt;
      if (this.driftEnabled && this.idleTime > this.idleDelay) {
        // Ease into the drift over a few seconds so it is never noticed starting.
        const ramp = clamp((this.idleTime - this.idleDelay) / 4, 0, 1);
        g.yaw += this.idleSpeed * ramp * ramp * dt;
      }
    }

    const hl = lerp(this.halfLife, 0.32, this.flight);
    this.flight = damp(this.flight, 0, 0.6, dt);
    const s = this.state;
    s.yaw = damp(s.yaw, g.yaw, hl, dt);
    s.pitch = damp(s.pitch, g.pitch, hl, dt);
    // Distance is damped in log space so zooming feels the same at any scale.
    s.distance = Math.exp(damp(Math.log(s.distance), Math.log(g.distance), hl, dt));
    s.target = [
      damp(s.target[0], g.target[0], hl, dt),
      damp(s.target[1], g.target[1], hl, dt),
      damp(s.target[2], g.target[2], hl, dt),
    ];
  }

  /** Unit vector from the target toward the camera. */
  direction(): Vec3 {
    const { yaw, pitch } = this.state;
    const c = Math.cos(pitch);
    return [Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c];
  }

  eye(): Vec3 {
    return v3.add(this.state.target, v3.scale(this.direction(), this.state.distance));
  }

  viewProjection(aspect: number): Mat4 {
    return this.matrices(aspect).viewProj;
  }

  /** @param aspect viewport width / height */
  matrices(aspect: number): CameraMatrices {
    const eye = this.eye();
    const view = m4.lookAt(eye, this.state.target, [0, 1, 0]);
    const proj = m4.perspective(this.fovY, aspect, this.near, this.far);
    const viewProj = m4.multiply(proj, view);
    return { view, proj, viewProj, invViewProj: m4.invert(viewProj) ?? m4.identity(), eye };
  }
}

function clonePose(p: CameraPose): CameraPose {
  return { target: [p.target[0], p.target[1], p.target[2]], yaw: p.yaw, pitch: p.pitch, distance: p.distance };
}
