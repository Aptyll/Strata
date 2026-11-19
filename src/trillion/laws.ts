// Stand-in laws for testing the kernel. The real motion set lives in
// src/stateless (and the offline runner's laws); any law with the same
// signature plugs in: fn NAME(key: u32, t: f32, p: array<f32, 8>) -> vec2f.

import type { TrillionLaw } from './kernel';

/** Kepler-like rings: p[0] angular speed, p[1] inner radius. Cheap: 1 sqrt, 1 sin/cos pair. */
export const ORBIT_LAW: TrillionLaw = {
  id: 'orbit',
  fn: 'lawOrbit',
  wgsl: /* wgsl */ `
fn lawOrbit(key: u32, t: f32, p: array<f32, 8>) -> vec2f {
  let r = mix(p[1], 1.0, sqrt(u01(draw(key, 0u))));
  let w = p[0] / (r * sqrt(r));
  var a = u01(draw(key, 1u)) * TAU + w * t;
  a = a - TAU * round(a / TAU);
  return r * vec2f(cos(a), sin(a));
}`,
};

/** Lissajous bundle: p[0] speed, p[1] spread. */
export const LISSAJOUS_LAW: TrillionLaw = {
  id: 'lissajous',
  fn: 'lawLissajous',
  wgsl: /* wgsl */ `
fn lawLissajous(key: u32, t: f32, p: array<f32, 8>) -> vec2f {
  let h = draw(key, 0u);
  var a = u01(h) * TAU + p[0] * t;
  a = a - TAU * round(a / TAU);
  let j = vec2f(tri(draw(key, 1u)), tri(draw(key, 2u))) * p[1];
  return 0.9 * vec2f(sin(3.0 * a), sin(2.0 * a + 0.5)) + j;
}`,
};

export const STANDIN_LAWS: readonly TrillionLaw[] = [ORBIT_LAW, LISSAJOUS_LAW];
