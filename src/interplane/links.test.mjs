// Run with: node --test src/interplane/links.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildLinks, planeModel } from "./links.ts";

const I = [0, 0, 0, 1];
const plane = (position, rotation = I, halfSize = [1, 1]) => ({ position, rotation, halfSize, behaviorId: "x", particleCount: 1, seed: 0 });
const find = (links, src, exit) => links.find((l) => l.src === src && l.exit === exit);

test("coplanar neighbours link edge to edge, unflipped", () => {
  const L = buildLinks([plane([0, 0, 0]), plane([2.5, 0, 0])]);
  assert.deepEqual(find(L, 0, 0), { src: 0, exit: 0, dst: 1, entry: 1, flip: 1, length: 0.5 });
  assert.deepEqual(find(L, 1, 1), { src: 1, exit: 1, dst: 0, entry: 0, flip: 1, length: 0.5 });
  assert.equal(find(L, 0, 1), undefined); // nothing behind plane 0
  assert.equal(L.length, 2);
});

test("a neighbour turned over flips the along-edge coordinate", () => {
  // 180 degrees about x: local y and the normal reverse, local x stays.
  const L = buildLinks([plane([0, 0, 0]), plane([2.5, 0, 0], [1, 0, 0, 0])]);
  assert.equal(find(L, 0, 0).dst, 1);
  assert.equal(find(L, 0, 0).entry, 1);
  assert.equal(find(L, 0, 0).flip, -1);
});

test("a ring of panels forms a closed loop in both directions", () => {
  const n = 10;
  const planes = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // rotate about y so local x runs around the ring
    planes.push(plane([Math.sin(a) * 3, 0, Math.cos(a) * 3], [0, Math.sin(a / 2), 0, Math.cos(a / 2)], [0.6, 1]));
  }
  const L = buildLinks(planes);
  for (const exit of [0, 1]) {
    let at = 0;
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      seen.add(at);
      at = find(L, at, exit).dst;
    }
    assert.equal(at, 0);
    assert.equal(seen.size, n);
  }
});

test("maxDistance cuts far links", () => {
  assert.equal(buildLinks([plane([0, 0, 0]), plane([10, 0, 0])], { maxDistance: 3 }).length, 0);
});

test("planeModel bakes half size into the axes", () => {
  const m = new Float32Array(16);
  planeModel(plane([1, 2, 3], I, [2, 0.5]), m);
  assert.deepEqual([...m], [2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
});
