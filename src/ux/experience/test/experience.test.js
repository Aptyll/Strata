// Plain JS on purpose: the shared toolchain has no test runner or Node types
// yet, and this folder should not change shared config. Bundle and run with:
//
//   npx esbuild src/ux/experience/test/experience.test.js --bundle --platform=node \
//     --format=esm --outfile=dist/ux-experience.test.mjs \
//     && node --test dist/ux-experience.test.mjs
//
// When the project adopts a runner, this file ports by changing two imports.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CameraRig, planeFromDesc } from '../camera-rig';
import { gainToActiveCount } from '../index';
import { chooseTier, detectCapability, explainUnsupported, parseUserAgent } from '../capability';
import { ForceBrush, brushForce, packBrushes } from '../force-brush';
import { GestureCore } from '../gestures';
import { HintScheduler } from '../hints';
import { INTRO_DURATION, IntroDirector, ignitionRanks, introState, planeIgnition } from '../intro';
import { m4 } from '../math';
import { intersectPlane, pickPlane, screenToRay } from '../pointer-ray';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const plane = (z) => ({ center: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfSize: [1, 1] });

test('intro opens on true black and ends fully lit', () => {
  const a = introState(0);
  assert.equal(a.phase, 'hold');
  assert.equal(a.exposure, 0);
  assert.equal(a.sparkAlpha, 0);
  const z = introState(INTRO_DURATION);
  assert.equal(z.done, true);
  assert.equal(z.exposure, 1);
  assert.equal(z.spread, 1);
  assert.equal(z.cameraWeight, 0);
});

test('intro values only ever increase', () => {
  let prev = introState(0);
  for (let t = 0.05; t <= INTRO_DURATION; t += 0.05) {
    const s = introState(t);
    for (const k of ['exposure', 'heroBloom', 'spread']) assert.ok(s[k] >= prev[k] - 1e-9, `${k} at ${t}`);
    assert.ok(s.pose.distance >= prev.pose.distance - 1e-9);
    prev = s;
  }
});

test('the camera stays face-on until the plane has filled in', () => {
  const s = introState(6.4);
  assert.equal(s.pose.yaw, 0);
  assert.equal(s.pose.distance, 0);
  assert.ok(s.heroBloom > 0.99);
  assert.equal(s.spread, 0);
});

test('planes ignite outward from the hero', () => {
  const planes = [plane(-2), plane(-1), plane(0), plane(1), plane(3)];
  const ranks = ignitionRanks(planes, 2);
  assert.equal(ranks[2], 0);
  assert.equal(ranks[4], 1);
  assert.equal(planeIgnition(0, 0), 1);
  assert.equal(planeIgnition(0, 0.5), 0);
  assert.ok(planeIgnition(0.5, 0.2) > planeIgnition(0.5, 0.9));
  for (const r of [0.1, 0.5, 1]) assert.equal(planeIgnition(1, r), 1);
});

test('reduced motion never moves the camera', () => {
  const a = introState(0.1, { variant: 'reduced' });
  const b = introState(2, { variant: 'reduced' });
  assert.deepEqual(a.pose, b.pose);
  assert.ok(b.exposure > a.exposure);
});

test('skipping fast-forwards instead of cutting, and frees the camera', () => {
  const d = new IntroDirector({ variant: 'full', skipSeconds: 1.4 });
  for (let i = 0; i < 60; i++) d.update(1 / 60);
  d.skip();
  let s;
  for (let i = 0; i < 30; i++) s = d.update(1 / 60);
  assert.equal(s.cameraWeight, 0, 'camera released within half a second');
  assert.equal(d.done, false, 'still playing out');
  for (let i = 0; i < 60; i++) s = d.update(1 / 60);
  assert.equal(d.done, true);
  assert.equal(s.spread, 1);
});

test('a ray through the screen centre hits the plane centre', () => {
  const rig = new CameraRig();
  rig.snap({ target: [0, 0, 0], yaw: 0.4, pitch: 0.2, distance: 4 });
  const { invViewProj } = rig.matrices(16 / 9);
  const hit = intersectPlane(screenToRay(0, 0, invViewProj), plane(0));
  near(hit.u, 0);
  near(hit.v, 0);
  near(hit.t, 4 - rig.near, 1e-2);
});

