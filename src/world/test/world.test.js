import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld,
  createStaticWorld,
  buildStructure,
  createStreamer,
  ARRANGEMENT_NAMES,
  INSTANCE_STRIDE,
  SLOT_FREE,
  SLOT_AWAKE,
  SLOT_ASLEEP,
  SLOT_LEAVING,
  toPlaneDesc,
  createWorldScene,
  createWorldDriver,
  math,
} from '../index';

const quatLength = (q) => Math.hypot(q[0], q[1], q[2], q[3]);

test('every arrangement builds valid planes', () => {
  for (const kind of ARRANGEMENT_NAMES) {
    for (let seed = 0; seed < 25; seed++) {
      const planes = buildStructure(kind, { seed, radius: 10, position: [5, 6, 7] });
      assert.ok(planes.length > 0, kind);
      for (const p of planes) {
        assert.ok(p.position.every(Number.isFinite), `${kind} position`);
        assert.ok(Math.abs(quatLength(p.rotation) - 1) < 1e-6, `${kind} rotation is unit`);
        assert.ok(p.size[0] > 0 && p.size[1] > 0, `${kind} size`);
        assert.ok(Number.isInteger(p.behavior) && p.behavior >= 0 && p.behavior < 8, `${kind} behavior`);
        assert.ok(Number.isInteger(p.seed) && p.seed >= 0 && p.seed <= 0xffffffff);
        assert.ok(p.particles >= 1024);
        // Stays near its nominal radius so structures do not spill far out of their sector.
        const d = Math.hypot(p.position[0] - 5, p.position[1] - 6, p.position[2] - 7);
        assert.ok(d <= 10 * 1.45, `${kind} centre within bounds (${d})`);
      }
    }
  }
});

test('plane normals follow the documented convention', () => {
  const q = math.quatFromNormal([1, 0, 0]);
  const n = math.rotate(q, [0, 0, 1]);
  assert.ok(Math.abs(n[0] - 1) < 1e-9 && Math.abs(n[1]) < 1e-9 && Math.abs(n[2]) < 1e-9);
  const up = math.rotate(q, [0, 1, 0]);
  assert.ok(Math.abs(up[1] - 1) < 1e-9);
});

test('crossed gives each axis family its own behavior', () => {
  const planes = buildStructure('crossed', { seed: 3, rotation: [0, 0, 0, 1], params: { count: 4 } });
  assert.equal(planes.length, 12);
  const byGroup = new Map();
  for (const p of planes) {
    const n = math.rotate(p.rotation, [0, 0, 1]).map((v) => Math.round(Math.abs(v)));
    assert.equal(n[p.group], 1);
    byGroup.set(p.group, p.behavior);
  }
  assert.equal(new Set(byGroup.values()).size, 3);
});

test('the world is deterministic and seed dependent', () => {
  const a = createWorld({ seed: 'strata' });
  const b = createWorld({ seed: 'strata' });
  const c = createWorld({ seed: 'other' });
  let differs = false;
  for (let x = -3; x <= 3; x++) {
    for (let y = -1; y <= 1; y++) {
      const pa = a.sector(x, y, -2);
      assert.deepEqual(pa, b.sector(x, y, -2));
      if (JSON.stringify(pa) !== JSON.stringify(c.sector(x, y, -2))) differs = true;
    }
  }
  assert.ok(differs);
});

test('sectors regenerate identically after cache eviction', () => {
  const w = createWorld({ seed: 9, cacheSectors: 4 });
  const first = JSON.stringify(w.sector(0, 0, 0));
  for (let i = 1; i < 20; i++) w.sector(i, 0, 0);
  assert.equal(JSON.stringify(w.sector(0, 0, 0)), first);
});

test('plane keys are unique and planes stay near their sector', () => {
  const w = createWorld({ seed: 4 });
  const keys = new Set();
  const kinds = new Set();
  for (let x = -4; x <= 4; x++) {
    for (let y = -4; y <= 4; y++) {
      for (let z = -4; z <= 4; z++) {
        for (const p of w.sector(x, y, z)) {
          assert.ok(!keys.has(p.key));
          keys.add(p.key);
          kinds.add(p.kind);
          const c = [x + 0.5, y + 0.5, z + 0.5].map((v) => v * 100);
          const d = Math.max(...p.position.map((v, i) => Math.abs(v - c[i])));
          assert.ok(d <= 100, `plane ${p.key} is ${d} from its sector centre`);
        }
      }
    }
  }
  for (const kind of ARRANGEMENT_NAMES) assert.ok(kinds.has(kind), `world contains ${kind}`);
});

