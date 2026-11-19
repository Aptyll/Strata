/**
 * Correctness checks that run in the browser against a real WebGPU device
 * (open the benchmark page with ?selftest=1). They need no test framework so
 * this folder stays independent of the main app's tooling.
 *
 * The key invariant: rasterization is additive, so the sum of the atomic
 * framebuffer must equal (particles on screen) * weight exactly. That holds
 * across simulation steps (planes are toroidal, nothing leaves) and across
 * LOD (fewer particles, proportionally brighter).
 */

import type { FrameContext, GpuContext, PlaneInstance } from '../../core/contracts';
import { createAtomicRasterPass, LIGHT_ONE } from '../atomicRasterPass';
import { PerfBudget } from '../budget';
import {
  classifyPlane,
  DEFAULT_LOD,
  mat4Identity,
  packPosition,
  packVelocity,
  PerfEngine,
  unpackPosition,
  unpackVelocity,
  WEIGHT_ONE,
} from '../index';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const SIZE = 256;
const N = 200_000;

/** Maps the plane square to NDC [-0.9, 0.9] at depth 0.5: everything is on screen. */
function fitViewProj(offsetX = 0): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1.8;
  m[5] = 1.8;
  m[12] = offsetX;
  m[14] = 0.5;
  m[15] = 1;
  return m;
}