test('screen right and up map to +u and +v when face-on', () => {
  const rig = new CameraRig();
  rig.snap({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 4 });
  const { invViewProj } = rig.matrices(1);
  const hit = intersectPlane(screenToRay(0.5, 0.25, invViewProj), plane(0));
  assert.ok(hit.u > 0 && hit.v > 0);
  near(hit.u / hit.v, 2);
});

test('picking takes the nearest sheet, honours focus, and ignores edge-on sheets', () => {
  const planes = [plane(-1), plane(0), plane(1)];
  const rig = new CameraRig();
  rig.snap({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5 });
  let ray = screenToRay(0, 0, rig.matrices(1).invViewProj);
  assert.equal(pickPlane(ray, planes).index, 2);
  assert.equal(pickPlane(ray, planes, { focused: 0 }).index, 0);
  assert.equal(pickPlane(ray, planes, { visible: (i) => i !== 2 }).index, 1);
  rig.snap({ yaw: Math.PI / 2 - 0.02 });
  ray = screenToRay(0, 0, rig.matrices(1).invViewProj);
  assert.equal(pickPlane(ray, planes), null);
});

test('matrix inverse round-trips', () => {
  const rig = new CameraRig();
  rig.snap({ target: [1, 2, 3], yaw: 1, pitch: -0.5, distance: 7 });
  const { viewProj, invViewProj } = rig.matrices(1.5);
  const id = m4.multiply(viewProj, invViewProj);
  for (let i = 0; i < 16; i++) near(id[i], i % 5 === 0 ? 1 : 0, 1e-2);
});

test('focusing a plane ends up square-on and fitted', () => {
  const rig = new CameraRig();
  rig.snap({ target: [0, 0, 0], yaw: 0.9, pitch: 0.4, distance: 9 });
  const p = plane(2);
  rig.focusPlane(p, 1);
  for (let i = 0; i < 280; i++) rig.update(1 / 60);
  near(rig.state.yaw, 0, 1e-2);
  near(rig.state.pitch, 0, 1e-2);
  near(rig.state.target[2], 2, 1e-2);
  const hit = intersectPlane(screenToRay(0, 0.86, rig.matrices(1).invViewProj), p);
  near(hit.v, 1, 2e-2);
});

test('the camera drifts only after a quiet spell', () => {
  const rig = new CameraRig({ idleDelay: 5 });
  for (let i = 0; i < 60 * 4; i++) rig.update(1 / 60);
  assert.equal(rig.goal.yaw, 0);
  for (let i = 0; i < 60 * 6; i++) rig.update(1 / 60);
  assert.ok(rig.goal.yaw > 0);
});

const hitAt = (u, v, index = 0) => ({ index, u, v, t: 1, grip: 1, facing: 1, point: [0, 0, 0] });

test('holding deepens the well, and release fires an outward burst', () => {
  const b = new ForceBrush();
  b.update(1 / 60, hitAt(0, 0), 0.2);
  b.press('attract');
  const early = b.update(1 / 60, hitAt(0, 0), 0.2).strength;
  let late;
  for (let i = 0; i < 120; i++) late = b.update(1 / 60, hitAt(0, 0), 0.2);
  assert.ok(early > 0 && late.strength > early);
  assert.ok(late.radius > 0.2, 'a charged well reaches further');
  b.release();
  const burst = b.update(1 / 60, hitAt(0, 0), 0.2);
  assert.ok(burst.strength < -0.5);
  let rest;
  for (let i = 0; i < 60; i++) rest = b.update(1 / 60, hitAt(0, 0), 0.2);
  assert.equal(rest.plane, -1, 'a still pointer exerts nothing');
});

test('a moving pointer leaves a gentle repelling wake', () => {
  const b = new ForceBrush();
  let out;
  for (let i = 0; i < 30; i++) out = b.update(1 / 60, hitAt(i * 0.02, 0), 0.2);
  assert.ok(out.strength < 0 && out.strength >= -0.12);
});

test('changing sheets does not smear the brush across the gap', () => {
  const b = new ForceBrush();
  b.update(1 / 60, hitAt(-0.9, 0, 0), 0.2);
  const out = b.update(1 / 60, hitAt(0.9, 0, 1), 0.2);
  assert.equal(out.u, 0.9);
  assert.equal(out.du, 0);
});

