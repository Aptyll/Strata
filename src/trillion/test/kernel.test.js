// CPU-side checks of the trillion kernel's arithmetic (no GPU): the fixed
// point rounding in project(), the strata row limit, and the tri rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATELESS_RNG_WGSL, pcg } from '../../stateless/rng';
import { LAW_PRELUDE, MAX_ROW, WORKGROUP } from '../wgsl';
import { TrillionKernel, fixBitsFor } from '../kernel';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const fr = Math.fround;

/** project()'s rounding, step by step in f32: returns n (biased fixed point). */
function fixed(q, width, stochastic) {
  const F = fixBitsFor(width, width);
  const S = 2 ** F;
  const hi = fr((width + 3) * S);
  const v = fr(Math.min(Math.max(fr(fr(q * S) + fr((stochastic ? 0.5 : 1) * S)), 0), hi));
  f32[0] = fr(v + 8388608);
  return u32[0] & 0x7fffff;
}

test('fixed point keeps 8 fraction bits up to 32764 pixels and stays exact to 65535', () => {
  assert.equal(fixBitsFor(3840, 2160), 8);
  assert.equal(fixBitsFor(32764, 100), 8);
  assert.equal(fixBitsFor(65535, 65535), 6);
  for (const w of [1, 640, 3840, 7680, 16384, 32764, 32765, 65535]) {
    assert.ok((w + 3) * 2 ** fixBitsFor(w, w) < 2 ** 23, `size ${w}`);
  }
});

test('the stochastic splat block and fraction match floor(q - 0.5) to about 1/400 px', () => {
  const W = 3840;
  for (let i = 0; i < 20000; i++) {
    const q = -0.5 + Math.random() * (W + 2);
    const n = fixed(q, W, true);
    const block = (n >> 8) - 1;          // floor(q - 0.5)
    const frac = (n & 255) / 256;
    const exact = q - 0.5;
    // Half a step of final rounding plus the f32 rounding of q * 2^F (and an FMA may skip that one).
    assert.ok(Math.abs(block + frac - Math.min(Math.max(exact, -1), W + 2)) <= 1 / 512 + 1 / 2048, `q ${q}`);
  }
});

test('anything off the frame is rejected, whichever corner the splat may pick', () => {
  const W = 1000;
  for (const q of [-1e30, -5, -1.01, W + 0.51, W + 9, 1e30, Infinity, -Infinity]) {
    const n = fixed(q, W, true);
    // corner() picks 1 only when the fraction beats an 8 bit threshold.
    for (const d of (n & 255) > 0 ? [0, 1] : [0]) {
      const px = ((n >> 8) + d - 1) >>> 0;
      if (q < -1 || q >= W + 0.5) assert.ok(px >= W, `q ${q} d ${d} -> ${px}`);
    }
  }
  // In-frame pixels give block + 1 in [0, W]: fits the 16 bit run key.
  for (let i = 0; i < 5000; i++) {
    const n = fixed(-1 + Math.random() * (W + 2), W, true);
    for (const d of [0, 1]) {
      const px = ((n >> 8) + d - 1) >>> 0;
      if (px < W) assert.ok(n >> 8 <= W);
    }
  }
});

test('strata rows never exceed MAX_ROW, so 16 bit run counts cannot overflow', () => {
  const layout = TrillionKernel.prototype.strataLayout;
  for (const strata of [undefined, [1, 1], [3, 2], [256, 1]]) {
    const plane = { law: 'x', count: 2 ** 32, seed: 1, homography: [], strata };
    const L = layout.call(null, plane);
    assert.ok(Math.ceil((L.base + 1) / WORKGROUP) <= MAX_ROW, `strata ${strata}`);
    assert.equal(L.base * L.patches + L.rem, 2 ** 32);
  }
});

test('tri is rewritten with one conversion, and the two forms agree exactly', () => {
  assert.ok(STATELESS_RNG_WGSL.includes('f32(h >> 8u) - f32(pcg(h) >> 8u)'), 'rng.ts tri changed: update TRI_TWO_CONVERTS in wgsl.ts');
  assert.ok(LAW_PRELUDE.includes('f32(i32(h >> 8u) - i32(pcg(h) >> 8u))'));
  for (let i = 0; i < 100000; i++) {
    const h = (Math.random() * 2 ** 32) >>> 0;
    const a = h >>> 8, b = pcg(h) >>> 8;
    assert.equal(fr(fr(fr(a) - fr(b)) * fr(1 / 16777216)), fr(fr(a - b) * fr(1 / 16777216)));
  }
});
