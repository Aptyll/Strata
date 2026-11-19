// Camera for the first-run experience.
//
// This is a thin front for the shared camera in src/ux/camera, so the intro,
// the standalone experience and the app all move with one feel: the same
// smoothing, focus flights, pitch limits and idle drift (docs/ux/camera.md).
// It keeps the small API the experience was written against.
//
// Pose convention here: `pitch` is the elevation of the eye as seen from the
// target, so a positive pitch looks down. The shared CameraState on main uses
// the opposite sign (pitch of the view direction). `sharedState()` converts.

import type { CameraController, CameraState, Mat4, PlaneDesc, Quat, Vec2, Vec3 } from '../../core/contracts';
import { CameraRig as SharedRig, orientationFromYawPitch, yawPitchFromOrientation } from '../camera';
import type { CameraPose as SharedPose } from '../camera';
import { m4, v3 } from './math';

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
  /** Smoothing time constant in seconds. Defaults to the shared camera's. */
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

const toShared = (p: CameraPose): SharedPose => ({
  target: [p.target[0], p.target[1], p.target[2]],
  orientation: orientationFromYawPitch(p.yaw, -p.pitch),
  distance: p.distance,
});

const fromShared = (p: SharedPose): CameraPose => {
  const { yaw, pitch } = yawPitchFromOrientation(p.orientation);
  // `|| 0` turns -0 into 0 so a camera at rest reports clean zeros.
  return { target: p.target, yaw: yaw || 0, pitch: -pitch || 0, distance: p.distance };
};

export class CameraRig implements CameraController {
  /** The shared camera doing the work. Use it for anything not wrapped here. */
  readonly shared: SharedRig;
  /** Used by viewProjection(); set it from the canvas each frame. */
  aspect = 1;

  constructor(opts: CameraRigOptions = {}) {
    this.shared = new SharedRig({
      fovY: opts.fovY ?? (50 * Math.PI) / 180,
      near: opts.near ?? 0.01,
      far: opts.far ?? 500,
      minDistance: opts.minDistance ?? 0.05,
      maxDistance: opts.maxDistance ?? 60,
      ...(opts.halfLife !== undefined ? { smoothing: opts.halfLife / Math.LN2 } : {}),
      idle: {
        delay: opts.idleDelay ?? 5,
        ...(opts.idleSpeed !== undefined ? { orbitRate: opts.idleSpeed } : {}),
      },
      initial: toShared({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 3 }),
    });
  }

  get near(): number {
    return this.shared.options.near;
  }
  get far(): number {
    return this.shared.options.far;
  }
  get minDistance(): number {
    return this.shared.options.minDistance;
  }
  get maxDistance(): number {
    return this.shared.options.maxDistance;
  }
  get fovY(): number {
    return this.shared.options.fovY;
  }

  get driftEnabled(): boolean {
    return this.shared.options.idle.enabled;
  }
  set driftEnabled(on: boolean) {
    this.shared.options.idle.enabled = on;
  }

  /** Where the camera is right now, in this file's pose convention. */
  get state(): CameraState {
    return { ...fromShared(this.shared.getPose()), fovY: this.fovY };
  }

  /** The same, in the shared CameraState convention used by scenes on main. */
  sharedState(): CameraState {
    const s = this.state;
    return { ...s, pitch: -s.pitch };
  }

  /** Where it is heading. Read-only: steer with the methods below. */
  get goal(): CameraPose {
    // While the idle drift runs it is the drift that is steering, so report that.
    const s = this.shared;
    return fromShared(s.idleAmount > 0 ? s.getPose() : s.getGoalPose());
  }

  /** Jump with no animation. Used before the first frame, and on replay. */
  snap(pose: Partial<CameraPose>): void {
    this.shared.setPose(toShared({ ...this.goal, ...pose }));
    this.shared.refresh();
  }

  /** Mark that the person touched the camera. Stops the idle drift. */
  touch(): void {
    this.shared.wake();
  }

  /** Orbit by a drag measured in pixels. */
  orbit(dxPx: number, dyPx: number, viewportHeight: number): void {
    // One viewport height of drag is half a turn, as everywhere else.
    const k = Math.PI / Math.max(1, viewportHeight);
    this.shared.rotate(-dxPx * k, -dyPx * k);
  }

  /** Multiply the camera distance. factor < 1 moves in. */
  zoom(factor: number): void {
    if (factor > 0) this.shared.zoom(Math.log(factor));
  }

  /**
   * Fly to a plane and face it squarely.
   * @param aspect viewport width / height
   * @param fill fraction of the view the sheet should occupy
   */
  focusPlane(plane: Plane, aspect: number, fill = 0.86): void {
    this.shared.setAspect(aspect);
    const target = {
      center: plane.center,
      normal: plane.normal,
      up: plane.v,
      width: plane.halfSize[0] * 2,
      height: plane.halfSize[1] * 2,
    };
    // Same flight as the shared camera, framed to this caller's fill.
    const pose = this.shared.poseForPlane(target);
    const tanY = Math.tan(this.fovY / 2);
    const fit = Math.max(plane.halfSize[1] / tanY, plane.halfSize[0] / (tanY * aspect));
    pose.distance = fit / Math.max(fill, 1e-3);
    this.shared.flyTo(pose);
  }

  /** Fly to an arbitrary pose (used for "back to overview"). */
  flyTo(pose: Partial<CameraPose>): void {
    this.shared.flyTo(toShared({ ...this.goal, ...pose }));
  }

  /**
   * @param dt seconds
   * @param override a pose the intro wants, and how hard it wants it (0..1)
   */
  update(dt: number, override?: { pose: CameraPose; weight: number }): void {
    if (override && override.weight > 0) this.shared.steer(toShared(override.pose), override.weight);
    this.shared.update(dt);
  }

  /** Unit vector from the target toward the camera. */
  direction(): Vec3 {
    return v3.scale(this.shared.forward, -1);
  }

  eye(): Vec3 {
    return this.shared.eye;
  }

  viewProjection(aspect: number): Mat4 {
    return this.matrices(aspect).viewProj;
  }

  /** @param aspect viewport width / height */
  matrices(aspect: number): CameraMatrices {
    this.shared.setAspect(aspect);
    const { view, projection, viewProjection, eye } = this.shared;
    return {
      view,
      proj: projection,
      viewProj: viewProjection,
      invViewProj: m4.invert(viewProjection) ?? m4.identity(),
      eye,
    };
  }
}
