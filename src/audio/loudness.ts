/**
 * Integrated loudness after ITU-R BS.1770-4 (the LUFS that YouTube and
 * streaming services normalize to): K-weighting, 400 ms blocks with 75%
 * overlap, an absolute gate at -70 LUFS and a relative gate 10 LU down.
 */

export interface Loudness {
  /** Integrated loudness in LUFS. -Infinity for silence. */
  integrated: number;
  /** Highest sample, in dBFS. */
  peak: number;
}

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number];

/**
 * The two K-weighting stages for any sample rate: the high shelf, then the
 * RLB high-pass. This is libebur128's construction, which reproduces the
 * coefficients BS.1770 lists for 48 kHz.
 */
function kWeighting(sampleRate: number): Biquad[] {
  let f0 = 1681.974450955533;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, 3.999843853973347 / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = [
    (vh + (vb * k) / q + k * k) / a0,
    (2 * (k * k - vh)) / a0,
    (vh - (vb * k) / q + k * k) / a0,
    (2 * (k * k - 1)) / a0,
    (1 - k / q + k * k) / a0,
  ];
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
  return [shelf, highpass];
}

function filter(input: Float32Array, stages: Biquad[]): Float64Array {
  const out = Float64Array.from(input);
  for (const [b0, b1, b2, a1, a2] of stages) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  return out;
}

export function measureLoudness(channels: readonly Float32Array[], sampleRate: number): Loudness {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const stages = kWeighting(sampleRate);
  const weighted = channels.map((ch) => filter(ch, stages));
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const length = channels[0]?.length ?? 0;
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += hop) {
    let sum = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += ch[i] * ch[i];
      sum += s / block;
    }
    powers.push(sum);
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
  const absolute = powers.filter((p) => lufs(p) > -70);
  let integrated = -Infinity;
  if (absolute.length) {
    const gate = lufs(mean(absolute)) - 10;
    const relative = absolute.filter((p) => lufs(p) > gate);
    if (relative.length) integrated = lufs(mean(relative));
  }
  return { integrated, peak: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

/**
 * Scales audio in place toward `target` LUFS, but never so far that the
 * highest sample goes above `ceiling` dBFS. Returns the gain applied, in dB.
 */
export function normalizeLoudness(channels: readonly Float32Array[], sampleRate: number, target = -16, ceiling = -1): number {
  const { integrated, peak } = measureLoudness(channels, sampleRate);
  if (!Number.isFinite(integrated)) return 0;
  const gainDb = Math.min(target - integrated, ceiling - peak);
  const g = Math.pow(10, gainDb / 20);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return gainDb;
}
