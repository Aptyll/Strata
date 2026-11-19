// Light checks on the motion laws, through their double-precision mirrors.
// The WGSL is checked against the same mirrors on a GPU by the demo's
// selftest (and by the offline renderer's own checks once it uses a law).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATELESS_LAWS, particleKey, qFromKey } from '../index';

let state = 0x2545f491;
const rnd = () => {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 4294967296;
};
const sample = (law) => law.params.map((x) => (x.integer ? Math.round(x.min + rnd() * (x.max - x.min)) : x.min + rnd() * (x.max - x.min)));

for (const law of STATELESS_LAWS) {
  test(`${law.id}: shape of the definition`, () => {
    assert.equal(law.params.length, 8);
    assert.equal(law.defaults.length, 8);
    assert.equal(law.ranges.length, 8);
    assert.match(law.wgsl, new RegExp(`fn ${law.qFn}\\(q: vec3f, t: f32, p: array<f32, 8>\\) -> vec2f`));
    assert.match(law.wgsl, new RegExp(`fn ${law.fn}\\(key: Key, t: f32, p: array<f32, 8>\\) -> vec2f`));
    for (const p of law.params) assert.ok(p.min <= p.default && p.default <= p.max, `${law.id}.${p.name} default out of range`);
  });

  test(`${law.id}: stays on the sheet and finite, for defaults and random params`, () => {
    for (let s = 0; s < 40; s++) {
      const p = s === 0 ? law.defaults : sample(law);
      for (let i = 0; i < 2000; i++) {
        const t = rnd() * 600;
        const [x, y] = law.mirror([rnd(), rnd(), rnd()], t, p);
        if (!(Number.isFinite(x) && Number.isFinite(y))) assert.fail(`${law.id}: non-finite at params ${p}`);
        // A hair of slack: the GPU rounds in f32.
        if (Math.abs(x) > 1.0001 || Math.abs(y) > 1.0001) assert.fail(`${law.id}: (${x}, ${y}) off the sheet, params ${p}, t ${t}`);
      }
    }
  });

  test(`${law.id}: continuous in time (no jumps between frames)`, () => {
    const p = law.defaults;
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const q = [rnd(), rnd(), rnd()];
      const t = rnd() * 60;
      const a = law.mirror(q, t, p);
      const b = law.mirror(q, t + 1 / 240, p);
      let dx = Math.abs(a[0] - b[0]);
      let dy = Math.abs(a[1] - b[1]);
      // The web wraps at the sheet edge; a wrap is not a jump.
      if (law.id === 'web') { dx = Math.min(dx, 2 - dx); dy = Math.min(dy, 2 - dy); }
      worst = Math.max(worst, dx, dy);
    }
    // A quarter frame at 60 fps moves less than 1% of the sheet.
    assert.ok(worst < 0.01, `${law.id}: moved ${worst} in 1/240 s`);
  });

  test(`${law.id}: distinct keys give distinct positions`, () => {
    const seen = new Set();
    const n = 200_000;
    let same = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = law.mirror(qFromKey(particleKey(i, 99)), 1.5, law.defaults);
      const k = `${Math.fround(x)},${Math.fround(y)}`;
      if (seen.has(k)) same++;
      seen.add(k);
    }
    assert.equal(same, 0, `${law.id}: ${same} of ${n} particles landed on exactly the same f32 position`);
  });
}
