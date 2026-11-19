// Plain node:test, no extra dependencies. The sources are TypeScript, so
// run.mjs bundles them first with the esbuild that ships with vite:
//
//   node src/depth/test/run.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DepthParams, DEPTH_PARAMS_FLOATS, depthWGSL,
  FocusTracker, nearestPlaneDistance, rayPlaneDistance, focusPlaneFromDesc, ParallaxRig,
} from '../index';

const plane = (z, half = 10) => ({ center: [0, 0, z], u: [half, 0, 0], v: [0, half, 0] });

test('uniform layout matches the WGSL struct', () => {
  const body = depthWGSL.slice(depthWGSL.indexOf('struct DepthParams {'), depthWGSL.indexOf('};'));
  const fields = [...body.matchAll(/^\s*(\w+): f32,/gm)].map((m) => m[1]);
  assert.equal(fields.length, DEPTH_PARAMS_FLOATS);
  const p = new DepthParams({
    fogDensity: 101, fogPower: 102, fogStart: 103, nearFade: 104,
    focusDist: 105, aperture: 106, maxCocPx: 107, focusRange: 108,
    baseSize: 109, sizeAttenuation: 110, minPx: 111, brightness: 112,
    distDim: 115, refDist: 116, bokehEdge: 117, cullIntensity: 118,
  });
  const packed = p.pack({ viewportH: 113, projScaleY: 114 });
  const expected = {
    fogDensity: 101, fogPower: 102, fogStart: 103, nearFade: 104, focusDist: 105, aperture: 106,
    maxCocPx: 107, focusRange: 108, baseSize: 109, sizeAttenuation: 110, minPx: 111, brightness: 112,
    viewportH: 113, projScaleY: 114, distDim: 115, refDist: 116, bokehEdge: 117, cullIntensity: 118,
    pad0: 0, pad1: 0,
  };
  fields.forEach((f, i) => assert.equal(packed[i], expected[f], f));
});

test('disabled cues pack to neutral values', () => {
  const packed = new DepthParams({ fog: false, dof: false, atmosphere: false }).pack({ viewportH: 1, projScaleY: 1 });
  assert.equal(packed[0], 0);
  assert.equal(packed[5], 0);
  assert.equal(packed[9], 0);
  assert.equal(packed[14], 0);
});

test('fog falls monotonically and the cull distance matches the threshold', () => {
  const p = new DepthParams();
  assert.equal(p.fogAt(0), 1);
  assert.ok(p.fogAt(100) > p.fogAt(200));
  const d = p.fogCullDistance(0.01);
  assert.ok(Math.abs(p.fogAt(d) - 0.01) < 1e-9);
  assert.equal(new DepthParams({ fog: false }).fogCullDistance(), Infinity);
});

test('circle of confusion is zero in focus and clamped far out of focus', () => {
  const p = new DepthParams({ focusDist: 20, focusRange: 1, aperture: 8, maxCocPx: 30 });
  assert.equal(p.cocAt(20), 0);
  assert.equal(p.cocAt(20.9), 0);
  assert.ok(p.cocAt(40) > 0 && p.cocAt(40) < 8);
  assert.equal(p.cocAt(0.1), 30);
});

test('ray hits only inside the plane rectangle', () => {
  assert.equal(rayPlaneDistance([0, 0, 0], [0, 0, -1], plane(-5)), 5);
  assert.equal(rayPlaneDistance([50, 0, 0], [0, 0, -1], plane(-5)), Infinity);
  assert.equal(rayPlaneDistance([0, 0, 0], [0, 0, 1], plane(-5)), Infinity);
});

test('focus follows the nearest plane and skips ones inside minDist', () => {
  const planes = [plane(-30), plane(-2), plane(-12)];
  assert.equal(nearestPlaneDistance([0, 0, 0], [0, 0, -1], planes), 2);
  assert.equal(nearestPlaneDistance([0, 0, 0], [0, 0, -1], planes, 3), 12);
  const f = new FocusTracker({ initial: 50, tau: 0.5, minDist: 3 });
  const first = f.update([0, 0, 0], [0, 0, -1], planes, 0.1);
  assert.ok(first < 50 && first > 12);
  for (let i = 0; i < 200; i++) f.update([0, 0, 0], [0, 0, -1], planes, 0.1);
  assert.ok(Math.abs(f.distance - 12) < 1e-3);
  f.update([0, 0, 0], [0, 0, 1], planes, 0.1); // nothing ahead: hold
  assert.ok(Math.abs(f.distance - 12) < 1e-3);
});

test('parallax keeps the focus point as the look target', () => {
  const rig = new ParallaxRig({ driftAmount: 0, pointerAmount: 2, tau: 0 });
  rig.update(0.016, 1, -0.5);
  const { eye, target } = rig.apply([0, 0, 0], [0, 0, -1], [1, 0, 0], [0, 1, 0], 10);
  assert.deepEqual(eye, [2, -1, 0]);
  assert.deepEqual(target, [0, 0, -10]);
  rig.enabled = false;
  rig.update(0.016, 1, 1);
  assert.equal(rig.x, 0);
});

test('focus plane from a PlaneDesc applies rotation and half size', () => {
  const h = Math.SQRT1_2; // 90 degrees about Y: local +X becomes world -Z
  const p = focusPlaneFromDesc({ position: [1, 2, 3], rotation: [0, h, 0, h], halfSize: [4, 5] });
  assert.deepEqual(p.center, [1, 2, 3]);
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  assert.ok(near(p.u, [0, 0, -4]), String(p.u));
  assert.ok(near(p.v, [0, 5, 0]), String(p.v));
});
