// The cursor as a physical thing.
//
// A brush is what the simulation sees of a pointer: a spot on one plane with
// a radius and a signed strength. Positive strength pulls particles in,
// negative pushes them away. Up to MAX_BRUSHES can be live at once (one per
// finger), and they pack into a flat Float32Array ready for a uniform buffer.
//
// Three behaviours, in rising order of intent:
//   wake     the pointer just moving over a sheet parts the particles gently
//   attract  press and hold: a well that deepens the longer it is held
//   repel    secondary button, or Shift/Alt + hold: a pressure bubble
// Releasing an attract well fires a short outward burst scaled by how long
// it was charged, so "gather, then let go" is a complete gesture.

import { clamp, damp } from './math';
import type { PlaneHit } from './pointer-ray';

export const MAX_BRUSHES = 4;
/** Floats per brush in the packed buffer. */
export const BRUSH_STRIDE = 8;

export const BRUSH_DEFAULTS = Object.freeze({
  /** Brush radius on screen, in CSS pixels, before charge widens it. */
  radiusPx: 90,
  /** Radius never exceeds this fraction of the plane's smaller half-size. */
  maxRadiusFrac: 0.6,
  /** Seconds of holding for a well to reach full depth. */
  chargeSeconds: 1.6,
  /** Strength of the passive wake, as a fraction of full repel. */
  wakeStrength: 0.12,
  /** Wake needs the pointer to be moving this fast (plane units / s) to count. */
  wakeSpeed: 0.4,
  /** Outward burst on release, relative to full strength. */
  burstGain: 1.8,
  /** Seconds the release burst lasts. */
  burstSeconds: 0.35,
  /** Half-life for smoothing the brush position. */
  followHalfLife: 0.035,
});

export type BrushMode = 'idle' | 'wake' | 'attract' | 'repel';
export type BrushConfig = { -readonly [K in keyof typeof BRUSH_DEFAULTS]: number };

export interface BrushOutput {
  /** Plane index, -1 when inactive. */
  plane: number;
  /** -1..1 on the plane. */
  u: number;
  v: number;
  /** In plane units (same space as u, v). */
  radius: number;
  /** Signed, roughly -2..1. Positive attracts. */
  strength: number;
  /** Brush velocity, plane units per second. */
  du: number;
  dv: number;
  /** 0..1, how long it has been held. */
  charge: number;
}

export class ForceBrush {
  cfg: BrushConfig;
  mode: BrushMode = 'idle';
  plane = -1;
  u = 0;
  v = 0;
  du = 0;
  dv = 0;
  charge = 0;
  radius = 0;
  /** Remaining release burst, 0..1. */
  private burst = 0;
  private burstCharge = 0;
  private grip = 0;
  private hasPos = false;

  constructor(opts: Partial<BrushConfig> = {}) {
    this.cfg = { ...BRUSH_DEFAULTS, ...opts };
  }

  /** Begin a deliberate force. */
  press(mode: 'attract' | 'repel'): void {
    this.mode = mode;
    this.charge = 0;
  }

  /** End a deliberate force. An attract well lets go with a burst. */
  release(): void {
    if (this.mode === 'attract' && this.charge > 0.15) {
      this.burst = 1;
      this.burstCharge = this.charge;
    }
    this.mode = this.hasPos ? 'wake' : 'idle';
    this.charge = 0;
  }

  /** The pointer left the surface entirely. */
  leave(): void {
    this.mode = 'idle';
    this.charge = 0;
    this.hasPos = false;
  }

