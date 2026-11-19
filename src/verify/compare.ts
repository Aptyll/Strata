/**
 * Comparison helpers for CPU reference vs GPU output. Pure functions.
 *
 * Writing a CPU reference: GPU floats are f32. Do the reference math through
 * Math.fround (or in a Float32Array) so both sides round alike, and still
 * leave a tolerance: GPUs may fuse a*b+c into one fma and their sin, cos, exp
 * and pow are only accurate to a few ulp.
 */

import { VerifyError } from "./types";

export interface CloseOptions {
  /** Absolute tolerance. Default 1e-5. */
  abs?: number;
  /** Relative tolerance, scaled by max(|actual|, |expected|). Default 1e-5. */
  rel?: number;
  /** Elements per record, for readable messages (a Particle is 4). Default 1. */
  stride?: number;
  /** Names of the elements of one record, e.g. ["pos.x", "pos.y", "vel.x", "vel.y"]. */
  fields?: readonly string[];
  /** Label used in the error message. */
  what?: string;
}

export interface CloseStats {
  count: number;
  mismatches: number;
  maxAbsError: number;
  /** Index of the element with the largest error, -1 when count is 0. */
  worstIndex: number;
}

type NumericArray = ArrayLike<number>;

function describe(index: number, opts: CloseOptions): string {
  const stride = opts.stride ?? 1;
  if (stride === 1) return `[${index}]`;
  const record = Math.floor(index / stride);
  const field = index % stride;
  return `[${record}].${opts.fields?.[field] ?? field}`;
}

/** Compares element-wise and returns statistics without throwing. */
export function closeStats(actual: NumericArray, expected: NumericArray, opts: CloseOptions = {}): CloseStats {
  const abs = opts.abs ?? 1e-5;
  const rel = opts.rel ?? 1e-5;
  const count = Math.min(actual.length, expected.length);
  let mismatches = 0;
  let maxAbsError = 0;
  let worstIndex = -1;
  for (let i = 0; i < count; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a === e) continue;
    const err = Math.abs(a - e);
    // NaN on either side makes err NaN, which must count as a mismatch.
    const ok = err <= abs + rel * Math.max(Math.abs(a), Math.abs(e));
    if (!ok) mismatches++;
    if (!(err <= maxAbsError)) {
      maxAbsError = Number.isNaN(err) ? Infinity : err;
      worstIndex = i;
    }
  }
  return { count, mismatches, maxAbsError, worstIndex };
}

/** Throws when any element differs by more than the tolerance. Returns the statistics otherwise. */
export function expectClose(actual: NumericArray, expected: NumericArray, opts: CloseOptions = {}): CloseStats {
  const what = opts.what ?? "values";
  if (actual.length !== expected.length) {
    throw new VerifyError(`${what}: length ${actual.length}, expected ${expected.length}`);
  }
  const stats = closeStats(actual, expected, opts);
  if (stats.mismatches > 0) {
    const abs = opts.abs ?? 1e-5;
    const rel = opts.rel ?? 1e-5;
    const lines: string[] = [];
    for (let i = 0; i < stats.count && lines.length < 6; i++) {
      const a = actual[i];
      const e = expected[i];
      if (a === e) continue;
      const err = Math.abs(a - e);
      if (!(err <= abs + rel * Math.max(Math.abs(a), Math.abs(e)))) {
        lines.push(`  ${describe(i, opts)}: got ${a}, expected ${e}`);
      }
    }
    throw new VerifyError(
      `${what}: ${stats.mismatches} of ${stats.count} differ (max error ${stats.maxAbsError} at ${describe(stats.worstIndex, opts)})\n` +
        lines.join("\n"),
    );
  }
  return stats;
}

/** Throws unless both arrays hold exactly the same numbers (use for integer data). */
export function expectEqual(actual: NumericArray, expected: NumericArray, what = "values"): void {
  if (actual.length !== expected.length) {
    throw new VerifyError(`${what}: length ${actual.length}, expected ${expected.length}`);
  }
  let mismatches = 0;
  const lines: string[] = [];
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      mismatches++;
      if (lines.length < 6) lines.push(`  [${i}]: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
  if (mismatches > 0) {
    throw new VerifyError(`${what}: ${mismatches} of ${actual.length} differ\n${lines.join("\n")}`);
  }
}

/** Throws when any element is NaN or infinite. */
export function expectFinite(values: NumericArray, what = "values"): void {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new VerifyError(`${what}: [${i}] is ${values[i]}`);
  }
}

/** Throws unless lo <= v <= hi for every element (v < hi when `exclusiveHi`). */
export function expectInRange(
  values: NumericArray,
  lo: number,
  hi: number,
  opts: { exclusiveHi?: boolean; what?: string } = {},
): void {
  const what = opts.what ?? "values";
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const ok = v >= lo && (opts.exclusiveHi ? v < hi : v <= hi);
    if (!ok) {
      throw new VerifyError(`${what}: [${i}] = ${v} is outside [${lo}, ${hi}${opts.exclusiveHi ? ")" : "]"}`);
    }
  }
}

export interface UniformStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Chi-square over `bins` equal bins, divided by (bins - 1). About 1 for a good generator. */
  chi2PerDof: number;
  /** Correlation between consecutive samples. About 0 for a good generator. */
  serialCorrelation: number;
}

/** Statistics for samples that should be uniform in [0, 1). */
export function uniformStats(samples: NumericArray, bins = 64): UniformStats {
  const n = samples.length;
  const hist = new Float64Array(bins);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    hist[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  }
  const mean = sum / n;
  const expected = n / bins;
  let chi2 = 0;
  for (let b = 0; b < bins; b++) chi2 += ((hist[b] - expected) * (hist[b] - expected)) / expected;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = samples[i] - mean;
    den += d * d;
    if (i + 1 < n) num += d * (samples[i + 1] - mean);
  }
  return { count: n, min, max, mean, chi2PerDof: chi2 / (bins - 1), serialCorrelation: den > 0 ? num / den : 0 };
}

/**
 * Throws unless the samples look uniform in [0, 1): all inside the half-open
 * range (a hash that can return exactly 1.0 fails here), mean near 0.5, flat
 * histogram, no correlation between neighbours. Needs a few thousand samples.
 */
export function expectUniform01(samples: NumericArray, what = "rand"): UniformStats {
  const s = uniformStats(samples);
  const n = s.count;
  if (n < 1000) throw new VerifyError(`${what}: need at least 1000 samples, got ${n}`);
  if (!(s.min >= 0) || !(s.max < 1)) throw new VerifyError(`${what}: range [${s.min}, ${s.max}] is not inside [0, 1)`);
  // Standard error of the mean of U(0,1) is 1/sqrt(12 n); allow 6 sigma.
  const meanTol = 6 / Math.sqrt(12 * n);
  if (Math.abs(s.mean - 0.5) > meanTol) throw new VerifyError(`${what}: mean ${s.mean}, expected 0.5 +- ${meanTol}`);
  // chi2/dof has standard deviation sqrt(2/dof) = 0.178 for 63 dof; allow 6 sigma.
  if (s.chi2PerDof > 1 + 6 * Math.sqrt(2 / 63)) {
    throw new VerifyError(`${what}: histogram is not flat (chi2/dof ${s.chi2PerDof.toFixed(2)})`);
  }
  const corrTol = 6 / Math.sqrt(n);
  if (Math.abs(s.serialCorrelation) > corrTol) {
    throw new VerifyError(`${what}: neighbours are correlated (${s.serialCorrelation.toFixed(4)}, limit ${corrTol.toFixed(4)})`);
  }
  return s;
}
