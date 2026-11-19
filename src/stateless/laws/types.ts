/**
 * The shape of a stateless motion law.
 *
 * A law is a pure function of a particle and the time. It is written against
 * continuous coordinates `q` in [0, 1)^3 rather than against the key:
 *
 *   fn <qFn>(q: vec3f, t: f32, p: array<f32, 8>) -> vec2f   // the law itself
 *   fn <fn>(key: Key, t: f32, p: array<f32, 8>) -> vec2f    // = <qFn>(qFromKey(key), t, p)
 *
 * The key form is what the offline renderer and the trillion kernel call
 * today. The q form lets a renderer feed stratified coordinates instead, so
 * that neighbouring particles land near each other on screen. Every law here
 * is continuous in q.x and q.y, takes discrete choices from q.z only, and
 * walks along q.x with the least stretch (see `cost.stretch`). A law that
 * leaves q.z alone is `coherent`: a stratified (q.x, q.y) walk with random
 * q.z still lands in one compact patch.
 *
 * The WGSL needs `STATELESS_RNG_WGSL` (src/stateless/rng.ts) in front of it,
 * and nothing else. Helper names are prefixed so any set of laws can share
 * one module.
 */

export type Q = readonly [number, number, number];

export interface LawParam {
  name: string;
  default: number;
  min: number;
  max: number;
  /** Whole numbers only (rounded inside the law). */
  integer?: boolean;
  /** One line: what it does to the picture. */
  note: string;
}

/**
 * Per-particle cost, counted by hand from the WGSL. Uniform work (only params)
 * is not counted. `transcendental` counts sin, cos, log, sqrt, division and
 * float rounding (floor, fract, round), which run at a quarter of the FMA rate
 * on NVIDIA. `stretch` bounds |d position / d q.x| in sheet units, which sets
 * how far 256 consecutive q.x steps of 1/65536 spread on screen.
 */
export interface LawCost {
  transcendental: number;
  fma: number;
  stretch: number;
  note: string;
}

export interface StatelessLaw {
  id: string;
  title: string;
  /** Two or three sentences: what it looks like and what drives it. */
  summary: string;
  /** Name of the key-form WGSL function (the one renderers call). */
  fn: string;
  /** Name of the q-form WGSL function. */
  qFn: string;
  /** WGSL defining `fn` and `qFn`. */
  wgsl: string;
  /** Exactly 8 params, in order. */
  params: readonly LawParam[];
  defaults: number[];
  ranges: [number, number][];
  cost: LawCost;
  /**
   * True when the law ignores q.z (or nearly), so particles that are
   * neighbours in (q.x, q.y) land near each other whatever their q.z. False
   * when q.z picks a population, sector or phase, which scatters them.
   */
  coherent: boolean;
  /** Double-precision mirror of the q form, line for line with the WGSL. */
  mirror(q: Q, t: number, p: readonly number[]): [number, number];
}

export interface LawSpec {
  id: string;
  title: string;
  summary: string;
  qFn: string;
  /** WGSL defining `qFn` (the key wrapper is added). */
  wgsl: string;
  params: readonly LawParam[];
  cost: LawCost;
  coherent: boolean;
  mirror(q: Q, t: number, p: readonly number[]): [number, number];
}

/** Builds a law: adds the key-form wrapper, defaults and ranges. */
export function defineLaw(spec: LawSpec): StatelessLaw {
  if (spec.params.length !== 8) throw new Error(`law ${spec.id}: needs exactly 8 params, has ${spec.params.length}`);
  const fn = spec.qFn.replace(/Q$/, '');
  if (fn === spec.qFn) throw new Error(`law ${spec.id}: qFn must end in Q`);
  const wgsl = `${spec.wgsl.trim()}

fn ${fn}(key: Key, t: f32, p: array<f32, 8>) -> vec2f {
  return ${spec.qFn}(qFromKey(key), t, p);
}
`;
  return {
    ...spec,
    fn,
    wgsl,
    defaults: spec.params.map((x) => x.default),
    ranges: spec.params.map((x) => [x.min, x.max] as [number, number]),
  };
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
/** WGSL `fract`: x - floor(x). */
export const fract = (x: number): number => x - Math.floor(x);
