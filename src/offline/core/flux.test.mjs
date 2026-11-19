// Flux weighting keeps the light of far particles.
//
// A flux particle adds min(1, (fluxRef / depth)^2) of a particle's light, as a
// whole number of grid units. With the first renders' 16 bits, a particle
// dimmer than 1/65536 was rounded at random to one unit or to nothing, so a
// wide shot was drawn by a random share of its particles. These tests pin
// down the finer units: how many bits a job gets, that count-mode jobs are
// untouched, that develop() brings every grid to the same ONE units, and that
// the label only claims what the GPU's drawn tally shows. The GPU side is in
// ../node/test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { COMPOSITIONS } from "./compositions";
import { develop, encodeLog } from "./develop";
import { MAX_FLUX_BITS, ONE, fluxBitsUsed, unitsPerParticle, validateJob } from "./job";
import { scaleParticles } from "./ladder";
import { defaultLabel } from "./session";
import { PRESETS, clusterJob } from "./world";

const small = (o = {}) => clusterJob({ ...PRESETS.smoke, ...o });

test("a job gets as many flux bits as its particle count leaves room for", () => {
  // particles * 2^bits must stay within 2^63: the whole world at full weight in one pixel.
  assert.equal(fluxBitsUsed(clusterJob(PRESETS.trillion)), 23);
  assert.equal(fluxBitsUsed(clusterJob(PRESETS.billion)), 31);
  assert.equal(fluxBitsUsed(small()), 31);
  for (const name of Object.keys(PRESETS)) {
    const job = clusterJob(PRESETS[name]);
    const total = job.planes.reduce((s, p) => s + p.particleCount, 0);
    assert.ok(BigInt(total) * (1n << BigInt(fluxBitsUsed(job))) <= 1n << 63n, name);
  }
});

test("a job without fluxBits keeps the first renders' 16 bits", () => {
  const job = small();
  delete job.fluxBits;
  assert.equal(fluxBitsUsed(job), 16);
  assert.equal(unitsPerParticle(job), ONE);
  // Asking for less than the maximum is honoured.
  assert.equal(fluxBitsUsed({ ...job, fluxBits: 20 }), 20);
  assert.equal(unitsPerParticle({ ...job, fluxBits: 20 }), 2 ** 20);
});

test("count jobs are untouched: no fluxBits field, ONE units", () => {
  const job = small({ weighting: "count" });
  assert.equal("fluxBits" in job, false);
  assert.equal(unitsPerParticle(job), ONE);
  // Even a count job that carries the field adds exactly ONE per particle.
  assert.equal(unitsPerParticle({ ...job, fluxBits: MAX_FLUX_BITS }), ONE);
});

test("the builders ask for the finest weights, and the quick option is 16", () => {
  assert.equal(small().fluxBits, MAX_FLUX_BITS);
  assert.equal(small({ fluxBits: 16 }).fluxBits, 16);
  const hero = COMPOSITIONS.heroA;
  assert.equal(hero.build({ ...hero.defaults, particles: 1_000_000 }).fluxBits, MAX_FLUX_BITS);
  assert.equal("fluxBits" in hero.build({ ...hero.defaults, particles: 1_000_000, weighting: "count" }), false);
});

test("validateJob accepts 16 to 31 whole bits only", () => {
  const job = small();
  for (const bits of [16, 23, 31]) validateJob({ ...job, fluxBits: bits });
  for (const bits of [15, 32, 16.5, -1, Number.NaN]) assert.throws(() => validateJob({ ...job, fluxBits: bits }), /fluxBits/, String(bits));
});

test("a ladder rung larger than its base job still fits the accumulator", () => {
  // The base asks for 31 bits. A trillion-particle rung of it must drop to 23 on its own.
  const base = small({ planes: 1024, particles: 4_096_000 });
  const rung = scaleParticles(base, 1e12);
  validateJob(rung);
  assert.equal(fluxBitsUsed(base), 31);
  assert.equal(fluxBitsUsed(rung), 23);
});

test("develop brings fine grids to the same ONE units", () => {
  const width = 4;
  const height = 2;
  // Light per pixel in ONE units: nothing, a faint fraction, one particle, a lot.
  const light = [0, 0.25, 0.5, 3, ONE, 12345.5, 7 * ONE, 2 ** 40];
  for (const bits of [16, 23, 31]) {
    const unit = 2 ** bits;
    const lo = new Uint32Array(width * height);
    const hi = new Uint32Array(width * height);
    light.forEach((v, i) => {
      const raw = BigInt(Math.round(v * (unit / ONE)));
      lo[i] = Number(raw & 0xffffffffn);
      hi[i] = Number(raw >> 32n);
    });
    const d = develop(lo, hi, width, height, 1, unit);
    light.forEach((v, i) => {
      // What survives in a grid of this fineness, in ONE units.
      const stored = Math.round(v * (unit / ONE)) / (unit / ONE);
      assert.equal(d.codes[i], stored > 0 ? Math.max(1, encodeLog(stored)) : 0, `${bits} bits, pixel ${i}`);
    });
    assert.equal(d.litPixels, light.filter((v) => Math.round(v * (unit / ONE)) > 0).length);
  }
});

test("a pixel holding less than one ONE unit still develops in proportion", () => {
  // 2^23 units per particle: 32 units is a quarter of a ONE unit.
  const lo = new Uint32Array([32, 64, 128, 0]);
  const hi = new Uint32Array(4);
  const d = develop(lo, hi, 4, 1, 1, 2 ** 23);
  assert.deepEqual([...d.codes], [encodeLog(0.25), encodeLog(0.5), encodeLog(1), 0]);
  assert.ok(d.codes[0] > 0 && d.codes[0] < d.codes[1] && d.codes[1] < d.codes[2]);
  assert.equal(d.litPixels, 3);
  // Light too faint for any code is still a lit pixel, never "no light".
  assert.equal(develop(new Uint32Array([1]), new Uint32Array(1), 1, 1, 1, 2 ** 31).codes[0], 1);
});

test("the label claims every particle added light only when the GPU counted it", () => {
  const stats = (o) => ({
    frame: 0, evaluated: "4000000", unitSum: "1", landed: "3000000", litPixels: 1, maxCode: 1, hist: [], seconds: 1, batches: 1, ...o,
  });
  const flux = small();
  const count = small({ weighting: "count" });
  const line = (job, s) => defaultLabel(s, job).join("\n");
  assert.match(line(flux, stats({ drawn: "3000000" })), /Every particle in frame added light/);
  assert.match(line(flux, stats({ drawn: "2999999" })), /drawn on average[^\n]*\nIn frame: 3,000,000\. Added light: 2,999,999/);
  assert.doesNotMatch(line(flux, stats({ drawn: "2999999" })), /Every particle/);
  // Frames from before the tally existed make no claim about each particle.
  assert.match(line(flux, stats({})), /drawn on average, not each/);
  assert.doesNotMatch(line(flux, stats({})), /Every particle|Added light/);
  assert.match(line(count, stats({ drawn: "3000000" })), /adds exactly one unit of light/);
});
