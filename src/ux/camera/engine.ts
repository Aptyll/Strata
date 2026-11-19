/**
 * Glue between CameraRig and the shared contracts in src/core/contracts.ts.
 *
 *   const camera = createCamera(scene.camera, { reverseZ: false });
 *   const detach = attachCameraInput(canvas, camera.rig);
 *   camera.rig.setPlanes(scene.planes.map(planeTargetFromDesc));
 *   // camera satisfies the CameraController contract:
 *   camera.update(dt);
 *   camera.viewProjection(width / height);
 */

import type {
  CameraController,
  CameraState,
  Mat4,
  PlaneDesc,
  Quat,
  Vec3,
} from "../../core/contracts";
import { quatFromAxisAngle, quatMul, quatRotate } from "./math";
import { CameraRig } from "./rig";
import type { CameraOptionsInput, CameraPose, PlaneTarget } from "./rig";

/** Orientation for a yaw around +Y followed by a pitch around the camera's X. */
export const orientationFromYawPitch = (yaw: number, pitch: number): Quat =>
  quatMul(quatFromAxisAngle([0, 1, 0], yaw), quatFromAxisAngle([1, 0, 0], pitch));

/** Inverse of orientationFromYawPitch. Any roll in the orientation is dropped. */
export const yawPitchFromOrientation = (q: Quat): { yaw: number; pitch: number } => {
  const f = quatRotate(q, [0, 0, -1]);
  return {
    yaw: Math.atan2(-f[0], -f[2]),
    pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))),
  };
};

export const poseFromState = (state: CameraState): CameraPose => ({
  target: [state.target[0], state.target[1], state.target[2]],
  orientation: orientationFromYawPitch(state.yaw, state.pitch),
  distance: state.distance,
});

/** A scene plane as something the camera can pick and frame. */
export const planeTargetFromDesc = (desc: PlaneDesc): PlaneTarget => ({
  id: desc.id,
  center: desc.position,
  // Sheets lie in their local XY plane, facing local +Z.
  normal: quatRotate(desc.rotation, [0, 0, 1]),
  up: quatRotate(desc.rotation, [0, 1, 0]),
  width: desc.halfSize[0] * 2,
  height: desc.halfSize[1] * 2,
});

/**
 * A CameraRig behind the engine's CameraController contract.
 *
 * `state` is live: reading it gives the pose on screen (handy for saving a
 * scene), and assigning to it or to one of its fields moves the camera at
 * once with no animation. Use `rig` for everything richer: flights, focus,
 * idle drift, input.
 */
export class EngineCamera implements CameraController {
  readonly rig: CameraRig;
  private readonly liveState: CameraState;

  constructor(initial?: CameraState, options: CameraOptionsInput = {}) {
    const opts: CameraOptionsInput = { ...options };
    if (initial) {
      opts.fovY = initial.fovY;
      opts.initial = poseFromState(initial);
    }
    this.rig = new CameraRig(opts);

    const rig = this.rig;
    const read = () => {
      const pose = rig.getPose();
      return { pose, ...yawPitchFromOrientation(pose.orientation) };
    };
    const write = (patch: Partial<CameraState>) => {
      const { pose, yaw, pitch } = read();
      if (patch.fovY !== undefined) rig.options.fovY = patch.fovY;
      rig.setPose({
        target: patch.target ? [patch.target[0], patch.target[1], patch.target[2]] : pose.target,
        orientation:
          patch.yaw !== undefined || patch.pitch !== undefined
            ? orientationFromYawPitch(patch.yaw ?? yaw, patch.pitch ?? pitch)
            : pose.orientation,
        distance: patch.distance ?? pose.distance,
      });
      rig.refresh();
    };
    this.liveState = {
      get target(): Vec3 {
        return read().pose.target;
      },
      set target(v: Vec3) {
        write({ target: v });
      },
      get yaw(): number {
        return read().yaw;
      },
      set yaw(v: number) {
        write({ yaw: v });
      },
      get pitch(): number {
        return read().pitch;
      },
      set pitch(v: number) {
        write({ pitch: v });
      },
      get distance(): number {
        return read().pose.distance;
      },
      set distance(v: number) {
        write({ distance: v });
      },
      get fovY(): number {
        return rig.options.fovY;
      },
      set fovY(v: number) {
        write({ fovY: v });
      },
    };
  }

  get state(): CameraState {
    return this.liveState;
  }

  set state(next: CameraState) {
    this.rig.options.fovY = next.fovY;
    this.rig.setPose(poseFromState(next));
    this.rig.refresh();
  }

  /** A plain JSON copy of the current state, for saving into a Scene. */
  snapshot(): CameraState {
    const s = this.liveState;
    return { target: s.target, yaw: s.yaw, pitch: s.pitch, distance: s.distance, fovY: s.fovY };
  }

  update(dt: number): void {
    this.rig.update(dt);
  }

  eye(): Vec3 {
    return this.rig.eye;
  }

  viewProjection(aspect: number): Mat4 {
    this.rig.setAspect(aspect);
    return this.rig.viewProjection;
  }
}

export const createCamera = (
  initial?: CameraState,
  options?: CameraOptionsInput,
): EngineCamera => new EngineCamera(initial, options);
