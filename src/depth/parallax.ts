// Parallax rig: moves the eye sideways while it keeps looking at the focus
// point. The focused plane stays put on screen, nearer planes slide against
// the motion and farther planes slide with it, which is the strongest depth
// cue available for flat layers.

import type { Vec3 } from '../core/contracts';

export interface ParallaxOptions {
  /** Eye travel in world units when the pointer is at the screen edge. */
  pointerAmount?: number;
  /** Amplitude of the idle drift in world units. */
  driftAmount?: number;
  /** Idle drift speed multiplier. */
  driftSpeed?: number;
  /** Smoothing time constant in seconds. */
  tau?: number;
}

export class ParallaxRig {
  pointerAmount: number;
  driftAmount: number;
  driftSpeed: number;
  tau: number;
  enabled = true;
  x = 0;
  y = 0;
  time = 0;

  constructor({ pointerAmount = 2.5, driftAmount = 0.8, driftSpeed = 1, tau = 0.35 }: ParallaxOptions = {}) {
    this.pointerAmount = pointerAmount;
    this.driftAmount = driftAmount;
    this.driftSpeed = driftSpeed;
    this.tau = tau;
  }

  /**
   * @param dt seconds
   * @param px pointer x in [-1, 1], 0 at screen centre
   * @param py pointer y in [-1, 1], up positive
   * @returns eye offset along camera right (x) and up (y)
   */
  update(dt: number, px = 0, py = 0): { x: number; y: number } {
    this.time += dt * this.driftSpeed;
    const t = this.time;
    let tx = 0;
    let ty = 0;
    if (this.enabled) {
      // Two incommensurate sines per axis: never visibly repeats.
      tx = px * this.pointerAmount + this.driftAmount * (Math.sin(t * 0.31) + 0.5 * Math.sin(t * 0.73 + 1.3));
      ty = py * this.pointerAmount + this.driftAmount * (Math.sin(t * 0.23 + 2.1) + 0.5 * Math.sin(t * 0.59));
    }
    const k = this.tau > 0 ? 1 - Math.exp(-Math.max(dt, 0) / this.tau) : 1;
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
    return { x: this.x, y: this.y };
  }

  /** Apply the current offset to a camera. Feed the result to a lookAt. */
  apply(eye: Vec3, forward: Vec3, right: Vec3, up: Vec3, focusDist: number): { eye: Vec3; target: Vec3 } {
    return {
      eye: [
        eye[0] + right[0] * this.x + up[0] * this.y,
        eye[1] + right[1] * this.x + up[1] * this.y,
        eye[2] + right[2] * this.x + up[2] * this.y,
      ],
      target: [
        eye[0] + forward[0] * focusDist,
        eye[1] + forward[1] * focusDist,
        eye[2] + forward[2] * focusDist,
      ],
    };
  }
}
