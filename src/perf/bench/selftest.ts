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

import { behaviors } from '../../behaviors';
import type { Behavior, FrameContext, GpuContext, PlaneDesc, PlaneInstance } from '../../core/contracts';
import { GLOBALS_SIZE, PLANE_UNIFORM_SIZE } from '../../gpu/shaderLib';
import { mat4Identity } from '../../math';
import { createAtomicRasterPass } from '../atomicRasterPass';
import { PerfBudget } from '../budget';
import {
  classifyPlane,
  DEFAULT_LOD,
  LIGHT_ONE,
  packPosition,
  packVelocity,
  PerfEngine,
  unpackPosition,
  unpackVelocity,
} from '../index';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const SIZE = 256;
const N = 200_000;

/** Maps the sheet [-1, 1]^2 to NDC [-0.9, 0.9] at depth 0.5: everything is on screen. */
function fitViewProj(offsetX = 0): Float32Array {
  const m = new Float32Array(16);
  m[0] = 0.9;
  m[5] = 0.9;
  m[12] = offsetX;
  m[14] = 0.5;
  m[15] = 1;
  return m;
}

const sheet = (behaviorId: string, particleCount: number, params?: Record<string, number>): PlaneDesc => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  halfSize: [1, 1],
  behaviorId,
  particleCount,
  seed: 0.37,
  params,
});

/** Constant drift at plane.params.speed: slow enough to need sub-quantum dithering. */
const DRIFT: Behavior = {
  id: 'perf-test-drift',
  params: { speed: { default: 0.001, min: 0, max: 1 } },
  wgsl: /* wgsl */ `
fn update(pIn: Particle, i: u32) -> Particle {
  var p = pIn;
  p.vel = vec2f(plane.params.speed, 0.0);
  p.pos = wrap(p.pos + p.vel * globals.dt);
  return p;
}`,
};

