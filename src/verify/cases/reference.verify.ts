/**
 * Reference patterns, checked CPU against GPU. These are the building blocks
 * most particle shaders here are made of. They double as worked examples of
 * how to write a verify case, and as proof of the facts the lint rules and
 * docs/gpu-scale.md rely on.
 */

import { expectClose, expectEqual, expectUniform01 } from "../compare";
import { output, runCompute } from "../gpu";
import { DISPATCH_INDEX_WGSL, planDispatch } from "../limits";
import { PCG_WGSL, UNIT_FLOAT_WGSL, WRAP_WGSL, pcg, seededRandom, unitFloat, wrapSheet, wrappedDistance } from "../reference";
import { VerifyError, type VerifyCase } from "../types";

const f = Math.fround;

const cases: VerifyCase[] = [
  {
    name: "in-place particle integration matches the CPU reference over a 2D dispatch",
    async run(t) {
      const count = 20_000;
      const guard = 64; // particles past `count` must not be touched
      const steps = 8;
      const dt = f(1 / 60);
      const random = seededRandom(1);
      const initial = new Float32Array((count + guard) * 4).map(() => random() * 2 - 1);
      const plan = planDispatch(count, 64, 20);

      const outputs = await runCompute(t.device, {
        label: "integrate",
        code: /* wgsl */ `
          ${DISPATCH_INDEX_WGSL}
          ${WRAP_WGSL}
          struct Particle { pos: vec2f, vel: vec2f }
          struct Params { count: u32, rowStride: u32, dt: f32 }
          @group(0) @binding(0) var<uniform> params: Params;
          @group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
          @compute @workgroup_size(64)
          fn main(@builtin(global_invocation_id) gid: vec3u) {
            let i = dispatchIndex(gid, params.rowStride);
            if (i >= params.count) { return; }
            var p = particles[i];
            p.vel += vec2f(-p.pos.y, p.pos.x) * params.dt;
            p.pos = wrapSheet(p.pos + p.vel * params.dt);
            particles[i] = p;
          }`,
        bindings: [
          { binding: 0, access: "uniform", data: (() => {
            const b = new ArrayBuffer(16);
            new Uint32Array(b, 0, 2).set([count, plan.rowStride]);
            new Float32Array(b, 8, 1).set([dt]);
            return new Uint8Array(b);
          })() },
          { binding: 1, access: "read_write", data: initial },
        ],
        dispatch: [plan.x, plan.y],
        steps,
      });
      const actual = new Float32Array(output(outputs, 1));

      const expected = initial.slice();
      for (let s = 0; s < steps; s++) {
        for (let i = 0; i < count; i++) {
          const o = i * 4;
          const px = expected[o], py = expected[o + 1];
          const vx = f(expected[o + 2] + f(-py * dt));
          const vy = f(expected[o + 3] + f(px * dt));
          expected[o] = wrapSheet(f(px + f(vx * dt)));
          expected[o + 1] = wrapSheet(f(py + f(vy * dt)));
          expected[o + 2] = vx;
          expected[o + 3] = vy;
        }
      }

      // Positions are compared on the torus: a particle within rounding of an
      // edge may legitimately wrap on one side and not the other.
      let worst = 0;
      for (let i = 0; i < count * 4; i++) {
        const isPos = i % 4 < 2;
        const err = isPos ? wrappedDistance(actual[i], expected[i]) : Math.abs(actual[i] - expected[i]);
        if (!(err <= 1e-4)) {
          throw new VerifyError(`particle ${i >> 2} field ${i % 4}: got ${actual[i]}, expected ${expected[i]}`);
        }
        worst = Math.max(worst, err);
      }
      t.note(`max error after ${steps} steps: ${worst.toExponential(2)}`);
      expectEqual(actual.subarray(count * 4), initial.subarray(count * 4), "particles past count");
    },
  },
  {
    name: "atomic binning (compute rasterization) matches a CPU histogram exactly",
    async run(t) {
      const count = 300_000;
      const width = 100; // not a power of two on purpose
      const height = 60;
      const random = seededRandom(2);
      // Mostly crowded into a few pixels so that many invocations collide, plus some off-screen.
      const points = new Float32Array(count * 2).map((_, i) => (i % 16 < 12 ? random() * 0.1 : random() * 2.4 - 1.2));
      const plan = planDispatch(count, 64, 70);
      const shader = (atomic: boolean): string => /* wgsl */ `
        ${DISPATCH_INDEX_WGSL}
        struct Params { count: u32, rowStride: u32, width: u32, height: u32 }
        @group(0) @binding(0) var<uniform> params: Params;
        @group(0) @binding(1) var<storage, read> points: array<vec2f>;
        @group(0) @binding(2) var<storage, read_write> bins: array<${atomic ? "atomic<u32>" : "u32"}>;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) gid: vec3u) {
          let i = dispatchIndex(gid, params.rowStride);
          if (i >= params.count) { return; }
          let uv = points[i] * 0.5 + 0.5;
          if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return; }
          let size = vec2u(params.width, params.height);
          // uv * size can round up to exactly size, which would land in the next row.
          let px = min(vec2u(uv * vec2f(size)), size - 1u);
          let bin = px.y * params.width + px.x;
          ${atomic ? "atomicAdd(&bins[bin], 1u);" : "bins[bin] += 1u; // verify-ok: nonatomic-accumulate (the race is the point)"}
        }`;
      const run = async (atomic: boolean): Promise<Uint32Array> =>
        new Uint32Array(
          output(
            await runCompute(t.device, {
              label: atomic ? "atomic binning" : "racy binning",
              code: shader(atomic),
              bindings: [
                { binding: 0, access: "uniform", data: new Uint32Array([count, plan.rowStride, width, height]) },
                { binding: 1, access: "read", data: points },
                { binding: 2, access: "read_write", data: width * height * 4 },
              ],
              dispatch: [plan.x, plan.y],
            }),
            2,
          ),
        );

      const expected = new Uint32Array(width * height);
      let onScreen = 0;
      for (let i = 0; i < count; i++) {
        const u = f(f(points[i * 2] * 0.5) + 0.5);
        const v = f(f(points[i * 2 + 1] * 0.5) + 0.5);
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        const x = Math.min(Math.trunc(f(u * width)), width - 1);
        const y = Math.min(Math.trunc(f(v * height)), height - 1);
        expected[y * width + x]++;
        onScreen++;
      }

      expectEqual(await run(true), expected, "bins");
      expectEqual(await run(true), expected, "bins, second run");

      // The same shader without atomics. Losing counts is the expected outcome
      // of the race; it is reported, not asserted, because a race may not show.
      const racy = await run(false);
      const kept = racy.reduce((a, b) => a + b, 0);
      t.note(
        kept === onScreen
          ? "the non-atomic variant lost no counts on this adapter (the race did not show up this run)"
          : `the non-atomic variant lost ${onScreen - kept} of ${onScreen} counts to the race`,
      );
    },
  },
  {
    name: "PCG hash and 24 bit unit float are bit-identical on CPU and GPU, and uniform",
    async run(t) {
      const count = 65_536;
      const outputs = await runCompute(t.device, {
        label: "hash",
        code: /* wgsl */ `
          ${PCG_WGSL}
          ${UNIT_FLOAT_WGSL}
          @group(0) @binding(0) var<storage, read_write> hashes: array<u32>;
          @group(0) @binding(1) var<storage, read_write> floats: array<f32>;
          @compute @workgroup_size(64)
          fn main(@builtin(global_invocation_id) gid: vec3u) {
            let i = gid.x;
            if (i >= arrayLength(&hashes)) { return; }
            // Indices far above 2^24, where a float based hash would repeat.
            let h = pcg(pcg(i + 4000000000u) ^ 0x9e3779b9u);
            hashes[i] = h;
            floats[i] = unitFloat(h);
          }`,
        bindings: [
          { binding: 0, access: "read_write", data: count * 4 },
          { binding: 1, access: "read_write", data: count * 4 },
        ],
        dispatch: [count / 64],
      });
      const expectedHashes = new Uint32Array(count).map((_, i) => pcg((pcg((i + 4_000_000_000) >>> 0) ^ 0x9e3779b9) >>> 0));
      expectEqual(new Uint32Array(output(outputs, 0)), expectedHashes, "hashes");
      const floats = new Float32Array(output(outputs, 1));
      expectEqual(floats, Float32Array.from(expectedHashes, unitFloat), "unit floats");
      const stats = expectUniform01(floats, "unitFloat(pcg)");
      t.note(`mean ${stats.mean.toFixed(4)}, chi2/dof ${stats.chi2PerDof.toFixed(2)}, serial correlation ${stats.serialCorrelation.toFixed(4)}`);
    },
  },
  {
    name: "f32 facts behind the lint rules hold on this GPU",
    async run(t) {
      const inputs = new Uint32Array([0xffffffff, 0xffffff80, 0xffffff01, 0xffffff00, 16_777_217, 16_777_216, 16_777_218]);
      const outputs = await runCompute(t.device, {
        label: "f32 facts",
        code: /* wgsl */ `
          @group(0) @binding(0) var<storage, read> inputs: array<u32>;
          @group(0) @binding(1) var<storage, read_write> divided: array<f32>;
          @group(0) @binding(2) var<storage, read_write> shifted: array<f32>;
          @group(0) @binding(3) var<storage, read_write> converted: array<f32>;
          @compute @workgroup_size(1)
          fn main(@builtin(global_invocation_id) gid: vec3u) {
            let i = gid.x; // verify-ok: unguarded-dispatch (dispatch equals the array length)
            let h = inputs[i];
            divided[i] = f32(h) / 4294967296.0; // verify-ok: rand-reaches-one (demonstrating it)
            shifted[i] = f32(h >> 8u) * (1.0 / 16777216.0);
            converted[i] = f32(h);
          }`,
        bindings: [
          { binding: 0, access: "read", data: inputs },
          { binding: 1, access: "read_write", data: inputs.byteLength },
          { binding: 2, access: "read_write", data: inputs.byteLength },
          { binding: 3, access: "read_write", data: inputs.byteLength },
        ],
        dispatch: [inputs.length],
      });
      const divided = new Float32Array(output(outputs, 1));
      const shifted = new Float32Array(output(outputs, 2));
      const converted = new Float32Array(output(outputs, 3));
      // Division by 2^32 reaches exactly 1.0 for the top hash values. WGSL lets
      // an inexact u32 to f32 conversion round either way, so how many of the
      // top 255 values reach 1.0 depends on the GPU. Only the extremes are asserted.
      if (divided[0] !== 1) throw new VerifyError(`f32(0xffffffff) / 2^32 = ${divided[0]}, expected exactly 1`);
      if (!(divided[3] < 1)) throw new VerifyError(`f32(0xffffff00) / 2^32 = ${divided[3]}, expected below 1`);
      // The 24 bit version never does, and is exact.
      const top = f(0xffffff / 16777216);
      expectClose(shifted.subarray(0, 4), [top, top, top, top], { abs: 0, rel: 0, what: "24 bit unit float" });
      if (!(top < 1)) throw new VerifyError("24 bit unit float reached 1");
      // An index above 2^24 collapses onto one of its neighbours.
      if (converted[4] !== converted[5] && converted[4] !== converted[6]) {
        throw new VerifyError(`f32(16777217) = ${converted[4]}, expected 16777216 or 16777218`);
      }
      const reachOne = [1, 2].filter((k) => divided[k] === 1).map((k) => `0x${inputs[k].toString(16)}`);
      t.note(`f32(h) / 2^32 is exactly 1.0 for 0xffffffff${reachOne.length ? `, ${reachOne.join(", ")}` : ""} on this adapter`);
    },
  },
];

export default cases;
