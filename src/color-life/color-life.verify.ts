/**
 * Checks for color life (`npm run verify -- color-life`):
 * - every shader compiles and passes the WGSL lint;
 * - one step of the grid sort on the GPU leaves every particle in state A,
 *   sorted by cell, with cell starts that match a CPU count;
 * - one step with motion moves particles the way the CPU force says.
 */

import { ColorLifeEngine } from "./engine";
import { pairForce, rollRules } from "./rules";
import { buildComputeShader, buildDrawShader, buildTonemapShader } from "./shaders";
import { shaderCase } from "../verify/shader-case";
import { VerifyError, type VerifyCase } from "../verify/types";

const cellOf = (x: number, y: number, g: number) => {
  const c = (v: number) => Math.min(g - 1, Math.max(0, Math.floor((v * 0.5 + 0.5) * g)));
  return c(y) * g + c(x);
};

const cases: VerifyCase[] = [
  shaderCase("color-life compute shader compiles", buildComputeShader),
  shaderCase("color-life draw shader compiles", buildDrawShader),
  shaderCase("color-life tonemap shader compiles", buildTonemapShader),
  {
    name: "color-life grid sort keeps every particle and sorts by cell",
    async run(t) {
      const n = 70_000; // more than one dispatch row, so the 2D index is exercised
      const grid = 40; // 1600 cells: several scan blocks
      const engine = new ColorLifeEngine(t.device, "rgba8unorm", { count: n, grid });
      try {
        const rules = rollRules(1234, { species: 5 });
        engine.setRules(rules);
        const enc = t.device.createCommandEncoder();
        engine.step(enc, 0); // dt 0: nobody moves, so A after the step is exactly A sorted
        t.device.queue.submit([enc.finish()]);
        const { state, species, starts } = await engine.snapshot();
        const cells = grid * grid;
        if (starts[cells] !== n) throw new VerifyError(`binned ${starts[cells]} of ${n}`);
        const counts = new Uint32Array(cells);
        let prev = -1;
        const seen = new Uint32Array(5);
        for (let j = 0; j < n; j++) {
          const x = state[j * 4];
          const y = state[j * 4 + 1];
          if (!(x >= -1 && x < 1 && y >= -1 && y < 1)) throw new VerifyError(`particle ${j} off the sheet: ${x}, ${y}`);
          const c = cellOf(x, y, grid);
          if (c < prev) throw new VerifyError(`slot ${j} is in cell ${c}, after cell ${prev}`);
          prev = c;
          counts[c]++;
          if (species[j] >= 5) throw new VerifyError(`species ${species[j]} out of range`);
          seen[species[j]]++;
        }
        let run = 0;
        for (let c = 0; c < cells; c++) {
          if (starts[c] !== run) throw new VerifyError(`starts[${c}] = ${starts[c]}, CPU says ${run}`);
          run += counts[c];
        }
        t.note(`species shares: ${[...seen].map((s) => ((100 * s) / n).toFixed(1) + "%").join(" ")}`);
      } finally {
        engine.destroy();
      }
    },
  },
  {
    name: "color-life step matches the CPU force",
    async run(t) {
      const n = 4000;
      const grid = 16;
      const engine = new ColorLifeEngine(t.device, "rgba8unorm", { count: n, grid });
      try {
        const rules = rollRules(99, { species: 4, style: "random" });
        engine.setRules(rules);
        let enc = t.device.createCommandEncoder();
        engine.step(enc, 0);
        t.device.queue.submit([enc.finish()]);
        const before = await engine.snapshot();
        const dt = 1 / 60;
        enc = t.device.createCommandEncoder();
        engine.step(enc, dt);
        t.device.queue.submit([enc.finish()]);
        const after = await engine.snapshot();
        // Within one cell the sort order depends on atomics, so slot j after
        // the step need not be slot j before. Match each moved particle to
        // the nearest CPU prediction of its own species instead.
        const R = 2 / grid;
        const exp = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
          const px = before.state[i * 4];
          const py = before.state[i * 4 + 1];
          let ax = 0;
          let ay = 0;
          for (let k = 0; k < n; k++) {
            if (k === i) continue;
            let dx = before.state[k * 4] - px;
            let dy = before.state[k * 4 + 1] - py;
            dx -= 2 * Math.floor(dx * 0.5 + 0.5);
            dy -= 2 * Math.floor(dy * 0.5 + 0.5);
            const d = Math.hypot(dx, dy);
            if (d <= 0 || d >= R) continue;
            const f = pairForce(d / R, rules.matrix[before.species[i] * 8 + before.species[k]], rules.beta) / d;
            ax += dx * f;
            ay += dy * f;
          }
          // Velocity starts at 0, so friction does not enter this first step.
          const k = R * rules.force * dt * dt;
          exp[i * 2] = px + ax * k;
          exp[i * 2 + 1] = py + ay * k;
        }
        let worst = 0;
        let moved = 0;
        for (let j = 0; j < n; j++) {
          const x = after.state[j * 4];
          const y = after.state[j * 4 + 1];
          let best = Infinity;
          for (let i = 0; i < n; i++) {
            if (before.species[i] !== after.species[j]) continue;
            // Torus distance: a particle may cross the wrapping edge this step.
            let ex = exp[i * 2] - x;
            let ey = exp[i * 2 + 1] - y;
            ex -= 2 * Math.round(ex / 2);
            ey -= 2 * Math.round(ey / 2);
            const e = Math.hypot(ex, ey);
            if (e < best) best = e;
          }
          worst = Math.max(worst, best);
          const v = Math.hypot(after.state[j * 4 + 2], after.state[j * 4 + 3]);
          if (v > 0) moved++;
        }
        if (worst > 1e-5) throw new VerifyError(`a particle is ${worst.toExponential(2)} from its CPU prediction`);
        if (moved < n / 2) throw new VerifyError(`only ${moved} of ${n} particles felt a force`);
        t.note(`worst position error ${worst.toExponential(2)}, ${moved} of ${n} moved`);
      } finally {
        engine.destroy();
      }
    },
  },
];

export default cases;