/** Has its own CPU init: everything starts at one point, moving right. */
const POINT: Behavior = {
  id: 'perf-test-point',
  params: {},
  wgsl: /* wgsl */ `fn update(p: Particle, i: u32) -> Particle { return p; }`,
  init(out, count) {
    for (let i = 0; i < count; i++) out.set([0.5, -0.25, 1, 0], i * 4);
  },
};

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
    const [x, y] = unpackPosition(packPosition(0.25, -0.75));
    check('pack position roundtrip', Math.abs(x - 0.25) < 2 / 65536 && Math.abs(y + 0.75) < 2 / 65536, `${x}, ${y}`);
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
    // A fake clock that jumps a full second per call, so every call is one governor step.
    let clock = 0;
    const b = new PerfBudget({ width: 1000, height: 1000, pixelDensity: 4, now: () => (clock += 1000) });
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

    // The app passes one averaged reading for every frame of a 250 ms window.
    // Those 15 frames are one step: the cut must not compound.
    let t = 0;
    const g = new PerfBudget({ now: () => t });
    for (let i = 0; i < 15; i++, t += 1000 / 60) g.allocate({ planes, fps: 45, targetFps: 60 });
    check('budget: a stale fps reading cuts once, not once per frame', g.scale === 0.8, `scale ${g.scale}`);
  }

  // --- GPU ----------------------------------------------------------------
  const target = device
    .createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT })
    .createView();
  const make = (lod = {}) => {
    const e = new PerfEngine(device, { format: 'rgba8unorm', lod: { lod: false, ...lod } });
    e.resize(SIZE, SIZE);
    return e;
  };
  const frame = (e: PerfEngine, viewProj = fitViewProj(), dt = 1 / 60, time = 0) =>
    e.frame({ viewProj, dt, time, target });

  device.pushErrorScope('validation');

  {
    const e = make();
    const id = e.addPlane(sheet(DRIFT.id, N), DRIFT);
    e.simulate = false;
    frame(e);
    const fb = await e.readFramebuffer();
    const s = sum(fb);
    check('draw only: framebuffer sum is exact', s === N * LIGHT_ONE, `${s} vs ${N * LIGHT_ONE}`);
    let max = 0;
    for (const v of fb) max = Math.max(max, v);
    const mean = N / (0.9 * SIZE) ** 2;
    check('default seeding is evenly spread', max / LIGHT_ONE < mean * 6 + 8, `max ${max / LIGHT_ONE} per px, mean ${mean.toFixed(2)}`);

    const before = await e.readParticles(id, 4096);
    e.simulate = true;
    const FRAMES = 120;
    for (let i = 0; i < FRAMES; i++) frame(e, fitViewProj(), 1 / 60, i / 60);
    const s2 = sum(await e.readFramebuffer());
    check('simulation conserves particles', s2 === N * LIGHT_ONE, `${s2} vs ${N * LIGHT_ONE}`);
    const after = await e.readParticles(id, 4096);
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < before.length; i += 2) {
      const [ax, ay] = unpackPosition(before[i]);
      const [bx, by] = unpackPosition(after[i]);
      dx += ((bx - ax + 3) % 2) - 1; // shortest way around the torus
      dy += Math.abs(by - ay);
    }
    dx /= before.length / 2;
    const want = 0.001 * (FRAMES / 60);
    // Each step is about half a position quantum: plain rounding would give 0 or 2x.
    check('dithering keeps sub-quantum motion', Math.abs(dx - want) < want * 0.1 && dy === 0, `moved ${dx.toExponential(3)}, expected ${want.toExponential(3)}`);

    e.updatePlane(id, sheet(DRIFT.id, N, { speed: 0.5 }));
    for (let i = 0; i < 6; i++) frame(e);
    const fast = await e.readParticles(id, 4096);
    let fx = 0;
    for (let i = 0; i < fast.length; i += 2) fx += ((unpackPosition(fast[i])[0] - unpackPosition(after[i])[0] + 3) % 2) - 1;
    fx /= fast.length / 2;
    check('params reach the behavior', Math.abs(fx - 0.05) < 0.002, `moved ${fx.toFixed(4)}, expected 0.0500`);
    const [vx] = unpackVelocity(fast[1], 4);
    check('velocity is stored', Math.abs(vx - 0.5) < 0.001, `${vx}`);

    e.bilinear = true;
    frame(e);
    const s3 = sum(await e.readFramebuffer());
    check('bilinear splat keeps energy within 1%', Math.abs(s3 - N * LIGHT_ONE) / (N * LIGHT_ONE) < 0.01, `${s3} vs ${N * LIGHT_ONE}`);
    e.destroy();
  }

  {
    const e = make({ lod: true, pixelDensity: 1e-12, minFraction: 0.25 });
    e.addPlane(sheet(DRIFT.id, N), DRIFT);
    const st = frame(e);
    const s = sum(await e.readFramebuffer());
    check(
      'LOD draws a quarter at 4x brightness',
      st.drawnParticles === N / 4 && s === N * LIGHT_ONE,
      `drawn ${st.drawnParticles}, sum ${s} vs ${N * LIGHT_ONE}`,
    );
    e.destroy();
  }

  {
    const e = make({ culledSimInterval: 0 });
    e.addPlane(sheet(DRIFT.id, N), DRIFT);
    const st = frame(e, fitViewProj(5));
    const s = sum(await e.readFramebuffer());
    check('culled plane costs no dispatch', st.dispatches === 0 && st.visiblePlanes === 0 && s === 0, `dispatches ${st.dispatches}, sum ${s}`);
    e.destroy();
  }

  {
    const e = make({ culledSimInterval: 4 });
    e.addPlane(sheet(DRIFT.id, N), DRIFT);
    let sims = 0;
    for (let i = 0; i < 8; i++) sims += frame(e, fitViewProj(5)).simulatedParticles > 0 ? 1 : 0;
    check('culled plane simulates at reduced rate', sims === 2, `${sims} of 8 frames`);
    e.destroy();
  }

  {
    const e = make();
    const id = e.addPlane(sheet(POINT.id, 5000), POINT);
    const p = await e.readParticles(id, 5000);
    let ok = true;
    for (let i = 0; i < p.length; i += 2) ok &&= p[i] === packPosition(0.5, -0.25) && p[i + 1] === packVelocity(1, 0, 4);
    check('behavior init() is packed and uploaded', ok, '');

    // Streaming: removed ranges are reused instead of growing.
    const a = e.addPlane(sheet(DRIFT.id, 1000), DRIFT);
    e.addPlane(sheet(DRIFT.id, 1000), DRIFT);
    e.removePlane(a);
    e.addPlane(sheet(DRIFT.id, 600), DRIFT);
    const free = e.pool.pages[0].free;
    check(
      'removed planes free their range for reuse',
      e.pool.pages.length === 1 && e.particleCount === 6600 && free[0][0] === 5600 && free[0][1] === 400,
      `particles ${e.particleCount}, free ${JSON.stringify(free.slice(0, 2))}`,
    );
    e.destroy();
  }

  {
    // Every registered behavior compiles on this path and conserves particles.
    const e = make();
    for (const b of behaviors) e.addPlane(sheet(b.id, 10_000), b);
    for (let i = 0; i < 10; i++) frame(e, fitViewProj(), 1 / 60, i / 60);
    const s = sum(await e.readFramebuffer());
    const want = behaviors.length * 10_000 * LIGHT_ONE;
    check(`all ${behaviors.length} registered behaviors run packed: ${behaviors.map((b) => b.id).join(', ')}`, s === want, `${s} vs ${want}`);
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
    const globals = new ArrayBuffer(GLOBALS_SIZE); // brushes stay zero: radius 0 means unused
    const gf = new Float32Array(globals);
    gf[0] = 0.9; gf[5] = 0.9; gf[14] = 0.5; gf[15] = 1; // sheet [-1, 1]^2 to NDC [-0.9, 0.9]
    gf[19] = 0.25; // brightness
    const globalsBuffer = device.createBuffer({ size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(globalsBuffer, 0, globals);
    const planeData = new ArrayBuffer(PLANE_UNIFORM_SIZE);
    new Float32Array(planeData).set(mat4Identity());
    new Uint32Array(planeData)[24] = M / 2; // count: only half are active
    new Float32Array(planeData)[26] = 1; // brightness
    const planeUniform = device.createBuffer({ size: PLANE_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
