// Run with: node --test src/ux/behavior-ui/roll.test.mjs   (Node 22.18+ runs the .ts import directly)
import test from "node:test";
import assert from "node:assert/strict";
import { rollScene, rollParams, startRoll, seededRandom } from "./roll.ts";

const behavior = (id, params) => ({ id, params, wgsl: "" });
const BEHAVIORS = [
  behavior("drift", { speed: { default: 0.5, min: 0, max: 2 }, scale: { default: 2, min: 0.5, max: 8 } }),
  behavior("orbit", { spin: { default: 1, min: -3, max: 3 }, arms: { default: 2, min: 0, max: 6, step: 1 } }),
  behavior("bloom", { rate: { default: 0.7, min: 0.1, max: 3 } }),
  behavior("still", {}),
];
const plane = (behaviorId, i) => ({ position: [0, 0, i], rotation: [0, 0, 0, 1], halfSize: [1, 1], behaviorId, particleCount: 1000, seed: 0.25, params: {} });
const scene = (ids) => ({ version: 1, seed: 1, planes: ids.map(plane), camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5, fovY: 1 }, render: { brightness: 1 } });
const byId = Object.fromEntries(BEHAVIORS.map((b) => [b.id, b]));

function fakeApp(start) {
  let current = structuredClone(start);
  const app = {
    behaviors: BEHAVIORS, planes: [], loads: 0, updates: 0,
    getScene: () => ({ ...current, planes: app.planes.map((p) => p.desc) }),
    loadScene(s) { current = structuredClone(s); app.loads++; app.planes = current.planes.map((desc) => ({ desc, behavior: byId[desc.behaviorId] })); },
    updatePlane() { app.updates++; },
  };
  app.loadScene(start); app.loads = 0;
  return app;
}

test("rolls are deterministic and leave everything but behavior, params and seed alone", () => {
  const s = scene(["drift", "drift", "drift", "drift", "drift", "drift", "drift"]);
  const a = rollScene(s, BEHAVIORS, 7), b = rollScene(s, BEHAVIORS, 7);
  assert.deepEqual(a, b);
  assert.deepEqual(a.camera, s.camera);
  a.planes.forEach((p, i) => { assert.deepEqual(p.position, s.planes[i].position); assert.equal(p.particleCount, 1000); });
});

test("every rolled param is inside its known-good window, and steps are honoured", () => {
  const s = scene(["drift", "orbit", "bloom", "drift", "orbit", "bloom", "drift", "orbit"]);
  for (let seed = 0; seed < 300; seed++) {
    for (const p of rollScene(s, BEHAVIORS, seed).planes) {
      assert.deepEqual(Object.keys(p.params), Object.keys(byId[p.behaviorId].params));
      for (const [name, spec] of Object.entries(byId[p.behaviorId].params)) {
        const reach = 0.3 * (spec.max - spec.min) + 1e-9, v = p.params[name];
        assert.ok(v >= spec.min && v <= spec.max && Math.abs(v - spec.default) <= reach + (spec.step ?? 0) / 2, `${p.behaviorId}.${name}=${v}`);
        if (spec.step) assert.ok(Math.abs(v / spec.step - Math.round(v / spec.step)) < 1e-9);
      }
      assert.ok(p.seed >= 0 && p.seed < 1);
    }
  }
});

test("tuned ranges, spread 0 and exclude are respected", () => {
  const r = seededRandom(3);
  for (let i = 0; i < 100; i++) {
    const v = rollParams(BEHAVIORS[0], r, { ranges: { drift: { speed: [1.5, 1.6] } } }).speed;
    assert.ok(v >= 1.5 && v <= 1.6);
  }
  assert.deepEqual(rollParams(BEHAVIORS[0], r, { spread: 0 }), { speed: 0.5, scale: 2 });
  for (let seed = 0; seed < 50; seed++) {
    for (const p of rollScene(scene(["drift", "drift", "drift"]), BEHAVIORS, seed, { exclude: ["still", "bloom"] }).planes) assert.ok(["drift", "orbit"].includes(p.behaviorId));
  }
});

test("a roll always changes what the first plane is doing, and uses at most three behaviors", () => {
  const s = scene(Array(12).fill("drift"));
  for (let seed = 0; seed < 100; seed++) {
    const rolled = rollScene(s, BEHAVIORS, seed);
    assert.notEqual(rolled.planes[0].behaviorId, "drift");
    assert.ok(new Set(rolled.planes.map((p) => p.behaviorId)).size <= 3);
  }
});

