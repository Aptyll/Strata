/**
 * Scripted camera paths for cinematic shots.
 *
 * A path is just "pose as a function of time", so it is fully deterministic
 * and independent of frame rate. This module knows nothing about the engine's
 * camera class: it produces a plain pose that the engine applies however it
 * likes (see `applyCamera` in renderOffline).
 */

export type Vec3 = [number, number, number];

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Roll around the view axis in degrees. */
  roll: number;
}

export interface CameraPath<TPose = CameraPose> {
  /** Length in seconds. */
  readonly duration: number;
  /** Pose at time `t` seconds. Times outside the path are clamped (or wrapped if looping). */
  sample(t: number): TPose;
}

export type Easing = 'linear' | 'smooth' | 'smoother' | 'ease-in' | 'ease-out' | ((u: number) => number);

const EASINGS: Record<Exclude<Easing, (u: number) => number>, (u: number) => number> = {
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  smoother: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  'ease-in': (u) => u * u,
  'ease-out': (u) => 1 - (1 - u) * (1 - u),
};

function easingFn(e: Easing | undefined): (u: number) => number {
  if (!e) return EASINGS.linear;
  return typeof e === 'function' ? e : EASINGS[e];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface CameraKeyframe {
  /** Time of this keyframe in seconds. */
  t: number;
  position: Vec3;
  /** Point the camera looks at. Default: the previous keyframe's target, or the origin. */
  target?: Vec3;
  /** Vertical field of view in degrees. Default: carried over from the previous keyframe, or 50. */
  fov?: number;
  /** Roll in degrees. Default: carried over, or 0. */
  roll?: number;
}

export interface KeyframePathOptions {
  /** Easing applied to time across the whole path. Default 'linear'. */
  ease?: Easing;
  /**
   * 'spline' (default) passes smoothly through every keyframe.
   * 'linear' moves in straight lines between them.
   */
  interpolation?: 'spline' | 'linear';
  /** Treat the path as a closed loop: the last keyframe flows back into the first. */
  loop?: boolean;
  up?: Vec3;
}

/** Spline through rows of numbers at given times. Shared by the path builders below. */
function splineSampler(
  times: number[],
  values: number[][],
  opts: Pick<KeyframePathOptions, 'ease' | 'interpolation' | 'loop'>,
): { duration: number; sample(t: number): number[] } {
  const n = times.length;
  const C = values[0].length;
  const duration = times[n - 1];
  const ease = easingFn(opts.ease);
  const loop = !!opts.loop && n > 2;
  const linear = opts.interpolation === 'linear';

  // Tangents by finite differences over the neighbouring keyframes, which
  // stays correct when keyframes are unevenly spaced in time.
  const tangents: number[][] = values.map((_, i) => {
    const out = new Array<number>(C).fill(0);
    if (n < 2 || linear) return out;
    let a: number;
    let b: number;
    let span: number;
    if (loop) {
      // In a loop the last keyframe coincides with the first.
      const m = n - 1;
      a = (i - 1 + m) % m;
      b = (i + 1) % m;
      const prevDt = i === 0 ? times[m] - times[m - 1] : times[i] - times[i - 1];
      const nextDt = i >= m ? times[1] - times[0] : times[i + 1] - times[i];
      span = prevDt + nextDt;
    } else {
      a = Math.max(i - 1, 0);
      b = Math.min(i + 1, n - 1);
      span = times[b] - times[a];
    }
    if (span <= 0) return out;
    for (let c = 0; c < C; c++) out[c] = (values[b][c] - values[a][c]) / span;
    return out;
  });

  return {
    duration,
    sample(t: number): number[] {
      let u01 = 0;
      if (duration > 0) u01 = loop ? (((t % duration) + duration) % duration) / duration : clamp01(t / duration);
      const local = ease(u01) * duration;

      let i = 0;
      while (i < n - 2 && local >= times[i + 1]) i++;
      const j = Math.min(i + 1, n - 1);
      const h = times[j] - times[i];
      const u = h > 0 ? clamp01((local - times[i]) / h) : 0;
      const out = new Array<number>(C);
      if (linear || h <= 0) {
        for (let c = 0; c < C; c++) out[c] = values[i][c] + (values[j][c] - values[i][c]) * u;
      } else {
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = u3 - 2 * u2 + u;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = u3 - u2;
        for (let c = 0; c < C; c++) {
          out[c] =
            h00 * values[i][c] + h10 * h * tangents[i][c] + h01 * values[j][c] + h11 * h * tangents[j][c];
        }
      }
      return out;
    },
  };
}

/**
 * Camera path through a list of keyframes. Position, target, field of view
 * and roll are all interpolated with the same cubic Hermite spline.
 */
export function keyframePath(keys: CameraKeyframe[], opts: KeyframePathOptions = {}): CameraPath {
  if (keys.length === 0) throw new Error('capture: a camera path needs at least one keyframe.');
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const up = opts.up ?? [0, 1, 0];
  const values: number[][] = [];
  let target: Vec3 = [0, 0, 0];
  let fov = 50;
  let roll = 0;
  for (const k of sorted) {
    target = k.target ?? target;
    fov = k.fov ?? fov;
    roll = k.roll ?? roll;
    values.push([...k.position, ...target, fov, roll]);
  }
  const spline = splineSampler(
    sorted.map((k) => k.t - sorted[0].t),
    values,
    opts,
  );
  return {
    duration: spline.duration,
    sample(t: number): CameraPose {
      const o = spline.sample(t);
      return {
        position: [o[0], o[1], o[2]],
        target: [o[3], o[4], o[5]],
        up: [up[0], up[1], up[2]],
        fov: o[6],
        roll: o[7],
      };
    },
  };
}

/** A plain object whose fields are numbers or arrays of numbers. */
export type NumericState = Record<string, number | number[]>;

/**
 * Camera path through keyframes of any numeric state object, interpolated
 * field by field with the same spline as {@link keyframePath}.
 *
 * Use this to script the engine's own camera state directly, for example
 * `{ target, yaw, pitch, distance, fovY }`, so no conversion is needed.
 * Angles are interpolated as plain numbers: go from yaw 0 to yaw 2 * PI for a
 * full turn.
 */
export function statePath<T extends object>(
  keys: { t: number; state: T }[],
  opts: Omit<KeyframePathOptions, 'up'> = {},
): CameraPath<T> {
  if (keys.length === 0) throw new Error('capture: a camera path needs at least one keyframe.');
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const first = sorted[0].state as unknown as NumericState;
  const fields = Object.keys(first).map((name) => {
    const v = first[name];
    return { name, length: Array.isArray(v) ? v.length : -1 };
  });
  const values = sorted.map((k) => {
    const row: number[] = [];
    const state = k.state as unknown as NumericState;
    for (const f of fields) {
      const v = state[f.name];
      if (f.length < 0) row.push(v as number);
      else for (let i = 0; i < f.length; i++) row.push((v as number[])[i]);
    }
    if (row.some((x) => typeof x !== 'number' || Number.isNaN(x))) {
      throw new Error(`capture: keyframe at t=${k.t} has a missing or non-numeric field.`);
    }
    return row;
  });
  const spline = splineSampler(
    sorted.map((k) => k.t - sorted[0].t),
    values,
    opts,
  );
  return {
    duration: spline.duration,
    sample(t: number): T {
      const o = spline.sample(t);
      const out: NumericState = {};
      let c = 0;
      for (const f of fields) {
        if (f.length < 0) out[f.name] = o[c++];
        else {
          out[f.name] = o.slice(c, c + f.length);
          c += f.length;
        }
      }
      return out as unknown as T;
    },
  };
}

export interface OrbitPathOptions {
  /** Length in seconds. */
  duration: number;
  center?: Vec3;
  /** Distance from the centre. A [start, end] pair zooms during the shot. */
  radius: number | [number, number];
  /** Height above the centre along the up axis. A pair cranes during the shot. */
  height?: number | [number, number];
  /** Number of full revolutions over the duration. Negative reverses. Default 1. */
  turns?: number;
  /** Starting angle in degrees. Default 0. */
  startAngle?: number;
  /** Vertical field of view in degrees, or a [start, end] pair. Default 50. */
  fov?: number | [number, number];
  /** Easing applied to time. Default 'linear', which loops seamlessly with whole turns. */
  ease?: Easing;
}

const pair = (v: number | [number, number]): [number, number] => (typeof v === 'number' ? [v, v] : v);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Orbit around a point, about the Y axis. With whole `turns` it loops seamlessly. */
export function orbitPath(opts: OrbitPathOptions): CameraPath {
  const center = opts.center ?? [0, 0, 0];
  const [r0, r1] = pair(opts.radius);
  const [h0, h1] = pair(opts.height ?? 0);
  const [f0, f1] = pair(opts.fov ?? 50);
  const turns = opts.turns ?? 1;
  const start = ((opts.startAngle ?? 0) * Math.PI) / 180;
  const ease = easingFn(opts.ease);
  return {
    duration: opts.duration,
    sample(t: number): CameraPose {
      const u = ease(clamp01(opts.duration > 0 ? t / opts.duration : 0));
      const angle = start + u * turns * Math.PI * 2;
      const r = lerp(r0, r1, u);
      return {
        position: [center[0] + Math.sin(angle) * r, center[1] + lerp(h0, h1, u), center[2] + Math.cos(angle) * r],
        target: [center[0], center[1], center[2]],
        up: [0, 1, 0],
        fov: lerp(f0, f1, u),
        roll: 0,
      };
    },
  };
}

/** Plays several paths one after another (hard cuts between them). */
export function sequencePath<TPose>(paths: CameraPath<TPose>[]): CameraPath<TPose> {
  if (paths.length === 0) throw new Error('capture: sequencePath needs at least one path.');
  const duration = paths.reduce((sum, p) => sum + p.duration, 0);
  return {
    duration,
    sample(t: number): TPose {
      let local = Math.min(Math.max(t, 0), duration);
      for (let i = 0; i < paths.length; i++) {
        if (local < paths[i].duration || i === paths.length - 1) return paths[i].sample(local);
        local -= paths[i].duration;
      }
      return paths[paths.length - 1].sample(local);
    },
  };
}

/** Wraps any function of time as a camera path. */
export function functionPath<TPose>(duration: number, sample: (t: number) => TPose): CameraPath<TPose> {
  return { duration, sample };
}

/**
 * Right-handed look-at view matrix for a pose, column-major, as WebGPU and
 * WGSL expect. Convenience for engines that take a raw view matrix.
 */
export function viewMatrix(pose: CameraPose, out = new Float32Array(16)): Float32Array {
  const [ex, ey, ez] = pose.position;
  // Forward (camera looks down -Z, so z axis points from target to eye).
  let zx = ex - pose.target[0];
  let zy = ey - pose.target[1];
  let zz = ez - pose.target[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l;
  zy /= l;
  zz /= l;
  // Right = up x z.
  let xx = pose.up[1] * zz - pose.up[2] * zy;
  let xy = pose.up[2] * zx - pose.up[0] * zz;
  let xz = pose.up[0] * zy - pose.up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  if (l < 1e-8) {
    // Looking straight along the up axis: pick any perpendicular.
    xx = 1;
    xy = 0;
    xz = 0;
    l = 1;
  }
  xx /= l;
  xy /= l;
  xz /= l;
  let yx = zy * xz - zz * xy;
  let yy = zz * xx - zx * xz;
  let yz = zx * xy - zy * xx;
  if (pose.roll) {
    const a = (pose.roll * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rx = xx * c + yx * s;
    const ry = xy * c + yy * s;
    const rz = xz * c + yz * s;
    yx = yx * c - xx * s;
    yy = yy * c - xy * s;
    yz = yz * c - xz * s;
    xx = rx;
    xy = ry;
    xz = rz;
  }
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}