test('query returns every plane within the radius', () => {
  const w = createWorld({ seed: 11 });
  const center = [37, -12, 260];
  const radius = 180;
  const got = new Set(w.query(center, radius).map((p) => p.key));
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      for (let z = 0; z <= 5; z++) {
        for (const p of w.sector(x, y, z)) {
          const inSector = p.position.every((v, i) => Math.floor(v / 100) === [x, y, z][i]);
          const d = Math.hypot(...p.position.map((v, i) => v - center[i]));
          if (inSector && d < radius) assert.ok(got.has(p.key), p.key);
        }
      }
    }
  }
});

function checkInvariants(s) {
  const keys = new Set();
  let awake = 0;
  let resident = 0;
  for (const slot of s.slots) {
    const o = slot.index * (INSTANCE_STRIDE / 4);
    assert.equal(s.instanceUints[o + 11], slot.state);
    if (slot.state === SLOT_FREE) {
      assert.equal(slot.plane, null);
      continue;
    }
    resident++;
    assert.ok(!keys.has(slot.plane.key), 'a plane holds one slot');
    keys.add(slot.plane.key);
    if (slot.state === SLOT_AWAKE) awake++;
    assert.ok(slot.fade >= 0 && slot.fade <= 1);
    assert.equal(s.instanceFloats[o], Math.fround(slot.plane.position[0]));
    assert.equal(s.instanceUints[o + 10], slot.plane.seed);
    assert.equal(s.instanceUints[o + 9], slot.plane.behavior);
  }
  assert.ok(resident <= s.maxPlanes);
  assert.ok(awake <= s.maxAwake);
  assert.equal(resident, s.stats.resident);
}

test('streaming holds its budgets along a long flight', () => {
  const w = createWorld({ seed: 2 });
  const s = createStreamer(w, { maxPlanes: 96, maxAwake: 24, maxParticles: 40_000_000 });
  const live = new Map();
  let spawned = 0;
  for (let frame = 0; frame < 1500; frame++) {
    const t = frame / 60;
    const position = [t * 40, Math.sin(t) * 60, Math.cos(t * 0.3) * 200];
    const forward = math.normalize([40, Math.cos(t) * 60, -Math.sin(t * 0.3) * 60]);
    const diff = s.update({ position, forward }, 1 / 60);
    for (const e of diff.despawned) {
      assert.equal(live.get(e.slot), e.plane.key, 'despawn matches an earlier spawn');
      live.delete(e.slot);
    }
    for (const e of diff.spawned) {
      assert.ok(!live.has(e.slot), 'slot was free before spawn');
      live.set(e.slot, e.plane.key);
      spawned++;
    }
    checkInvariants(s);
    assert.ok(s.stats.particles <= 40_000_000, 'particle budget is hard, fading planes included');
    assert.equal(live.size, s.stats.resident);
  }
  assert.ok(spawned > 300, `the world streamed (${spawned} spawns)`);
  assert.ok(s.stats.resident > 20);
});

test('a still camera settles and stops changing', () => {
  const w = createWorld({ seed: 5 });
  const s = createStreamer(w, { maxPlanes: 64, maxAwake: 16 });
  const cam = { position: [10, 20, 30], forward: [0, 0, -1] };
  const first = s.update(cam, 1 / 60);
  assert.equal(first.spawned.length, 64);
  assert.equal(first.woke.length, 16);
  for (let i = 0; i < 200; i++) {
    const d = s.update(cam, 1 / 60);
    assert.equal(d.spawned.length + d.despawned.length + d.woke.length + d.slept.length, 0);
  }
  for (const slot of s.slots) assert.ok(slot.state === SLOT_AWAKE || slot.state === SLOT_ASLEEP);
});

test('planes fade in, and far planes fade with distance', () => {
  const planes = [
    ...buildStructure('stack', { seed: 1, radius: 5, position: [0, 0, -20] }),
    ...buildStructure('cloud', { seed: 2, radius: 5, position: [0, 0, -95] }),
  ];
  const s = createStreamer(createStaticWorld(planes), { maxPlanes: 256, loadRadius: 100, fadeTime: 1 });
  s.update({ position: [0, 0, 0] }, 0);
  assert.ok(s.slots.every((x) => x.state === SLOT_FREE || x.fade === 0));
  for (let i = 0; i < 30; i++) s.update({ position: [0, 0, 0] }, 0.1);
  for (const slot of s.slots) {
    if (!slot.plane) continue;
    if (slot.plane.kind === 'stack') assert.equal(slot.fade, 1);
    else assert.ok(slot.fade < 0.35, `far plane is dim (${slot.fade})`);
  }
});