test("degenerate inputs return the scene unchanged", () => {
  const s = scene(["drift"]);
  assert.equal(rollScene(s, [], 1), s);
  assert.equal(rollScene(scene([]), BEHAVIORS, 1).planes.length, 0);
});

test("kept behaviors glide to the target params with no reload", () => {
  const app = fakeApp(scene(["drift", "drift"]));
  const target = structuredClone(app.getScene());
  target.planes[0].params = { speed: 1.5, scale: 4 };
  target.planes[1].params = { speed: 0.1, scale: 1 };
  const tr = startRoll(app, target, { duration: 1, stagger: 0.2 });
  let prev = 0.5;
  for (let f = 0; f < 200 && !tr.update(1 / 60); f++) {
    const v = app.planes[0].desc.params.speed;
    assert.ok(v >= prev - 1e-9 && v <= 1.5 + 1e-9, "monotonic, no overshoot");
    prev = v;
  }
  assert.ok(tr.done);
  assert.equal(app.loads, 0);
  assert.deepEqual(app.planes.map((p) => p.desc.params), target.planes.map((p) => p.params));
});

test("changed behaviors reload once without swapBehavior, and never with it", () => {
  const start = scene(["drift", "drift", "orbit"]);
  const target = structuredClone(start);
  target.planes[0] = { ...target.planes[0], behaviorId: "bloom", params: { rate: 1 } };
  target.planes[1].params = { speed: 1, scale: 3 };

  const cut = fakeApp(start);
  const t1 = startRoll(cut, target, { duration: 0.5, stagger: 0.1 });
  assert.equal(cut.loads, 1);
  assert.deepEqual(cut.planes[1].desc.params, { speed: 0.5, scale: 2 }, "kept plane starts from where it was");
  while (!t1.update(1 / 60));
  assert.equal(cut.planes[0].desc.behaviorId, "bloom");
  assert.deepEqual(cut.planes[1].desc.params, { speed: 1, scale: 3 });

  const smooth = fakeApp(start);
  const swaps = [];
  const t2 = startRoll(smooth, target, { duration: 0.5, stagger: 0.1, swapBehavior: (p, d) => swaps.push(d.behaviorId) });
  while (!t2.update(1 / 60));
  assert.equal(smooth.loads, 0);
  assert.deepEqual(swaps, ["bloom"]);
});

test("a different plane count falls back to a plain load", () => {
  const app = fakeApp(scene(["drift"]));
  const tr = startRoll(app, scene(["drift", "orbit"]));
  assert.equal(app.loads, 1);
  assert.ok(tr.done && tr.update(0.016));
});

test("the engine's own setPlaneBehavior is used when present, and can be turned off", () => {
  const start = scene(["drift", "orbit"]);
  const target = structuredClone(start);
  target.planes[0] = { ...target.planes[0], behaviorId: "bloom", params: { rate: 1 }, seed: 0.5 };
  const app = fakeApp(start);
  const calls = [];
  app.setPlaneBehavior = (plane, change) => { calls.push(change); plane.desc.behaviorId = change.behaviorId; plane.behavior = byId[change.behaviorId]; };
  const tr = startRoll(app, target, { duration: 0.3 });
  while (!tr.update(1 / 60));
  assert.equal(app.loads, 0);
  assert.deepEqual(calls, [{ behaviorId: "bloom", params: { rate: 1 }, seed: 0.5 }]);

  const off = fakeApp(start);
  off.setPlaneBehavior = () => assert.fail("must not be called");
  startRoll(off, target, { swapBehavior: false });
  assert.equal(off.loads, 1);
});

test("author hints on a param are honoured: randomize false and randomRange", () => {
  const b = behavior("hinted", { fixed: { default: 3, min: 0, max: 10, randomize: false }, narrow: { default: 5, min: 0, max: 10, randomRange: [8, 9] } });
  const r = seededRandom(9);
  for (let i = 0; i < 100; i++) {
    const p = rollParams(b, r);
    assert.equal(p.fixed, 3);
    assert.ok(p.narrow >= 8 && p.narrow <= 9);
  }
});
