/**
 * The laws of motion, in WGSL and in TypeScript.
 *
 * Every law is a closed-form solution of a real equation of motion. A particle
 * stores nothing. Each frame its position is evaluated from scratch from
 * (plane seed, particle index, time):
 *
 *   kepler     two-body orbit around a central mass. Semi-major axis, phase and
 *              orientation come from the particle's hash. Orientation twists
 *              with radius, so differential rotation winds spiral density waves.
 *   vortex     passive tracer in a steady circular shear flow with angular
 *              velocity Gamma / (r^2 + rc^2). A ruled square sheet winds up
 *              into ever finer filaments.
 *   lissajous  two-dimensional harmonic oscillator. Particles share a few
 *              nested figures and flow along them. Detuned frequencies make
 *              the figures morph.
 *
 * The TypeScript versions mirror the WGSL line for line in double precision.
 * They exist so a CPU reference can cross-check the shader.
 *
 * Law params (8 floats each):
 *   kepler:    [ecc, twist, innerRadius, concentration, rate, orientScatter, eccScatter, _]
 *   vortex:    [bands, fill, circulation, coreRadius, extent, _, _, _]
 *   lissajous: [freqX, freqY, shells, thickness, rateX, rateY, shellPhase, extent]
 */
import type { LawId } from "./job";

export const LAW_INDEX: Record<LawId, number> = { kepler: 0, vortex: 1, lissajous: 2 };

/** Shared by every shader in this folder: hashing and the batch uniform. */
export const WGSL_COMMON = /* wgsl */ `
const TAU = 6.283185307179586;

// PCG output permutation used as a u32 -> u32 hash. Bijective.
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// Uniform float in [0, 1) from the top 24 bits. Exact in f32.
fn u01(h: u32) -> f32 {
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

// Triangular distribution on (-1, 1), variance 1/6, from one hash.
fn tri(h: u32) -> f32 {
  return (f32(h & 0xffffu) + f32(h >> 16u)) * (1.0 / 65536.0) - 1.0;
}

// The particle's identity: index mixed with the plane seed.
fn particleKey(i: u32, seed: u32) -> u32 {
  return pcg(pcg(i) + seed);
}

// The k-th independent random draw of a particle.
fn draw(key: u32, k: u32) -> u32 {
  return pcg(key + k * 0x9e3779b9u);
}
`;

/** Defines `fn lawPosition(law: u32, key: u32, t: f32, p: array<f32, 8>) -> vec2f`. */
export const WGSL_LAWS = /* wgsl */ `
fn lawKepler(key: u32, t: f32, p: array<f32, 8>) -> vec2f {
  let ecc = clamp(p[0] + p[6] * tri(draw(key, 3u)), 0.0, 0.6);
  let u = u01(draw(key, 0u));
  // Apocenter a * (1 + ecc) stays inside the sheet.
  let a = mix(p[2], 1.0, pow(u, p[3])) / 1.6;
  let omega = p[1] * log(a) + p[5] * tri(draw(key, 2u));
  // Mean anomaly: mean motion follows Kepler's third law, n = rate / a^1.5.
  var m = TAU * u01(draw(key, 1u)) + p[4] * t / (a * sqrt(a));
  m = m - TAU * round(m / TAU);
  // Kepler's equation E - ecc sin E = M: third-order starter, one Newton step.
  let sm = sin(m);
  let cm = cos(m);
  let e0 = m + ecc * sm * (1.0 + ecc * cm);
  let s0 = sin(e0);
  let c0 = cos(e0);
  let d = -(e0 - ecc * s0 - m) / (1.0 - ecc * c0);
  // sin and cos of E = e0 + d, to second order in the small step d.
  let s1 = s0 + d * c0 - 0.5 * d * d * s0;
  let c1 = c0 - d * s0 - 0.5 * d * d * c0;
  let x = a * (c1 - ecc);
  let y = a * sqrt(1.0 - ecc * ecc) * s1;
  let so = sin(omega);
  let co = cos(omega);
  return vec2f(x * co - y * so, x * so + y * co);
}

fn lawVortex(key: u32, t: f32, p: array<f32, 8>) -> vec2f {
  let bands = max(1.0, floor(p[0]));
  let j = floor(u01(draw(key, 0u)) * bands);
  // A ruled sheet: soft-edged stripes along y.
  let x0 = (j + 0.5 + 0.5 * p[1] * tri(draw(key, 1u))) / bands * 2.0 - 1.0;
  let y0 = u01(draw(key, 2u)) * 2.0 - 1.0;
  let r2 = x0 * x0 + y0 * y0;
  var phi = p[2] * t / (r2 + p[3] * p[3]);
  phi = phi - TAU * round(phi / TAU);
  let s = sin(phi);
  let c = cos(phi);
  // extent <= 1/sqrt(2) keeps the rotating corners on the sheet.
  return vec2f(x0 * c - y0 * s, x0 * s + y0 * c) * p[4];
}

fn lawLissajous(key: u32, t: f32, p: array<f32, 8>) -> vec2f {
  let tau = TAU * u01(draw(key, 0u));
  let shells = max(1.0, floor(p[2]));
  let j = floor(u01(draw(key, 1u)) * shells);
  let amp = (j + 1.0) / shells * (1.0 + p[3] * tri(draw(key, 2u))) * p[7];
  var ax = p[0] * tau + p[4] * t + p[6] * j;
  var ay = p[1] * tau + p[5] * t;
  ax = ax - TAU * round(ax / TAU);
  ay = ay - TAU * round(ay / TAU);
  return vec2f(amp * sin(ax), amp * sin(ay));
}

fn lawPosition(law: u32, key: u32, t: f32, p: array<f32, 8>) -> vec2f {
  switch law {
    case 0u: { return lawKepler(key, t, p); }
    case 1u: { return lawVortex(key, t, p); }
    default: { return lawLissajous(key, t, p); }
  }
}
`;