  /**
   * @param dt seconds
   * @param hit where the pointer is now, or null when it is over nothing
   * @param radius brush radius in plane units for this hit
   */
  update(dt: number, hit: PlaneHit | null, radius: number): BrushOutput {
    const c = this.cfg;
    if (hit) {
      // Switching sheets must not drag a streak across the gap.
      if (!this.hasPos || hit.index !== this.plane) {
        this.u = hit.u;
        this.v = hit.v;
        this.du = this.dv = 0;
        this.plane = hit.index;
        this.hasPos = true;
        if (this.mode === 'idle') this.mode = 'wake';
      } else if (dt > 0) {
        const nu = damp(this.u, hit.u, c.followHalfLife, dt);
        const nv = damp(this.v, hit.v, c.followHalfLife, dt);
        this.du = damp(this.du, (nu - this.u) / dt, 0.05, dt);
        this.dv = damp(this.dv, (nv - this.v) / dt, 0.05, dt);
        this.u = nu;
        this.v = nv;
      }
      this.grip = hit.grip;
      this.radius = radius;
    } else {
      this.du = damp(this.du, 0, 0.05, dt);
      this.dv = damp(this.dv, 0, 0.05, dt);
      if (this.mode === 'wake') this.mode = 'idle';
      this.grip = damp(this.grip, 0, 0.05, dt);
    }

    let strength = 0;
    if (this.mode === 'attract' || this.mode === 'repel') {
      this.charge = clamp(this.charge + dt / c.chargeSeconds, 0, 1);
      // Starts at 35% so a quick press still does something visible.
      const depth = 0.35 + 0.65 * this.charge;
      strength = this.mode === 'attract' ? depth : -depth;
    } else if (this.mode === 'wake') {
      const speed = Math.hypot(this.du, this.dv);
      strength = -c.wakeStrength * clamp(speed / c.wakeSpeed, 0, 1);
    }

    if (this.burst > 0) {
      strength -= c.burstGain * this.burstCharge * this.burst * this.burst;
      this.burst = Math.max(0, this.burst - dt / c.burstSeconds);
    }

    strength *= this.grip;
    const active = this.hasPos && this.plane >= 0 && Math.abs(strength) > 1e-4;
    return {
      plane: active ? this.plane : -1,
      u: this.u,
      v: this.v,
      // A charged well reaches further.
      radius: this.radius * (1 + 0.5 * this.charge),
      strength: active ? strength : 0,
      du: this.du,
      dv: this.dv,
      charge: this.charge,
    };
  }
}

/**
 * Pack brush outputs for the GPU. Layout per brush (8 floats, 32 bytes):
 *   [0] u  [1] v  [2] radius  [3] strength
 *   [4] du [5] dv [6] plane index (-1 = inactive)  [7] charge
 * Matches a WGSL struct { pos: vec2f, radius: f32, strength: f32,
 *                         vel: vec2f, plane: f32, charge: f32 }.
 */
export function packBrushes(
  brushes: ReadonlyArray<BrushOutput | null | undefined>,
  out: Float32Array = new Float32Array(MAX_BRUSHES * BRUSH_STRIDE),
): Float32Array {
  for (let i = 0; i < MAX_BRUSHES; i++) {
    const o = i * BRUSH_STRIDE;
    const b = brushes[i];
    if (!b || b.plane < 0) {
      out.fill(0, o, o + BRUSH_STRIDE);
      out[o + 6] = -1;
      continue;
    }
    out[o] = b.u; out[o + 1] = b.v; out[o + 2] = b.radius; out[o + 3] = b.strength;
    out[o + 4] = b.du; out[o + 5] = b.dv; out[o + 6] = b.plane; out[o + 7] = b.charge;
  }
  return out;
}

/**
 * Reference force for one particle from one brush, in plane units.
 * The engine will do this in WGSL; this is the shape to copy, and what the
 * 2D fallback and the demo use.
 *
 * The falloff is smooth and finite: zero at the edge of the radius, and it
 * goes soft at the very centre so an attract well forms a ring, not a
 * singularity that eats every particle.
 *
 * Returns the acceleration (ax, ay).
 */
export function brushForce(
  px: number, py: number,
  b: Pick<BrushOutput, 'u' | 'v' | 'radius' | 'strength'>,
  gain = 1,
): [number, number] {
  const dx = b.u - px;
  const dy = b.v - py;
  const r2 = dx * dx + dy * dy;
  const R = b.radius;
  if (r2 >= R * R || R <= 0) return [0, 0];
  const r = Math.sqrt(r2) + 1e-6;
  const q = r / R;
  const falloff = (1 - q) * (1 - q);
  const core = q / (q + 0.12);
  const a = (b.strength * gain * falloff * core) / r;
  return [dx * a, dy * a];
}
