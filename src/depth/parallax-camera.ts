// Parallax for any CameraController: wraps a camera and slides its eye
// sideways with the pointer (and an optional idle drift) while the focus
// distance stays put on screen. Nearer planes slide against the motion,
// farther planes slide with it.
//
// It needs nothing from the wrapped camera beyond the contract. The camera's
// right and up axes are read back out of its view-projection matrix, and the
// shift is applied as an off-axis projection, so it works with any camera
// that produces a perspective viewProjection.

import type { CameraController, CameraState, Mat4, Vec3 } from '../core/contracts';
import { ParallaxRig, type ParallaxOptions } from './parallax';

export interface ParallaxCameraOptions extends ParallaxOptions {
  /** Distance that holds still on screen. Default: the camera's orbit distance. */
  focusDist?: () => number;
  /**
   * Eye travel is given as a fraction of the focus distance instead of world
   * units, so the effect looks the same at any world scale. Default true.
   */
  relative?: boolean;
  /** Start switched on. Default true. */
  enabled?: boolean;
}

export interface ParallaxCamera extends CameraController {
  readonly inner: CameraController;
  readonly parallax: ParallaxRig;
  /** Pointer position in [-1, 1] on both axes, 0 at the centre, up positive. */
  setPointer(x: number, y: number): void;
  /** Feed pointer positions from an element's pointermove events. Returns a detach function. */
  attach(element: HTMLElement): () => void;
}

const DEFAULTS: Required<ParallaxOptions> = { pointerAmount: 0.03, driftAmount: 0, driftSpeed: 1, tau: 0.35 };

export function createParallaxCamera(inner: CameraController, options: ParallaxCameraOptions = {}): ParallaxCamera {
  const relative = options.relative ?? true;
  const rig = new ParallaxRig(relative ? { ...DEFAULTS, ...options } : options);
  rig.enabled = options.enabled ?? true;
  const focusDist = options.focusDist ?? (() => inner.state.distance);
  let px = 0;
  let py = 0;
  let offset: Vec3 = [0, 0, 0];
  const out = new Float32Array(16);

  return {
    inner,
    parallax: rig,
    get state(): CameraState {
      return inner.state;
    },
    set state(next: CameraState) {
      inner.state = next;
    },
    setPointer(x: number, y: number): void {
      px = Math.max(-1, Math.min(1, x));
      py = Math.max(-1, Math.min(1, y));
    },
    attach(element: HTMLElement): () => void {
      const move = (e: PointerEvent): void => {
        const r = element.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        this.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
      };
      element.addEventListener('pointermove', move);
      return () => element.removeEventListener('pointermove', move);
    },
    update(dt: number): void {
      inner.update(dt);
      rig.update(dt, px, py);
    },
    eye(): Vec3 {
      const e = inner.eye();
      return [e[0] + offset[0], e[1] + offset[1], e[2] + offset[2]];
    },
    viewProjection(aspect: number): Mat4 {
      const m = inner.viewProjection(aspect);
      const f = Math.max(focusDist(), 1e-6);
      const scale = relative ? f : 1;
      const ox = rig.x * scale;
      const oy = rig.y * scale;
      if (ox === 0 && oy === 0) {
        offset = [0, 0, 0];
        return m;
      }
      // Rows 0 and 1 of a perspective view-projection point along the camera's right and up axes.
      const rl = Math.hypot(m[0], m[4], m[8]) || 1;
      const ul = Math.hypot(m[1], m[5], m[9]) || 1;
      const d: Vec3 = [
        (m[0] / rl) * ox + (m[1] / ul) * oy,
        (m[4] / rl) * ox + (m[5] / ul) * oy,
        (m[8] / rl) * ox + (m[9] / ul) * oy,
      ];
      offset = d;
      // Clip space image of the eye offset (d is a direction, so no translation column).
      const cx = m[0] * d[0] + m[4] * d[1] + m[8] * d[2];
      const cy = m[1] * d[0] + m[5] * d[1] + m[9] * d[2];
      const cz = m[2] * d[0] + m[6] * d[1] + m[10] * d[2];
      const cw = m[3] * d[0] + m[7] * d[1] + m[11] * d[2];
      out.set(m);
      // Move the eye: viewProj * translate(-d).
      out[12] -= cx;
      out[13] -= cy;
      out[14] -= cz;
      out[15] -= cw;
      // Shift the lens back so that points at the focus distance do not move.
      const sx = cx / f;
      const sy = cy / f;
      for (let c = 0; c < 16; c += 4) {
        out[c] += sx * out[c + 3];
        out[c + 1] += sy * out[c + 3];
      }
      return out;
    },
  };
}