// ------------------------------------------------------- CPU reference ----

const TAU = 6.283185307179586;

export function pcg(v: number): number {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
export const u01 = (h: number): number => (h >>> 8) / 16777216;
export const tri = (h: number): number => ((h & 0xffff) + (h >>> 16)) / 65536 - 1;
export const particleKey = (i: number, seed: number): number => pcg((pcg(i) + seed) >>> 0);
export const draw = (key: number, k: number): number => pcg((key + Math.imul(k, 0x9e3779b9)) >>> 0);

const wrapAngle = (a: number): number => a - TAU * Math.round(a / TAU);
const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

export function lawPosition(law: LawId, key: number, t: number, p: number[]): [number, number] {
  switch (law) {
    case "kepler": {
      const ecc = clamp(p[0] + p[6] * tri(draw(key, 3)), 0, 0.6);
      const u = u01(draw(key, 0));
      const a = (p[2] + (1 - p[2]) * Math.pow(u, p[3])) / 1.6;
      const omega = p[1] * Math.log(a) + p[5] * tri(draw(key, 2));
      const m = wrapAngle(TAU * u01(draw(key, 1)) + (p[4] * t) / (a * Math.sqrt(a)));
      const sm = Math.sin(m);
      const cm = Math.cos(m);
      const e0 = m + ecc * sm * (1 + ecc * cm);
      const s0 = Math.sin(e0);
      const c0 = Math.cos(e0);
      const d = -(e0 - ecc * s0 - m) / (1 - ecc * c0);
      const s1 = s0 + d * c0 - 0.5 * d * d * s0;
      const c1 = c0 - d * s0 - 0.5 * d * d * c0;
      const x = a * (c1 - ecc);
      const y = a * Math.sqrt(1 - ecc * ecc) * s1;
      const so = Math.sin(omega);
      const co = Math.cos(omega);
      return [x * co - y * so, x * so + y * co];
    }
    case "vortex": {
      const bands = Math.max(1, Math.floor(p[0]));
      const j = Math.floor(u01(draw(key, 0)) * bands);
      const x0 = ((j + 0.5 + 0.5 * p[1] * tri(draw(key, 1))) / bands) * 2 - 1;
      const y0 = u01(draw(key, 2)) * 2 - 1;
      const r2 = x0 * x0 + y0 * y0;
      const phi = wrapAngle((p[2] * t) / (r2 + p[3] * p[3]));
      const s = Math.sin(phi);
      const c = Math.cos(phi);
      return [(x0 * c - y0 * s) * p[4], (x0 * s + y0 * c) * p[4]];
    }
    case "lissajous": {
      const tau = TAU * u01(draw(key, 0));
      const shells = Math.max(1, Math.floor(p[2]));
      const j = Math.floor(u01(draw(key, 1)) * shells);
      const amp = ((j + 1) / shells) * (1 + p[3] * tri(draw(key, 2))) * p[7];
      const ax = wrapAngle(p[0] * tau + p[4] * t + p[6] * j);
      const ay = wrapAngle(p[1] * tau + p[5] * t);
      return [amp * Math.sin(ax), amp * Math.sin(ay)];
    }
  }
}
