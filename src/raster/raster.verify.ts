/**
 * Verify cases for src/raster: `npm run verify -- raster`.
 *
 * Runs the compute rasterizer's kernels (./kernel.ts) on a real device and
 * checks where the light lands and how much, against CPU numbers: the
 * default point add, the exact 2x2 split, fog through DepthParams' CPU mirror
 * (pointWeight), and depth of field spreading light inside the circle of
 * confusion without losing any.
 */

import { DepthParams, type DepthSettings } from "../depth/params";
import { dispatchSize, GLOBALS_SIZE } from "../gpu/shaderLib";
import { LIGHT_ONE } from "../perf/shaders";
import { expectEqual } from "../verify/compare";
import { output, runCompute, type ComputeBinding } from "../verify/gpu";
import { VerifyError, type VerifyCase } from "../verify/types";
import { rasterKernelWgsl, RASTER_VIEW_BYTES, type RasterKernelOptions } from "./kernel";

const W = 64;
const H = 32;
const N = 4096;
const PLANE_BYTES = 112; // model, params0, params1, count, seed, brightness (src/gpu/shaderLib.ts)
const EYE = [0, 0, -2] as const;

/** Plane-local x, y that land on pixel coordinate (px, py) with identity matrices. */
const ndcFor = (px: number, py: number): [number, number] => [(px / W) * 2 - 1, 1 - (py / H) * 2];

/**
 * Runs one kernel over N particles that all sit at the same point. Identity
 * model and view-projection, so clip = (x, y, 0, 1): every particle is at
 * view distance 1 and at world distance |(x, y, 2)| from EYE.
 */
async function rasterize(
  device: GPUDevice,
  options: RasterKernelOptions,
  at: [number, number],
  depth?: Partial<DepthSettings>,
): Promise<{ grid: Uint32Array; dist: number }> {
  const globals = new ArrayBuffer(GLOBALS_SIZE);
  new Float32Array(globals, 0, 16).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  new Uint32Array(globals, 72, 1)[0] = 7; // frame
  const plane = new ArrayBuffer(PLANE_BYTES);
  new Float32Array(plane, 0, 16).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  new Uint32Array(plane, 96, 1)[0] = N;
  new Float32Array(plane, 100, 2).set([12345, 1]); // seed, brightness
  const particles = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) particles.set(at, i * 4);

  const bindings: ComputeBinding[] = [
    { group: 0, binding: 0, access: "uniform", data: new Uint8Array(globals) },
    { group: 1, binding: 0, access: "uniform", data: new Uint8Array(plane) },
    { group: 1, binding: 1, access: "read_write", data: particles },
    { group: 2, binding: 0, access: "uniform", data: new Uint32Array([W, H]) },
    { group: 2, binding: 1, access: "read_write", data: W * H * 4 },
  ];
  if (options.depth) {
    bindings.push(
      { group: 2, binding: 2, access: "uniform", data: new DepthParams(depth).pack({ viewportH: H, projScaleY: 1 }) },
      { group: 2, binding: 3, access: "uniform", data: new Float32Array(RASTER_VIEW_BYTES / 4).fill(0).map((_, i) => EYE[i] ?? 0) },
    );
  }
  const outputs = await runCompute(device, {
    label: `raster ${JSON.stringify(options)}`,
    code: rasterKernelWgsl(options),
    bindings,
    dispatch: dispatchSize(N),
  });
  return { grid: new Uint32Array(output(outputs, "2.1")), dist: Math.hypot(at[0] - EYE[0], at[1] - EYE[1], -EYE[2]) };
}

const sum = (a: Uint32Array): number => a.reduce((s, v) => s + v, 0);

/** Stochastic rounding: each particle is off by less than one unit, by zero on average. */
function expectNear(actual: number, expected: number, what: string): void {
  const tolerance = 6 * Math.sqrt(N) * 0.5 + 1;
  if (Math.abs(actual - expected) > tolerance) {
    throw new VerifyError(`${what}: ${actual}, expected ${expected.toFixed(1)} within ${tolerance.toFixed(0)}`);
  }
}

const cases: VerifyCase[] = [
  {
    name: "default kernel: one add of LIGHT_ONE per particle on the pixel it lands on",
    async run(t) {
      const { grid } = await rasterize(t.device, {}, ndcFor(16.5, 8.5));
      const expected = new Uint32Array(W * H);
      expected[8 * W + 16] = N * LIGHT_ONE;
      expectEqual(grid, expected, "light grid");
    },
  },
  {
    name: "sub-pixel: light splits over the 2x2 pixels with exact bilinear weights",
    async run(t) {
      // Pixel coordinate (20.75, 11.0) is 0.25 and 0.5 past the centers of pixel (20, 10).
      const { grid } = await rasterize(t.device, { subpixel: true }, ndcFor(20.75, 11));
      const expected = new Uint32Array(W * H);
      expected[10 * W + 20] = N * LIGHT_ONE * 0.75 * 0.5;
      expected[10 * W + 21] = N * LIGHT_ONE * 0.25 * 0.5;
      expected[11 * W + 20] = N * LIGHT_ONE * 0.75 * 0.5;
      expected[11 * W + 21] = N * LIGHT_ONE * 0.25 * 0.5;
      expectEqual(grid, expected, "light grid");
    },
  },
  {
    name: "depth cues: fog dims each particle by DepthParams.pointWeight, on one pixel",
    async run(t) {
      const settings = { fog: true, dof: false, atmosphere: false, fogDensity: 0.5, fogPower: 2, fogStart: 0, nearFade: 0.5 };
      const { grid, dist } = await rasterize(t.device, { depth: true }, ndcFor(16.5, 8.5), settings);
      const weight = new DepthParams(settings).pointWeight(1, dist);
      if (!(weight > 0.2 && weight < 0.6)) throw new VerifyError(`test setup: weight ${weight} should be well inside (0, 1)`);
      expectNear(grid[8 * W + 16], N * LIGHT_ONE * weight, "fogged light on the pixel");
      expectNear(sum(grid), N * LIGHT_ONE * weight, "fogged light in the grid");
    },
  },
  {
    name: "depth of field: light spreads inside the circle of confusion and none is lost",
    async run(t) {
      // View distance 1, focus at 10: the circle of confusion is capped at maxCocPx.
      const settings = { fog: false, dof: true, atmosphere: false, aperture: 1, maxCocPx: 6, focusDist: 10, focusRange: 0, bokehEdge: 0, nearFade: 0.5 };
      for (const subpixel of [false, true]) {
        const { grid } = await rasterize(t.device, { depth: true, subpixel }, ndcFor(32, 16), settings);
        expectNear(sum(grid), N * LIGHT_ONE, `light in the grid${subpixel ? " (sub-pixel)" : ""}`);
        let lit = 0;
        let far = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (grid[y * W + x] === 0) continue;
            lit++;
            far = Math.max(far, Math.hypot(x + 0.5 - 32, y + 0.5 - 16));
          }
        }
        if (lit < 60) throw new VerifyError(`only ${lit} lit pixels: depth of field did not spread the light`);
        if (far > 6 + 1.5) throw new VerifyError(`light ${far.toFixed(2)} px from the center, past the 6 px circle of confusion`);
      }
    },
  },
];

export default cases;
