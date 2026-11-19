/**
 * Parameter tools for behaviors.
 *
 * Everything here runs on the CPU when a preset or slider changes. Nothing here touches
 * the per-particle shader path: a behavior's params stay the engine's fixed block of
 * MAX_BEHAVIOR_PARAMS floats in the plane uniform.
 */
import { MAX_BEHAVIOR_PARAMS, type Behavior, type ParamSpec } from "../../core/contracts";
import { seededRandom } from "../../math";

/**
 * ParamSpec with optional extras for UI and preset tools. It is structurally a
 * ParamSpec, so the shared contract does not change. Use `defineBehavior` to write
 * these in a behavior file without excess-property errors.
 */
export interface RichParamSpec extends ParamSpec {
  /** Slider mapping. `log` needs min > 0 and suits scales and frequencies. Default linear. */
  scale?: "linear" | "log";
  /** One sentence on what the param does, for tooltips. */
  description?: string;
  /** Set false to keep the param fixed when randomizing. Default true. */
  randomize?: boolean;
  /** Narrower range used by randomize when the extremes are rarely pleasant. */
  randomRange?: [number, number];
}

export type ParamValues = Record<string, number>;

/** Param names in declaration order. This is the order of the uniform block. */
export function paramNames(behavior: Behavior): string[] {
  return Object.keys(behavior.params);
}

export function clampParam(spec: ParamSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** Every param of the behavior: defaults, then overrides, clamped. Unknown names are dropped. */
export function resolveParams(behavior: Behavior, overrides?: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const name of paramNames(behavior)) {
    const spec = behavior.params[name];
    const v = overrides?.[name];
    out[name] = v === undefined ? spec.default : clampParam(spec, v);
  }
  return out;
}

/** Only the values that differ from the defaults. This is what PlaneDesc.params stores. */
export function diffParams(behavior: Behavior, values: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const name of paramNames(behavior)) {
    const v = values[name];
    if (v !== undefined && v !== behavior.params[name].default) out[name] = v;
  }
  return out;
}

/**
 * The 8-float param block in declaration order, unused slots 0, values clamped
 * to min..max. A preset tool: the engine uploads planeParamValues
 * (src/gpu/shaderLib.ts), which does not clamp.
 */
export function packParams(
  behavior: Behavior,
  overrides?: ParamValues,
  out: Float32Array = new Float32Array(MAX_BEHAVIOR_PARAMS),
): Float32Array {
  const values = resolveParams(behavior, overrides);
  out.fill(0, 0, MAX_BEHAVIOR_PARAMS);
  paramNames(behavior).forEach((name, k) => {
    if (k < MAX_BEHAVIOR_PARAMS) out[k] = values[name];
  });
  return out;
}

function isLog(spec: RichParamSpec): boolean {
  return spec.scale === "log" && spec.min > 0 && spec.max > spec.min;
}

/** Value to slider position in 0..1, honoring a log scale. */
export function toUnit(spec: RichParamSpec, value: number): number {
  const v = clampParam(spec, value);
  if (spec.max <= spec.min) return 0;
  if (isLog(spec)) return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min);
}

/** Slider position in 0..1 to value, honoring log scale and step. */
export function fromUnit(spec: RichParamSpec, t: number): number {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let v = isLog(spec) ? spec.min * Math.pow(spec.max / spec.min, u) : spec.min + (spec.max - spec.min) * u;
  if (spec.step && spec.step > 0) v = spec.min + Math.round((v - spec.min) / spec.step) * spec.step;
  return clampParam(spec, v);
}

// The seeded generator behind randomizeParams (mulberry32, from src/math.ts), re-exported for preset tools.
export { seededRandom };

export interface RandomizeOptions {
  /** Same seed, same result. Default 1. */
  seed?: number;
  /** 1 gives a fresh random preset. Less than 1 nudges `base` toward one (a mutation). Default 1. */
  amount?: number;
  /** Starting values for a mutation. Default: the behavior's defaults. */
  base?: ParamValues;
}

/** Random or mutated values, uniform in slider space so log params spread evenly. */
export function randomizeParams(behavior: Behavior, options: RandomizeOptions = {}): ParamValues {
  const random = seededRandom(options.seed ?? 1);
  const amount = Math.min(1, Math.max(0, options.amount ?? 1));
  const base = resolveParams(behavior, options.base);
  const out: ParamValues = {};
  for (const name of paramNames(behavior)) {
    const spec: RichParamSpec = behavior.params[name];
    const draw = random(); // always drawn, so one param's flags never shift another's value
    if (spec.randomize === false || amount === 0) {
      out[name] = base[name];
      continue;
    }
    const [lo, hi] = spec.randomRange ?? [spec.min, spec.max];
    const target = toUnit(spec, lo) + (toUnit(spec, hi) - toUnit(spec, lo)) * draw;
    const current = toUnit(spec, base[name]);
    out[name] = fromUnit(spec, current + (target - current) * amount);
  }
  return out;
}

/** Blend two value sets of the same behavior, in slider space. t = 0 gives a, t = 1 gives b. */
export function lerpParams(behavior: Behavior, a: ParamValues, b: ParamValues, t: number): ParamValues {
  const va = resolveParams(behavior, a);
  const vb = resolveParams(behavior, b);
  const k = Math.min(1, Math.max(0, t));
  const out: ParamValues = {};
  for (const name of paramNames(behavior)) {
    const spec: RichParamSpec = behavior.params[name];
    const ua = toUnit(spec, va[name]);
    const ub = toUnit(spec, vb[name]);
    // Exact at the ends (no round-trip noise). Skip step snapping so the motion stays smooth.
    out[name] = k === 0 ? va[name] : k === 1 ? vb[name] : fromUnit({ ...spec, step: undefined }, ua + (ub - ua) * k);
  }
  return out;
}