test('brush force pulls inward, vanishes at the edge, and is finite at the centre', () => {
  const b = { u: 0, v: 0, radius: 0.5, strength: 1 };
  const [ax] = brushForce(0.2, 0, b);
  assert.ok(ax < 0);
  assert.deepEqual(brushForce(0.6, 0, b), [0, 0]);
  const c = brushForce(1e-9, 0, b);
  assert.ok(Number.isFinite(c[0]) && Math.abs(c[0]) < 1);
});

test('a PlaneDesc with identity rotation faces +z; a quarter turn about y faces +x', () => {
  const flat = planeFromDesc({ position: [1, 2, 3], rotation: [0, 0, 0, 1], halfSize: [2, 1] });
  assert.deepEqual(flat.normal, [0, 0, 1]);
  assert.deepEqual(flat.center, [1, 2, 3]);
  const h = Math.SQRT1_2;
  const turned = planeFromDesc({ position: [0, 0, 0], rotation: [0, h, 0, h], halfSize: [1, 1] });
  near(turned.normal[0], 1);
  near(turned.u[2], -1);
  near(turned.v[1], 1);
});

test('gain maps to an active particle count that starts at one', () => {
  assert.equal(gainToActiveCount(1e6, 0), 0);
  assert.equal(gainToActiveCount(1e6, 0.0001), 1);
  assert.equal(gainToActiveCount(1e6, 1), 1e6);
  assert.ok(gainToActiveCount(1e6, 0.5) < 5e5);
});

test('brushes pack to 8 floats with -1 marking empty slots', () => {
  const out = packBrushes([{ plane: 3, u: 0.1, v: 0.2, radius: 0.3, strength: 0.4, du: 0, dv: 0, charge: 1 }]);
  assert.equal(out.length, 32);
  assert.equal(out[6], 3);
  assert.equal(out[8 + 6], -1);
});

function recorder(opts) {
  const log = [];
  const h = {};
  for (const n of ['onOrbit', 'onZoom', 'onHoldStart', 'onHoldMove', 'onHoldEnd', 'onTap', 'onDoubleTap']) {
    h[n] = (...a) => log.push([n, ...a]);
  }
  return { log, core: new GestureCore(h, opts), names: () => log.map((l) => l[0]) };
}

test('press and move is a camera drag', () => {
  const r = recorder();
  r.core.down({ id: 1, x: 100, y: 100, button: 0 }, 0);
  r.core.move({ id: 1, x: 120, y: 100 }, 16);
  r.core.tick(400);
  r.core.move({ id: 1, x: 130, y: 100 }, 420);
  r.core.up({ id: 1, x: 130, y: 100 }, 440);
  assert.deepEqual(r.names(), ['onOrbit', 'onOrbit']);
  assert.equal(r.log[0][1], 20, 'travel inside the slop radius is not lost');
});

test('press and stay still is a hold that can then be dragged', () => {
  const r = recorder();
  r.core.down({ id: 1, x: 100, y: 100, button: 0 }, 0);
  r.core.tick(100);
  assert.deepEqual(r.names(), []);
  r.core.tick(180);
  r.core.move({ id: 1, x: 200, y: 100 }, 300);
  r.core.up({ id: 1, x: 200, y: 100 }, 400);
  assert.deepEqual(r.names(), ['onHoldStart', 'onHoldMove', 'onHoldEnd']);
  assert.equal(r.log[0][4], 'attract');
});

test('secondary button and shift repel', () => {
  const r = recorder();
  r.core.down({ id: 1, x: 0, y: 0, button: 2 }, 0);
  assert.equal(r.log[0][4], 'repel');
  const s = recorder();
  s.core.down({ id: 1, x: 0, y: 0, button: 0, shift: true }, 0);
  s.core.tick(200);
  assert.equal(s.log[0][4], 'repel');
});

test('with holdSecondary, a right drag stays a drag and a right hold still repels', () => {
  // The app's camera pans on a right drag, so engine-brushes sets holdSecondary.
  const drag = recorder({ holdSecondary: 170 });
  drag.core.down({ id: 1, x: 0, y: 0, button: 2 }, 0);
  drag.core.move({ id: 1, x: 30, y: 0 }, 16);
  drag.core.tick(400);
  drag.core.up({ id: 1, x: 30, y: 0 }, 420);
  assert.deepEqual(drag.names(), ['onOrbit'], 'no push swallows the pan');
  const hold = recorder({ holdSecondary: 170 });
  hold.core.down({ id: 1, x: 0, y: 0, button: 2 }, 0);
  hold.core.tick(100);
  assert.deepEqual(hold.names(), []);
  hold.core.tick(180);
  assert.deepEqual(hold.names(), ['onHoldStart']);
  assert.equal(hold.log[0][4], 'repel');
});

