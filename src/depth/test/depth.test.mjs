// Plain node:test, no extra dependencies. The sources are TypeScript, so
// npm test bundles them first with the esbuild that ships with vite:
//
//   npm test -- depth
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DepthParams, DEPTH_PARAMS_FLOATS, depthWGSL,
  FocusTracker, nearestPlaneDistance, rayPlaneDistance, focusPlaneFromDesc, ParallaxRig, createParallaxCamera,
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
    distDim: 115, refDist: 116, bokehEdge: 117, cullIntensity: 118, pointGainMax: 119,
  });
  const packed = p.pack({ viewportH: 113, projScaleY: 114 });
  const expected = {
    fogDensity: 101, fogPower: 102, fogStart: 103, nearFade: 104, focusDist: 105, aperture: 106,
    maxCocPx: 107, focusRange: 108, baseSize: 109, sizeAttenuation: 110, minPx: 111, brightness: 112,
    viewportH: 113, projScaleY: 114, distDim: 115, refDist: 116, bokehEdge: 117, cullIntensity: 118,
    pointGainMax: 119, pad1: 0,
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

test('lens jitter stays inside the circle of confusion and is zero in focus', () => {
  const p = new DepthParams({ focusDist: 20, focusRange: 0, aperture: 10, maxCocPx: 50 });
  assert.deepEqual(p.lensJitterPx(20, 0.3, 0.7), [0, 0]);
  const coc = p.cocAt(60);
  for (let i = 0; i < 200; i++) {
    const [x, y] = p.lensJitterPx(60, (i + 0.5) / 200, (i * 0.618) % 1);
    assert.ok(Math.hypot(x, y) <= coc + 1e-9);
  }
  assert.deepEqual(new DepthParams({ dof: false }).lensJitterPx(60, 0.5, 0.5), [0, 0]);
});

test('point weight fades with fog and gains up close, within the cap', () => {
  const p = new DepthParams({ refDist: 20, nearFade: 1, pointGainMax: 4 });
  assert.ok(p.pointWeight(40, 40) < p.pointWeight(20, 20));
  assert.ok(Math.abs(p.pointWeight(20, 20) - p.fogAt(20)) < 1e-12);
  assert.ok(p.pointWeight(2, 2) <= 4);
  assert.ok(p.pointWeight(0, 0) < 1e-6);
});

test('parallax camera keeps the focus point still and moves the eye sideways', () => {
  // Camera at the origin looking down -Z, 90 degree fov, square aspect.
  const near = 0.1, far = 100;
  const vp = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]);
  const inner = { state: { target: [0, 0, -10], yaw: 0, pitch: 0, distance: 10, fovY: Math.PI / 2 }, update() {}, eye: () => [0, 0, 0], viewProjection: () => vp };
  const cam = createParallaxCamera(inner, { pointerAmount: 2, driftAmount: 0, tau: 0, relative: false, focusDist: () => 10 });
  cam.setPointer(1, 0);
  cam.update(0.016);
  const m = cam.viewProjection(1);
  const project = (q) => {
    const c = [0, 1, 3].map((r) => m[r] * q[0] + m[4 + r] * q[1] + m[8 + r] * q[2] + m[12 + r]);
    return [c[0] / c[2], c[1] / c[2]];
  };
  const near0 = (a) => Math.abs(a) < 1e-6;
  assert.ok(near0(project([0, 0, -10])[0]) && near0(project([0, 0, -10])[1])); // focus point holds
  assert.ok(project([0, 0, -5])[0] < 0); // nearer slides against the eye
  assert.ok(project([0, 0, -20])[0] > 0); // farther slides with it
  assert.deepEqual(cam.eye(), [2, 0, 0]);
  cam.parallax.enabled = false;
  cam.update(0.016);
  assert.deepEqual([...cam.viewProjection(1)], [...vp]);
});

test('rim samples of the lens cover every angle, not a few wedges', () => {
  const p = new DepthParams({ focusDist: 20, focusRange: 0, aperture: 10, maxCocPx: 50, bokehEdge: 1 });
  const bins = new Array(360).fill(0);
  const w = 1 / 4;
  for (let i = 0; i < 3600; i++) {
    const u2 = ((i + 0.5) / 3600) * w; // rim branch only
    const [x, y] = p.lensJitterPx(60, 0.9, u2);
    bins[Math.floor(((Math.atan2(y, x) / (2 * Math.PI)) + 1) % 1 * 360)]++;
  }
  assert.ok(bins.every((n) => n > 0));
});