test('leaving planes fade out and can be reclaimed early', () => {
  const near = buildStructure('lattice', {
    seed: 1,
    radius: 5,
    position: [0, 0, 0],
    params: { counts: [2, 2, 2] },
  });
  const far = buildStructure('lattice', {
    seed: 2,
    radius: 5,
    position: [60, 0, 0],
    params: { counts: [2, 2, 2] },
  });
  const s = createStreamer(createStaticWorld([...near, ...far]), {
    maxPlanes: 8,
    maxAwake: 8,
    loadRadius: 500,
    fadeTime: 1,
    requeryDistance: 0,
    selectInterval: 0,
  });
  s.update({ position: [0, 0, 20] }, 2);
  assert.ok(s.slots.every((x) => x.plane.key.startsWith('lattice@') && near.includes(x.plane)));
  // Jump next to the far lattice: all eight slots are needed at once.
  const d = s.update({ position: [60, 0, 20] }, 0.1);
  assert.equal(d.despawned.length, 8);
  assert.equal(d.spawned.length, 8);
  assert.ok(s.slots.every((x) => far.includes(x.plane)));

  // With room to spare, the old planes linger as LEAVING while they fade.
  const roomy = createStreamer(createStaticWorld([...near, ...far]), {
    maxPlanes: 16,
    loadRadius: 30,
    fadeTime: 1,
    requeryDistance: 0,
    selectInterval: 0,
  });
  roomy.update({ position: [0, 0, 10] }, 2);
  roomy.update({ position: [60, 0, 10] }, 0.25);
  assert.equal(roomy.stats.leaving, 8);
  assert.ok(roomy.slots.some((x) => x.state === SLOT_LEAVING));
  for (let i = 0; i < 5; i++) roomy.update({ position: [60, 0, 10] }, 0.25);
  assert.equal(roomy.stats.leaving, 0);
  assert.equal(roomy.stats.resident, 8);
});

test('reset empties every slot', () => {
  const s = createStreamer(createWorld({ seed: 8 }), { maxPlanes: 32 });
  s.update({ position: [0, 0, 0] }, 0.1);
  const d = s.reset();
  assert.equal(d.despawned.length, 32);
  assert.ok(s.slots.every((x) => x.state === SLOT_FREE));
  assert.equal(s.update({ position: [0, 0, 0] }, 0.1).spawned.length, 32);
});

test('scenes convert to the engine contract', () => {
  const w = createWorld({ seed: 'strata' });
  const ids = ['drift', 'swirl', 'rain'];
  const scene = createWorldScene(w, { behaviorIds: ids, maxPlanes: 50, maxParticlesPerPlane: 100_000 });
  assert.equal(scene.version, 1);
  assert.equal(scene.planes.length, 50);
  assert.deepEqual(
    scene,
    createWorldScene(w, { behaviorIds: ids, maxPlanes: 50, maxParticlesPerPlane: 100_000 }),
  );
  assert.equal(new Set(scene.planes.map((p) => p.id)).size, 50);
  for (const d of scene.planes) {
    assert.ok(ids.includes(d.behaviorId));
    assert.ok(d.seed >= 0 && d.seed < 1);
    assert.ok(d.particleCount > 0 && d.particleCount <= 100_000);
    assert.ok(d.halfSize[0] > 0 && d.halfSize[1] > 0);
  }
  const plane = w.sector(0, 0, 0)[0];
  const desc = toPlaneDesc(plane, ids);
  assert.deepEqual(desc.halfSize, [plane.size[0] / 2, plane.size[1] / 2]);
  assert.equal(desc.id, plane.key);
  JSON.stringify(scene); // plain data
});

test('the driver mirrors the streamer onto a plane host', () => {
  const live = new Set();
  let created = 0;
  const host = {
    addPlane(desc) {
      const plane = { desc, paused: false };
      live.add(plane);
      created++;
      return plane;
    },
    removePlane(plane) {
      assert.ok(live.delete(plane), 'only live planes are removed');
    },
    updatePlane(plane) {
      assert.ok(live.has(plane), 'only live planes are updated');
    },
  };
  const w = createWorld({ seed: 6 });
  const driver = createWorldDriver(host, w, { behaviorIds: ['a', 'b'], maxPlanes: 40, maxAwake: 10, maxSpawnsPerFrame: 3 });
  for (let frame = 0; frame < 900; frame++) {
    const before = created;
    driver.update({ position: [frame * 0.8, 10, 20], forward: [1, 0, 0] }, 1 / 60);
    assert.ok(created - before <= 3, 'spawns are spread out');
    assert.ok(live.size <= 40);
    assert.equal(live.size + driver.pending, driver.streamer.stats.resident);
  }
  assert.ok(created > 80, `planes streamed through the host (${created})`);
  const paused = [...live].filter((p) => p.paused).length;
  assert.equal(live.size - paused, 10);
  for (const p of live) assert.ok(p.desc.brightness >= 0 && p.desc.brightness <= 1);
  driver.clear();
  assert.equal(live.size, 0);
});
