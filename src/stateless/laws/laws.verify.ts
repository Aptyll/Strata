/**
 * Checks for the stateless motion laws (`npm run verify -- stateless`):
 * - every law's WGSL compiles and passes the WGSL lint;
 * - on the GPU, each law's key form matches its double-precision mirror
 *   (through `qFromKey`) for the defaults and for random params and times;
 * - the strata variant, given `strat(key) = (u01(key.x), u01(key.y))` as on
 *   the trillion kernel's plain entry points, matches the same mirror;
 * - every law, plain and strata variant, compiles inside the trillion
 *   kernel's splat shader (src/trillion), so the hookup stays real.
 *
 * Tolerances are absolute, in sheet units (the sheet is [-1, 1]^2), and come
 * from f32 rounding: the GPU evaluates in f32, the mirror in f64. Ribbons
 * folds a square two to four times, and every fold stretches rounding error,
 * so it gets a wider bound. The web wraps at the sheet edge, so it is
 * compared on the torus.
 */

import { output, runCompute } from '../../verify/gpu';
import { splatWgsl } from '../../trillion/wgsl';
import { shaderCase } from '../../verify/shader-case';
import { VerifyError, type VerifyCase } from '../../verify/types';
import { STATELESS_RNG_WGSL, particleKey, qFromKey } from '../rng';
import { STATELESS_LAWS, strataVariant } from './index';
import type { StatelessLaw } from './types';

const N = 16384;
const SEED = 0x5eed1234;
// SwiftShader measures about 1e-4 (3e-3 for ribbons). Hardware sin and cos
// are allowed to be less accurate, so the bounds leave room: 1e-3 is a pixel
// at 1000 pixels per sheet unit, far below any real formula mismatch.
const TOLERANCE: Record<string, number> = { veil: 1e-3, galaxy: 1e-3, web: 1e-3, ribbons: 1e-2 };

// Deterministic param sets: the defaults, then random ones inside the ranges.
function paramSets(law: StatelessLaw, count: number): { p: number[]; t: number }[] {
  let s = 0x9e3779b9 ^ law.id.length;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const sets = [{ p: law.defaults.slice(), t: 3.7 }];
  while (sets.length < count) {
    const p = law.params.map((x) => {
      const v = x.min + rnd() * (x.max - x.min);
      return x.integer ? Math.round(v) : v;
    });
    sets.push({ p, t: rnd() * 300 });
  }
  return sets;
}

function shader(law: StatelessLaw): string {
  const strata = strataVariant(law);
  return /* wgsl */ `
${STATELESS_RNG_WGSL}
${strata.wgsl}
// What the trillion kernel's plain entry points give a law.
fn strat(key: Key) -> vec2f { return vec2f(u01(key.x), u01(key.y)); }

struct U { p0: vec4f, p1: vec4f, t: f32, seed: u32, n: u32, _pad: u32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> o: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.n) { return; }
  let p = array<f32, 8>(u.p0.x, u.p0.y, u.p0.z, u.p0.w, u.p1.x, u.p1.y, u.p1.z, u.p1.w);
  let key = particleKey(g.x, u.seed);
  o[g.x] = vec4f(${law.fn}(key, u.t, p), ${strata.fn}(key, u.t, p));
}
`;
}

const cases: VerifyCase[] = [];
for (const law of STATELESS_LAWS) {
  cases.push(shaderCase(`stateless ${law.id} law compiles`, () => shader(law)));
  cases.push(shaderCase(`stateless ${law.id} law compiles in the trillion kernel`, () => splatWgsl(law, 8192)));
  cases.push(shaderCase(`stateless ${law.id} strata variant compiles in the trillion kernel`, () => splatWgsl(strataVariant(law), 8192)));
  cases.push({
    name: `stateless ${law.id} law matches its mirror on the GPU`,
    async run(t) {
      const tol = TOLERANCE[law.id] ?? 1e-3;
      const wraps = law.id === 'web';
      const code = shader(law);
      let worst = 0;
      for (const { p, t: time } of paramSets(law, 3)) {
        const uniform = new ArrayBuffer(48);
        const f = new Float32Array(uniform);
        const w = new Uint32Array(uniform);
        f.set(p, 0);
        f[8] = time;
        w[9] = SEED;
        w[10] = N;
        const out = await runCompute(t.device, {
          code,
          label: `stateless ${law.id}`,
          bindings: [
            { binding: 0, access: 'uniform', data: new Uint8Array(uniform) },
            { binding: 1, access: 'read_write', data: N * 16 },
          ],
          dispatch: [N / 64],
        });
        const gpu = new Float32Array(output(out, 1));
        for (let i = 0; i < N; i++) {
          const [x, y] = law.mirror(qFromKey(particleKey(i, SEED)), time, p);
          for (let k = 0; k < 4; k++) {
            let e = Math.abs(gpu[4 * i + k] - (k % 2 === 0 ? x : y));
            if (wraps) e = Math.min(e, Math.abs(2 - e));
            if (!(e <= tol)) {
              const form = k < 2 ? law.fn : `${law.fn}Strat`;
              throw new VerifyError(
                `${form} particle ${i}: GPU (${gpu[4 * i + (k & 2)]}, ${gpu[4 * i + (k & 2) + 1]}), mirror (${x}, ${y}), ` +
                  `params [${p.map((v) => +v.toFixed(4)).join(', ')}], t ${time.toFixed(3)}`,
              );
            }
            worst = Math.max(worst, e);
          }
        }
      }
      t.note(`max error ${worst.toExponential(2)} over ${3 * N} particles (bound ${tol})`);
    },
  });
}

export default cases;