function sum(a: Uint32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export async function runSelfTest(device: GPUDevice): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

  // --- CPU: packing -------------------------------------------------------
  {
    const [x, y] = unpackPosition(packPosition(0.25, 0.75));
    check('pack position roundtrip', Math.abs(x - 0.25) < 1 / 65536 && Math.abs(y - 0.75) < 1 / 65536, `${x}, ${y}`);
    const [vx, vy] = unpackVelocity(packVelocity(-0.5, 1.25, 2), 2);
    check('pack velocity roundtrip', Math.abs(vx + 0.5) < 1e-4 && Math.abs(vy - 1.25) < 1e-4, `${vx}, ${vy}`);
    const [cx] = unpackVelocity(packVelocity(99, 0, 2), 2);
    check('pack velocity clamps', Math.abs(cx - 2) < 1e-6, `${cx}`);
  }

  // --- CPU: culling and LOD -----------------------------------------------
  {
    const on = classifyPlane(fitViewProj(), N, SIZE, SIZE, DEFAULT_LOD);
    check('plane in view is visible', on.visible && on.fraction === 1, JSON.stringify(on));
    const off = classifyPlane(fitViewProj(5), N, SIZE, SIZE, DEFAULT_LOD);
    check('plane off screen is culled', !off.visible && off.fraction === 0, JSON.stringify(off));
    const noCull = classifyPlane(fitViewProj(5), N, SIZE, SIZE, { ...DEFAULT_LOD, culling: false });
    check('culling can be disabled', noCull.visible, JSON.stringify(noCull));
    const dense = classifyPlane(fitViewProj(), 100_000_000, SIZE, SIZE, DEFAULT_LOD);
    const expectArea = (0.9 * SIZE) ** 2;
    check(
      'dense plane gets particle and rate LOD',
      Math.abs(dense.areaPx - expectArea) < 1 && dense.fraction === DEFAULT_LOD.minFraction && dense.simInterval === DEFAULT_LOD.maxSimInterval,
      JSON.stringify(dense),
    );
  }

  // --- CPU: ParticleBudget for the shared engine ---------------------------
  {
    const b = new PerfBudget({ width: 1000, height: 1000, pixelDensity: 4 });
    const planes = [
      { capacity: 1_000_000, distance: 1, visible: true, screenCoverage: 0.5 },
      { capacity: 1_000_000, distance: 9, visible: true, screenCoverage: 0.01 },
      { capacity: 1_000_000, distance: 1, visible: false, screenCoverage: 0 },
    ];
    const a = b.allocate({ planes, fps: 60, targetFps: 60 });
    check('budget: density cap and culling', a[0] === 1_000_000 && a[1] === 40_000 && a[2] === 0, a.join(', '));
    for (let i = 0; i < 20; i++) b.allocate({ planes, fps: 30, targetFps: 60 });
    const low = b.allocate({ planes, fps: 30, targetFps: 60 });
    check('budget: backs off when fps is low', low[0] < 100_000 && low[0] >= 1, `${low.join(', ')} scale ${b.scale.toFixed(3)}`);
    for (let i = 0; i < 600; i++) b.allocate({ planes, fps: 60, targetFps: 60 });
    check('budget: recovers when fps holds', b.scale === 1, `scale ${b.scale}`);
  }

  // --- GPU ----------------------------------------------------------------
  const target = device
    .createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT })
    .createView();
  const make = (behavior: string, lod = {}) => {
    const e = new PerfEngine(device, { format: 'rgba8unorm', lod: { lod: false, ...lod } });
    e.resize(SIZE, SIZE);
    e.addPlane({ count: N, model: mat4Identity(), behavior });
    return e;
  };
  const frame = (e: PerfEngine, viewProj = fitViewProj(), dt = 1 / 60, time = 0) =>
    e.frame({ viewProj, dt, time, target });

  device.pushErrorScope('validation');

  {
    const e = make('flow');
    e.simulate = false;
    frame(e);
    const fb = await e.readFramebuffer();
    const s = sum(fb);
    check('draw only: framebuffer sum is exact', s === N * WEIGHT_ONE, `${s} vs ${N * WEIGHT_ONE}`);
    let max = 0;
    for (const v of fb) max = Math.max(max, v);
    const mean = N / (0.9 * SIZE) ** 2;
    check('uniform init is evenly spread', max / WEIGHT_ONE < mean * 6 + 8, `max ${max / WEIGHT_ONE} per px, mean ${mean.toFixed(2)}`);

    const before = await e.readParticles(0, 4096);
    e.simulate = true;
    for (let i = 0; i < 30; i++) frame(e, fitViewProj(), 1 / 60, i / 60);
    const s2 = sum(await e.readFramebuffer());
    check('simulation conserves particles', s2 === N * WEIGHT_ONE, `${s2} vs ${N * WEIGHT_ONE}`);
    const after = await e.readParticles(0, 4096);
    let moved = 0;
    let dist = 0;
    for (let i = 0; i < before.length; i += 2) {
      if (before[i] !== after[i]) moved++;
      const [ax, ay] = unpackPosition(before[i]);
      const [bx, by] = unpackPosition(after[i]);
      dist += Math.hypot(bx - ax, by - ay);
    }
    const avg = dist / (before.length / 2);
    // flow speed is about 0.08 plane units/s, 0.5 s simulated
    check('simulation moves particles plausibly', moved > 4000 && avg > 0.005 && avg < 0.2, `moved ${moved}/4096, avg step ${avg.toFixed(4)}`);

    e.bilinear = true;
    frame(e);
    const s3 = sum(await e.readFramebuffer());
    check('bilinear splat keeps energy within 1%', Math.abs(s3 - N * WEIGHT_ONE) / (N * WEIGHT_ONE) < 0.01, `${s3} vs ${N * WEIGHT_ONE}`);
    e.destroy();
  }

  {
    const e = make('flow', { lod: true, pixelDensity: 1e-12, minFraction: 0.25 });
    const st = frame(e);
    const s = sum(await e.readFramebuffer());
    check(
      'LOD draws a quarter at 4x brightness',
      st.drawnParticles === N / 4 && s === N * WEIGHT_ONE,
      `drawn ${st.drawnParticles}, sum ${s} vs ${N * WEIGHT_ONE}`,
    );
    e.destroy();
  }

  {
    const e = make('flow', { culledSimInterval: 0 });
    const st = frame(e, fitViewProj(5));
    const s = sum(await e.readFramebuffer());
    check('culled plane costs no dispatch', st.dispatches === 0 && st.visiblePlanes === 0 && s === 0, `dispatches ${st.dispatches}, sum ${s}`);
    e.destroy();
  }

  {
    const e = make('flow', { culledSimInterval: 4 });
    let sims = 0;
    for (let i = 0; i < 8; i++) sims += frame(e, fitViewProj(5)).simulatedParticles > 0 ? 1 : 0;
    check('culled plane simulates at reduced rate', sims === 2, `${sims} of 8 frames`);
    e.destroy();
  }

  {
    const e = make('orbit');
    const p = await e.readParticles(0, 4096);
    let moving = 0;
    let maxR = 0;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i + 1] !== 0) moving++;
      const [x, y] = unpackPosition(p[i]);
      maxR = Math.max(maxR, Math.hypot(x - 0.5, y - 0.5));
    }
    check('orbit init: disc with orbital velocities', moving > 4000 && maxR <= 0.43, `moving ${moving}/4096, max radius ${maxR.toFixed(3)}`);
    for (let i = 0; i < 60; i++) frame(e, fitViewProj(), 1 / 60, i / 60);
    const q = await e.readParticles(0, 4096);
    let r = 0;
    for (let i = 0; i < q.length; i += 2) {
      const [x, y] = unpackPosition(q[i]);
      r = Math.max(r, Math.hypot(x - 0.5, y - 0.5));
    }
    // Circular orbits should stay circular: the disc must not blow up or collapse.
    check('orbit stays bound after 1 s', r < 0.47, `max radius ${r.toFixed(3)}`);
    e.destroy();
  }

  {
    // Every behavior compiles and runs: conservation holds for each.
    const e = new PerfEngine(device, { format: 'rgba8unorm', lod: { lod: false } });
    e.resize(SIZE, SIZE);
    for (const b of e.behaviors) e.addPlane({ count: 10_000, model: mat4Identity(), behavior: b.name });
    for (let i = 0; i < 10; i++) frame(e, fitViewProj(), 1 / 60, i / 60);
    const s = sum(await e.readFramebuffer());
    const want = e.behaviors.length * 10_000 * WEIGHT_ONE;
    check('all behaviors run and conserve particles', s === want, `${s} vs ${want}`);
    e.destroy();
  }

  {
    // Compute raster pass against a stand-in for the shared engine's GpuContext,
    // built from the layouts documented in docs/architecture.md.
    const M = 100_000;
    const globalsLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    const planeSim = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const globals = new ArrayBuffer(80);
    const gf = new Float32Array(globals);
    gf[0] = 0.9; gf[5] = 0.9; gf[14] = 0.5; gf[15] = 1; // sheet [-1, 1]^2 to NDC [-0.9, 0.9]
    gf[19] = 0.25; // brightness
    const globalsBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(globalsBuffer, 0, globals);
    const planeData = new ArrayBuffer(112);
    new Float32Array(planeData).set(mat4Identity());
    new Uint32Array(planeData)[24] = M / 2; // count: only half are active
    new Float32Array(planeData)[26] = 1; // brightness
    const planeUniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(planeUniform, 0, planeData);
    const pd = new Float32Array(M * 4);
    for (let i = 0; i < M; i++) {
      pd[i * 4] = Math.random() * 2 - 1;
      pd[i * 4 + 1] = Math.random() * 2 - 1;
    }
    const particles = device.createBuffer({ size: pd.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(particles, 0, pd);
    const hdrTexture = device.createTexture({ size: [SIZE, SIZE], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const gpu = {
      device,
      hdrFormat: 'rgba16float',
      layouts: { globals: globalsLayout, planeSim, planeRender: planeSim },
      globalsBuffer,
      globalsBindGroup: device.createBindGroup({ layout: globalsLayout, entries: [{ binding: 0, resource: { buffer: globalsBuffer } }] }),
    } as unknown as GpuContext;
    const plane = {
      capacity: M,
      activeCount: M / 2,
      particles,
      uniform: planeUniform,
      simBindGroup: device.createBindGroup({
        layout: planeSim,
        entries: [
          { binding: 0, resource: { buffer: planeUniform } },
          { binding: 1, resource: { buffer: particles } },
        ],
      }),
    } as unknown as PlaneInstance;
    const pass = createAtomicRasterPass(gpu);
    const encoder = device.createCommandEncoder();
    pass.execute({ gpu, encoder, planes: [plane], width: SIZE, height: SIZE, hdrView: hdrTexture.createView(), hdrTexture } as unknown as FrameContext);
    const staging = device.createBuffer({ size: SIZE * SIZE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(pass.counts!, 0, staging, 0, SIZE * SIZE * 4);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const s = sum(new Uint32Array(staging.getMappedRange()));
    staging.unmap();
    check('contract raster pass counts every active particle', s === (M / 2) * LIGHT_ONE, `${s / LIGHT_ONE} vs ${M / 2}`);
    pass.dispose?.();
  }

  const err = await device.popErrorScope();
  check('no WebGPU validation errors', !err, err ? err.message : '');
  return results;
}