test('tap and double tap', () => {
  const r = recorder();
  r.core.down({ id: 1, x: 50, y: 50, button: 0 }, 0);
  r.core.up({ id: 1, x: 50, y: 50 }, 60);
  r.core.down({ id: 1, x: 52, y: 50, button: 0 }, 200);
  r.core.up({ id: 1, x: 52, y: 50 }, 260);
  assert.deepEqual(r.names(), ['onTap', 'onDoubleTap']);
});

test('two fingers pinch, and spreading them moves in', () => {
  const r = recorder();
  r.core.down({ id: 1, x: 100, y: 100, type: 'touch' }, 0);
  r.core.down({ id: 2, x: 200, y: 100, type: 'touch' }, 10);
  r.core.move({ id: 2, x: 300, y: 100, type: 'touch' }, 30);
  r.core.tick(500);
  r.core.up({ id: 2, x: 300, y: 100, type: 'touch' }, 520);
  r.core.up({ id: 1, x: 100, y: 100, type: 'touch' }, 540);
  assert.deepEqual(r.names(), ['onZoom']);
  near(r.log[0][1], 0.5);
});

test('hints wait their turn, show once, and retire when learned', () => {
  const h = new HintScheduler(undefined, { gap: 1 });
  assert.equal(h.update(10, false), null, 'nothing during the intro');
  assert.equal(h.update(5, true), null);
  assert.equal(h.update(1.1, true).id, 'orbit');
  h.learn('orbit');
  assert.equal(h.update(0.1, true), null);
  let cur = null;
  for (let i = 0; i < 80 && !cur; i++) cur = h.update(0.1, true);
  assert.equal(cur.id, 'hold');
  h.learn('hold');
  h.learn('zoom');
  h.learn('focus');
  for (let i = 0; i < 400; i++) assert.equal(h.update(0.1, true), null);
});

test('an ignored hint is not repeated', () => {
  const h = new HintScheduler([{ id: 'a', text: 'a', delay: 1, duration: 2 }], { gap: 0 });
  const seen = [];
  for (let i = 0; i < 300; i++) seen.push(h.update(0.1, true)?.id ?? null);
  const shows = seen.filter((id, i) => id === 'a' && seen[i - 1] !== 'a').length;
  assert.equal(shows, 1);
});

test('capability: user agents, tiers and explanations', async () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  assert.deepEqual(parseUserAgent(iphone), { os: 'ios', browser: 'safari' });
  assert.equal(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5).os, 'ios');
  assert.equal(parseUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0').browser, 'firefox');
  assert.equal(chooseTier({ touch: true, os: 'android', memoryGb: 4, cores: 8 }), 'low');
  assert.equal(chooseTier({ touch: false, os: 'windows', memoryGb: 16, cores: 12, maxBufferSize: 2 ** 32 }), 'high');
  assert.equal(chooseTier({ touch: false, os: 'windows', fallbackAdapter: true }), 'low');

  const none = await detectCapability({ navigator: { userAgent: iphone }, matchMedia: () => ({ matches: true }), isSecureContext: true });
  assert.equal(none.status, 'no-api');
  assert.equal(none.webgpu, false);
  assert.match(explainUnsupported(none).action, /iOS/);
  const http = await detectCapability({ navigator: {}, matchMedia: () => ({ matches: false }), isSecureContext: false });
  assert.equal(http.status, 'insecure-context');
  const blocked = await detectCapability({ navigator: { gpu: { requestAdapter: async () => null } }, matchMedia: () => ({ matches: false }) });
  assert.equal(blocked.status, 'no-adapter');
  assert.match(explainUnsupported(blocked).action, /hardware acceleration/);
  const ok = await detectCapability({ navigator: { gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 2 ** 32 } }) }, hardwareConcurrency: 16, deviceMemory: 8 }, matchMedia: () => ({ matches: false }) });
  assert.equal(ok.webgpu, true);
  assert.equal(ok.tier, 'high');
});
