// Tests for src/ux/returning. No DOM and no GPU: a stand-in HUD and engine, an
// in-memory storage, a clock that can be moved to tomorrow.
//   npm test -- returning
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideArrival, parseRoll, rollHash } from './arrival';
import { dailySeed, dayKey, dayLabel, daysBetween, isDay } from './daily';
import { WorldHistory } from './history';
import { NEWS, unseenNews } from './news';
import { MAX_KEPT, STORE_KEY, countVisit, freshRecord, parseRecord, readRecord, writeRecord } from './store';
import { cloneScene, isScene, sameWorld, takeSnapshot, usable, withParticleTotal, worldName } from './worlds';
import { mountReturning } from './index';

// ---- stand-ins ---------------------------------------------------------------

const BEHAVIORS = ['flow', 'galaxy', 'wells', 'curl'].map((id) => ({ id, label: id, params: { speed: { default: 1, min: 0, max: 2 } }, wgsl: '' }));

const plane = (behaviorId, i) => ({
  position: [i, 0, 0], rotation: [0, 0, 0, 1], halfSize: [1, 1],
  behaviorId, particleCount: 1000, seed: (i * 0.37) % 1, params: { speed: 1 },
});
const sceneOf = (ids) => ({
  version: 1, seed: 1, planes: ids.map(plane),
  camera: { target: [0, 0, 0], yaw: 0.6, pitch: -0.3, distance: 5, fovY: 0.9 },
  render: { brightness: 1 },
});
const OPENING = ['flow', 'galaxy', 'wells', 'curl', 'flow', 'galaxy'];

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** A clock that reads noon on a given day and can be moved. */
function clock(day = '2026-11-19') {
  const [y, m, d] = day.split('-').map(Number);
  let date = new Date(y, m - 1, d, 12);
  return {
    now: () => date,
    tomorrow() { date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12); },
  };
}

/**
 * The engine and the HUD as this module sees them. Like the real engine, a
 * roll changes nothing at once: the planes change on the next frame (frame()),
 * all together, or one sheet a frame with `sweep` (the real dice sweep through
 * the stack for several seconds). Like the real HUD's wiring, a roll writes
 * #r=<seed> into the address.
 */
function world({ storage = memoryStorage(), time = clock(), search = '', hash = '', rolled = false, sweep = false, streamed = false } = {}) {
  const live = (desc) => ({ desc, get capacity() { return desc.particleCount; } });
  let scene = sceneOf(OPENING);
  let planes = scene.planes.map(live);
  // A streamed world (?world=) adds its sheets outside the scene, which then lists none of them.
  if (streamed) scene = { ...scene, planes: [] };
  let pending = null;
  const address = { search, hash, setHash(h) { address.hash = h; } };
  const said = [];
  const loads = [];
  const params = new Map();
  const shortcuts = new Map();
  const rollHandlers = new Set();
  const changeHandlers = new Set();
  const values = new Map([['theme', 'white'], ['brightness', 1]]);

  const app = {
    behaviors: BEHAVIORS,
    get planes() { return planes; },
    // The engine hands out its live scene with the live camera, as src/app/scene.ts does.
    getScene: () => ({ ...scene, camera: app.camera }),
    loadScene(next) {
      loads.push(next);
      scene = next;
      planes = scene.planes.map(live);
      app.camera = next.camera;
      pending = null;
    },
    camera: scene.camera,
  };

  const hud = {
    busy: false, panelOpen: false, rolled,
    announce: (title, sub) => void said.push(sub ? `${title} | ${sub}` : title),
    randomize(seed) {
      if (hud.busy) return { seed: 0, face: 1 };
      seed >>>= 0;
      pending = { seed, next: 0 };
      address.hash = rollHash(seed);
      for (const fn of rollHandlers) fn({ seed, face: (seed % 6) + 1 });
      return { seed, face: (seed % 6) + 1 };
    },
    onRandomize: (fn) => { rollHandlers.add(fn); return () => rollHandlers.delete(fn); },
    on: (type, fn) => { if (type === 'change') changeHandlers.add(fn); return () => changeHandlers.delete(fn); },
    registerParam: (spec) => { params.set(spec.id, spec); return {}; },
    removeParam: (id) => void params.delete(id),
    registerShortcut: (spec) => { shortcuts.set(spec.key, spec); return () => shortcuts.delete(spec.key); },
    getParam: (id) => values.get(id),
    setParam: (id, v) => { values.set(id, v); return v; },
    closePanel: () => { hud.panelOpen = false; },
  };

  /** One frame: a roll in flight lands (every sheet takes a rule picked by the seed), or its next sheet does. */
  const frame = (r, dt = 1 / 60) => {
    if (pending !== null) {
      const { seed } = pending;
      const upTo = sweep ? pending.next + 1 : planes.length;
      for (let i = pending.next; i < upTo; i++) {
        planes[i].desc.behaviorId = BEHAVIORS[(seed + i) % BEHAVIORS.length].id;
        planes[i].desc.params = { speed: ((seed % 97) + i) / 100 };
      }
      pending = upTo >= planes.length ? null : { seed, next: upTo };
    }
    r.update(dt);
  };
  /** A person moves a behavior slider. */
  const tune = (value) => {
    planes[0].desc.params = { ...planes[0].desc.params, speed: value };
    for (const fn of changeHandlers) fn(`behavior.${planes[0].desc.behaviorId}.speed`, value);
  };
  const mount = (extra = {}) =>
    mountReturning({
      app, hud, storage, now: time.now, address, touch: false,
      keys: { today: { key: 'n', label: "today's world" }, keep: { key: 'k', label: 'keep' }, previous: { key: 'backspace', label: 'previous' } },
      ...extra,
    });
  const rules = () => planes.map((p) => p.desc.behaviorId).join(',');
  const particles = () => planes.reduce((n, p) => n + p.capacity, 0);
  /** The particles setting: the same world reloaded with every sheet scaled, as src/ux/hud/wire.ts does. */
  const resize = (factor) => {
    const now = app.getScene();
    app.loadScene({ ...now, planes: now.planes.map((p) => ({ ...p, particleCount: Math.round(p.particleCount * factor) })) });
  };
  return { app, hud, storage, time, address, said, loads, params, shortcuts, frame, tune, mount, rules, particles, resize };
}

const stored = (storage) => JSON.parse(storage.getItem(STORE_KEY));

// ---- the day -----------------------------------------------------------------

test('a day is the local calendar date, and its seed never changes', () => {
  assert.equal(dayKey(new Date(2026, 10, 19, 23, 59)), '2026-11-19');
  assert.equal(dayKey(new Date(2027, 0, 1, 0, 0)), '2027-01-01');
  assert.ok(isDay('2026-11-19') && !isDay('2026-11-9') && !isDay(20261119));
  // Pinned: changing the hash would give everyone a different "today" than the day before the change.
  assert.equal(dailySeed('2026-11-19'), dailySeed('2026-11-19'));
  assert.equal(dailySeed('2026-11-19') >>> 0, dailySeed('2026-11-19'));
  assert.equal(dayLabel('2026-11-19'), 'nov 19');
  assert.equal(dayLabel('2026-01-05'), 'jan 5');
  assert.equal(daysBetween('2026-11-19', '2026-11-20'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2026-11-19', '2026-11-12'), -7);
});

test('every day of three years gets its own seed, spread over the dice faces', () => {
  const seeds = new Set();
  const faces = new Array(6).fill(0);
  const date = new Date(2026, 0, 1, 12);
  for (let i = 0; i < 1096; i++) {
    const seed = dailySeed(dayKey(date));
    seeds.add(seed);
    faces[seed % 6]++;
    date.setDate(date.getDate() + 1);
  }
  assert.equal(seeds.size, 1096);
  for (const n of faces) assert.ok(n > 130 && n < 240, `face count ${n}`);
});

// ---- arrival -----------------------------------------------------------------

const visitor = (extra = {}) => ({ ...countVisit(freshRecord('2026-11-18', 0), '2026-11-18'), ...extra });
const arrive = (extra) => decideArrival({ search: '', hash: '', today: '2026-11-19', record: visitor(), opensOn: 'today', ...extra });

test('a first visit and any address that names something are left alone', () => {
  assert.deepEqual(arrive({ record: null }), { kind: 'untouched', reason: 'first-visit' });
  for (const search of ['?behaviors=flow', '?world', '?world=strata', '?daily=0', '?intro=0', '?seed=4', '?record', '?particles=1000000', '?theme=red&planes=8']) {
    assert.deepEqual(arrive({ search }), { kind: 'untouched', reason: 'explicit-address' }, search);
  }
  // A hash this code does not understand belongs to someone else.
  assert.deepEqual(arrive({ hash: '#s=abc' }), { kind: 'untouched', reason: 'explicit-address' });
  assert.deepEqual(arrive({ hash: '#menu', record: null }), { kind: 'untouched', reason: 'explicit-address' });
});

test('the plain address opens on today for someone who has been here', () => {
  const today = { kind: 'today', day: '2026-11-19', seed: dailySeed('2026-11-19') };
  assert.deepEqual(arrive({}), today);
  assert.deepEqual(arrive({ search: '?theme=red' }), today); // a color theme is a look, not a world
  assert.deepEqual(arrive({ hash: '#' }), today);
});

test('a roll in the address is shown, with one mention a day that today is waiting', () => {
  assert.deepEqual(arrive({ hash: '#r=abc' }), { kind: 'keep', invite: true });
  assert.deepEqual(arrive({ hash: '#r=abc', record: visitor({ invited: '2026-11-19' }) }), { kind: 'keep', invite: false });
  const seenToday = visitor({ daily: { day: '2026-11-19', seed: dailySeed('2026-11-19') } });
  assert.deepEqual(arrive({ hash: '#r=abc', record: seenToday }), { kind: 'keep', invite: false });
  // Today's own roll in the address is today's world: keep it, nothing to mention.
  assert.deepEqual(arrive({ hash: rollHash(dailySeed('2026-11-19')), record: seenToday }), { kind: 'keep', invite: false });
});

test("an earlier day's world coming back in the address is this browser's stale link, so today opens", () => {
  const yesterday = { day: '2026-11-18', seed: dailySeed('2026-11-18') };
  const record = visitor({ daily: yesterday });
  assert.equal(arrive({ hash: rollHash(yesterday.seed), record }).kind, 'today');
  // The same link in a browser that never opened that day's world was shared by someone: show it.
  assert.deepEqual(arrive({ hash: rollHash(yesterday.seed) }), { kind: 'keep', invite: true });
});

test('the other product choices: the world they left, or the opening as always', () => {
  const left = takeSnapshot(sceneOf(OPENING), BEHAVIORS, { day: '2026-11-18' });
  assert.deepEqual(arrive({ opensOn: 'last', record: visitor({ left }) }), { kind: 'last' });
  assert.deepEqual(arrive({ opensOn: 'last' }), { kind: 'keep', invite: true });
  assert.deepEqual(arrive({ opensOn: 'same' }), { kind: 'keep', invite: true });
  const yesterday = { day: '2026-11-18', seed: dailySeed('2026-11-18') };
  assert.deepEqual(arrive({ opensOn: 'same', hash: rollHash(yesterday.seed), record: visitor({ daily: yesterday }) }), { kind: 'keep', invite: true });
});

test('roll links read back the seed the HUD wrote', () => {
  for (const seed of [0, 1, 35, 36, 0xffffffff, 123456789]) assert.equal(parseRoll(rollHash(seed)), seed);
  assert.equal(parseRoll('#x=1&r=zz'), 35 * 36 + 35);
  assert.equal(parseRoll(''), null);
  assert.equal(parseRoll('#rr=1'), null);
});

// ---- the record --------------------------------------------------------------

test('a stored record survives garbage, old shapes and broken worlds', () => {
  assert.equal(parseRecord(null), null);
  assert.equal(parseRecord('not json'), null);
  assert.equal(parseRecord('{"v":2}'), null);
  assert.equal(parseRecord('{"v":1}'), null); // no day at all: not a record
  const good = takeSnapshot(sceneOf(OPENING), BEHAVIORS, { day: '2026-11-18' });
  const broken = { ...good, scene: { ...good.scene, planes: [{ behaviorId: 'flow' }] } };
  const r = parseRecord(JSON.stringify({
    v: 1, visits: 'many', lastDay: '2026-11-18', days: -3, news: 2.9,
    daily: { day: 'yesterday', seed: 5 }, invited: 7, kept: [good, broken, null, 'x'], left: broken,
  }));
  assert.deepEqual({ ...r, kept: r.kept.length }, {
    v: 1, visits: 0, firstDay: '2026-11-18', lastDay: '2026-11-18', days: 0, news: 2,
    daily: null, invited: '', kept: 1, left: null,
  });
});

test('visits and days are counted, and a refusing storage is not fatal', () => {
  const r = freshRecord('2026-11-18', 4);
  countVisit(r, '2026-11-18');
  countVisit(r, '2026-11-18');
  countVisit(r, '2026-11-20');
  assert.deepEqual([r.visits, r.days, r.firstDay, r.lastDay, r.news], [3, 2, '2026-11-18', '2026-11-20', 4]);
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(writeRecord(r, full), false);
  assert.equal(writeRecord(r, null), false);
  assert.equal(readRecord({ getItem: () => { throw new Error('SecurityError'); }, setItem() {} }), null);
  const ok = memoryStorage();
  assert.equal(writeRecord(r, ok), true);
  assert.deepEqual(readRecord(ok), r);
});

// ---- worlds ------------------------------------------------------------------

test('a world is its sheets, not the view, the particle count or the brightness', () => {
  const a = sceneOf(OPENING);
  const b = cloneScene(a);
  b.camera.yaw = 2;
  b.render.brightness = 3;
  b.planes[0].particleCount = 5;
  b.planes[1].params = { speed: 1 }; // same sliders, a different object
  assert.ok(sameWorld(a, b));
  b.planes[2].params.speed = 1.5;
  assert.ok(!sameWorld(a, b));
  assert.ok(!sameWorld(a, sceneOf(OPENING.slice(1))));
  assert.equal(a.camera.yaw, 0.6); // a copy is deep
  assert.equal(a.planes[2].params.speed, 1);
});

test('worlds are named by what most sheets do, and only load when every rule exists', () => {
  assert.equal(worldName(sceneOf(['flow', 'galaxy', 'galaxy', 'wells']), BEHAVIORS), 'galaxy + flow');
  assert.equal(worldName(sceneOf(['curl', 'curl']), BEHAVIORS), 'curl');
  assert.equal(worldName(sceneOf(['flow', 'old-rule', 'old-rule']), BEHAVIORS), 'old-rule + flow');
  assert.ok(usable(sceneOf(OPENING), BEHAVIORS));
  assert.ok(!usable(sceneOf(['flow', 'old-rule']), BEHAVIORS));
  assert.ok(!usable(sceneOf([]), BEHAVIORS));
  assert.ok(isScene(sceneOf(OPENING)));
  assert.ok(isScene(JSON.parse(JSON.stringify(cloneScene(sceneOf(OPENING))))));
  assert.ok(!isScene({ ...sceneOf(OPENING), camera: { target: [0, 0], yaw: 0, pitch: 0, distance: 1, fovY: 1 } }));
  assert.ok(!isScene({ ...sceneOf(OPENING), planes: [{ ...plane('flow', 0), particleCount: 0 }] }));
});

// ---- the list of worlds seen -------------------------------------------------

test('previous and next walk the worlds seen like a browser, and a new world drops what lay ahead', () => {
  const h = new WorldHistory(4);
  assert.equal(h.current, null);
  assert.equal(h.back(), null);
  for (const seed of [1, 2, 3]) h.visit({ seed });
  assert.equal(h.back().seed, 2);
  assert.equal(h.back().seed, 1);
  assert.equal(h.back(), null);
  assert.equal(h.forward().seed, 2);
  h.visit({ seed: 9 }); // 3 is dropped
  assert.equal(h.forward(), null);
  assert.equal(h.back().seed, 2);
  h.forward();
  h.prepend({ seed: 0 });
  assert.equal(h.current.seed, 9);
  assert.equal(h.length, 4);
  h.visit({ seed: 10 }); // over the limit: the oldest goes
  assert.equal(h.length, 4);
  assert.deepEqual([h.back().seed, h.back().seed, h.back().seed, h.back()], [9, 2, 1, null]);
  h.replace({ seed: 7 });
  assert.equal(h.current.seed, 7);
});

// ---- news --------------------------------------------------------------------

test('news arrives oldest first, two lines a visit', () => {
  const news = ['a', 'b', 'c'].map((text) => ({ text }));
  assert.deepEqual(unseenNews(0, 2, news).map((n) => n.text), ['a', 'b']);
  assert.deepEqual(unseenNews(2, 2, news).map((n) => n.text), ['c']);
  assert.deepEqual(unseenNews(3, 2, news), []);
  assert.deepEqual(unseenNews(99, 2, news), []);
  assert.deepEqual(unseenNews(-1, 2, news).map((n) => n.text), ['a', 'b']);
  assert.ok(NEWS.every((n) => n.text && n.text.length < 40));
});

// ---- the whole thing ---------------------------------------------------------

test('a first visit changes nothing, and is remembered', () => {
  const w = world();
  const r = w.mount();
  assert.deepEqual(r.arrival, { kind: 'untouched', reason: 'first-visit' });
  assert.equal(w.rules(), OPENING.join(','));
  assert.equal(w.loads.length, 0);
  assert.deepEqual(w.said, []);
  const rec = stored(w.storage);
  assert.deepEqual([rec.visits, rec.days, rec.news, rec.firstDay], [1, 1, NEWS.length, '2026-11-19']);
  // Nothing is said to a newcomer, however long they stay.
  for (let i = 0; i < 1200; i++) w.frame(r, 0.05);
  assert.deepEqual(w.said, []);
  for (const id of ['returning.today', 'returning.previous', 'returning.keep', 'returning.news']) assert.ok(w.params.has(id), id);
  assert.ok(!w.params.has('returning.kept'));
  assert.deepEqual([...w.shortcuts.keys()], ['n', 'k', 'backspace']);
});

test('the second visit opens on today, labelled, and the world left behind is one step back', () => {
  const w = world();
  let r = w.mount();
  w.hud.randomize(41);
  w.frame(r);
  const leftRules = w.rules();
  r.remember(); // the page is closed
  r.dispose();

  w.time.tomorrow();
  const next = world({ storage: w.storage, time: w.time });
  r = next.mount();
  assert.equal(r.arrival.kind, 'today');
  next.frame(r);
  const seed = dailySeed('2026-11-20');
  assert.equal(next.address.hash, rollHash(seed));
  assert.deepEqual(next.said, ["today's world | nov 20"]);
  assert.deepEqual(stored(next.storage).daily, { day: '2026-11-20', seed });
  assert.deepEqual([stored(next.storage).visits, stored(next.storage).days], [2, 2]);
  const todayRules = next.rules();

  r.back();
  assert.equal(next.rules(), leftRules);
  assert.equal(next.loads.length, 1);
  r.back();
  assert.equal(next.said.at(-1), 'no earlier world');
  r.forward();
  next.frame(r);
  assert.equal(next.rules(), todayRules);
});

test("the same day's world is the same for everyone, and N goes there from anywhere", () => {
  const a = world();
  const b = world();
  const ra = a.mount();
  const rb = b.mount();
  ra.today();
  a.frame(ra);
  b.hud.randomize(5);
  b.frame(rb);
  b.shortcuts.get('n').run({ repeat: false });
  b.frame(rb);
  assert.equal(a.rules(), b.rules());
  assert.equal(a.address.hash, b.address.hash);
  // Already there: say so again, but do not roll or add a step.
  const loads = b.loads.length;
  rb.today();
  b.frame(rb);
  assert.equal(b.said.filter((s) => s.startsWith("today's world")).length, 2);
  rb.back();
  b.frame(rb);
  assert.equal(b.address.hash, rollHash(5));
  assert.equal(b.loads.length, loads);
});

test('backspace undoes a roll: plain rolls are replayed, a tuned world comes back with its sliders', () => {
  const w = world();
  const r = w.mount();
  w.hud.randomize(11);
  w.frame(r);
  const first = w.rules();
  w.tune(1.77); // a hand on a slider
  w.hud.randomize(12);
  w.frame(r);
  w.hud.randomize(13);
  w.frame(r);
  assert.equal(w.loads.length, 0);

  w.shortcuts.get('backspace').run({ repeat: false, shiftKey: false }); // back to 12: a plain roll, replayed
  w.frame(r);
  assert.equal(w.address.hash, rollHash(12));
  assert.equal(w.loads.length, 0);

  r.back(); // back to 11, which was tuned: the stored world, slider included
  assert.equal(w.loads.length, 1);
  assert.equal(w.rules(), first);
  assert.equal(w.app.planes[0].desc.params.speed, 1.77);
  assert.equal(w.address.hash, rollHash(11));

  r.back(); // the opening
  assert.equal(w.rules(), OPENING.join(','));
  assert.equal(w.address.hash, '');
  r.back();
  assert.equal(w.said.at(-1), 'no earlier world');

  w.shortcuts.get('backspace').run({ repeat: false, shiftKey: true }); // shift: next
  assert.equal(w.app.planes[0].desc.params.speed, 1.77);
  w.hud.randomize(20); // a new roll from here drops 12 and 13
  w.frame(r);
  r.forward();
  assert.equal(w.said.at(-1), 'no later world');
});

test('undo keeps the camera where it is; a kept world brings its own view back', () => {
  const w = world();
  const r = w.mount();
  w.hud.randomize(3);
  w.frame(r);
  r.keep();
  const id = stored(w.storage).kept[0].id;
  assert.deepEqual(stored(w.storage).kept[0].scene.camera.yaw, 0.6);
  w.app.camera = { ...w.app.camera, yaw: 2.5 };
  w.hud.randomize(4);
  w.frame(r);
  r.back(); // seed entry: replayed, no scene load, camera untouched
  w.frame(r);
  assert.equal(w.app.camera.yaw, 2.5);
  r.back(); // the opening: loaded, but with the live camera
  assert.equal(w.loads.at(-1).camera.yaw, 2.5);
  r.open(id);
  assert.equal(w.loads.at(-1).camera.yaw, 0.6);
  assert.match(w.said.at(-1), /kept nov 19$/);
});

test('K keeps a world exactly, keeping it again refreshes it, and it survives to the next visit', () => {
  const w = world();
  let r = w.mount();
  w.hud.randomize(7);
  w.frame(r);
  w.tune(0.33);
  w.shortcuts.get('k').run({ repeat: false });
  assert.match(w.said.at(-1), /^kept \| .* 1 kept$/);
  w.app.camera = { ...w.app.camera, distance: 9 };
  r.keep(); // same world, new view: still one
  assert.equal(stored(w.storage).kept.length, 1);
  assert.equal(stored(w.storage).kept[0].scene.camera.distance, 9);
  w.hud.randomize(8);
  w.frame(r);
  r.keep();
  assert.equal(stored(w.storage).kept.length, 2);
  assert.ok(w.params.has('returning.kept') && w.params.has('returning.forget'));
  assert.equal(w.params.get('returning.kept').options.length, 3);
  const tunedId = stored(w.storage).kept[1].id;
  r.dispose();

  // Days later, in a browser whose list of behaviors is the same: the world opens as it was.
  w.time.tomorrow();
  const next = world({ storage: w.storage, time: w.time });
  r = next.mount();
  next.frame(r);
  next.params.get('returning.kept').onChange(tunedId);
  assert.equal(next.app.planes[0].desc.params.speed, 0.33);
  assert.equal(next.app.camera.distance, 9);
  assert.equal(next.address.hash, rollHash(7));
  r.forget();
  assert.equal(next.said.at(-1).split(' | ')[0], 'forgotten');
  assert.equal(stored(next.storage).kept.length, 1);
  r.forget();
  assert.equal(next.said.at(-1).split(' | ')[0], 'not a kept world');
  r.back(); // opening a kept world is a step like any other
  next.frame(r);
  assert.equal(next.address.hash, rollHash(dailySeed('2026-11-20')));
});

test('the kept list has a size, and a world whose rule is gone says so instead of breaking', () => {
  const w = world();
  const r = w.mount();
  for (let i = 0; i < MAX_KEPT + 2; i++) {
    w.hud.randomize(100 + i);
    w.frame(r);
    r.keep();
  }
  assert.equal(stored(w.storage).kept.length, MAX_KEPT);
  assert.equal(w.said.at(-1).split(' | ')[0], 'kept worlds are full');

  // A later version of the site drops a behavior that one kept world uses.
  const rec = stored(w.storage);
  rec.kept[0].scene.planes[0].behaviorId = 'removed-rule';
  w.storage.setItem(STORE_KEY, JSON.stringify(rec));
  const later = world({ storage: w.storage, search: '?daily=0' });
  const r2 = later.mount();
  assert.equal(r2.record.kept.length, MAX_KEPT); // still listed: the rule may come back
  r2.open(rec.kept[0].id);
  assert.equal(later.loads.length, 0);
  assert.equal(later.said.at(-1).split(' | ')[0], 'this world cannot open');
  r2.open(rec.kept[1].id);
  assert.equal(later.loads.length, 1);
});

test('someone who returns is told what is new, once, two lines a visit, never over a busy moment', () => {
  const storage = memoryStorage();
  const before = countVisit(freshRecord('2026-11-18', 0), '2026-11-18');
  writeRecord(before, storage);
  let opening = true;
  const w = world({ storage, search: '?daily=0' }); // an explicit address: nothing opens by itself
  const r = w.mount({ isOpening: () => opening });
  assert.equal(r.arrival.kind, 'untouched');
  for (let i = 0; i < 400; i++) w.frame(r, 0.05); // 20 s of the opening: silence
  assert.deepEqual(w.said, []);
  opening = false;
  for (let i = 0; i < 100; i++) w.frame(r, 0.05); // 5 s of calm: not yet
  assert.deepEqual(w.said, []);
  for (let i = 0; i < 40; i++) w.frame(r, 0.05);
  assert.deepEqual(w.said, [`new: ${NEWS[0].text} | ${NEWS[0].key}`]);
  assert.equal(stored(storage).news, 1);
  w.hud.panelOpen = true; // the menu is open: wait
  for (let i = 0; i < 400; i++) w.frame(r, 0.05);
  assert.equal(w.said.length, 1);
  w.hud.panelOpen = false;
  for (let i = 0; i < 400; i++) w.frame(r, 0.05);
  assert.equal(w.said.length, 2);
  assert.equal(stored(storage).news, 2);
  for (let i = 0; i < 2000; i++) w.frame(r, 0.05); // and no more this visit
  assert.equal(w.said.length, 2);

  // The menu's "what's new" repeats the latest lines without counting them again.
  w.hud.panelOpen = true;
  w.params.get('returning.news').run();
  assert.equal(w.hud.panelOpen, false);
  w.frame(r, 0.05);
  assert.equal(w.said.length, 3);
  assert.equal(stored(storage).news, 2);
});

test('a visitor from before this existed is recognised by the older keys', () => {
  const rolledBefore = world({ rolled: true });
  assert.equal(rolledBefore.mount().arrival.kind, 'today');
  const sawTheIntro = world({ storage: memoryStorage({ 'strata.ux.v1': JSON.stringify({ visits: 2, learned: [] }) }) });
  assert.equal(sawTheIntro.mount().arrival.kind, 'today');
  assert.equal(stored(sawTheIntro.storage).news, 0);
});

test('a first visit is never mistaken for a return by what this same page load wrote', () => {
  // The opening counts its visit before this module mounts: one visit on record is this one.
  const counted = world({ storage: memoryStorage({ 'strata.ux.v1': JSON.stringify({ visits: 1, learned: [] }) }) });
  const r = counted.mount();
  assert.deepEqual(r.arrival, { kind: 'untouched', reason: 'first-visit' });
  for (let i = 0; i < 400; i++) counted.frame(r, 0.05);
  assert.deepEqual(counted.said, [], 'no day, no invitation and no news on a first visit');
  assert.equal(counted.rules(), OPENING.join(','));
  assert.equal(stored(counted.storage).news, NEWS.length);

  // A shared link's roll is replayed at load, which marks the die as rolled: that is the link, not the person.
  const linked = world({ hash: '#r=abc', rolled: true });
  const viaLink = linked.mount();
  assert.deepEqual(viaLink.arrival, { kind: 'untouched', reason: 'first-visit' });
  for (let i = 0; i < 400; i++) linked.frame(viaLink, 0.05);
  assert.deepEqual(linked.said, []);
});

test('a shared roll is shown as it is, and today is mentioned once that day', () => {
  const storage = memoryStorage();
  writeRecord(countVisit(freshRecord('2026-11-18', NEWS.length), '2026-11-18'), storage);
  const w = world({ storage, hash: '#r=abc' });
  const r = w.mount();
  assert.deepEqual(r.arrival, { kind: 'keep', invite: true });
  for (let i = 0; i < 200; i++) w.frame(r, 0.05);
  assert.deepEqual(w.said, ["today's world is new | press N"]);
  assert.equal(stored(storage).invited, '2026-11-19');
  // Rolling away and stepping back replays the shared roll.
  w.hud.randomize(77);
  w.frame(r);
  r.back();
  assert.equal(w.address.hash, '#r=abc');

  const again = world({ storage, hash: '#r=abc' });
  const r2 = again.mount();
  assert.deepEqual(r2.arrival, { kind: 'keep', invite: false });
  for (let i = 0; i < 400; i++) again.frame(r2, 0.05);
  assert.deepEqual(again.said, []);
});

test("yesterday's world in the address gives way to today's, and is still one step back", () => {
  const w = world({ rolled: true });
  let r = w.mount();
  w.frame(r);
  const yesterdayRules = w.rules();
  r.remember();
  const stale = w.address.hash;
  assert.equal(stale, rollHash(dailySeed('2026-11-19')));

  w.time.tomorrow();
  const next = world({ storage: w.storage, time: w.time, hash: stale });
  r = next.mount();
  assert.equal(r.arrival.kind, 'today');
  next.frame(r);
  assert.equal(next.address.hash, rollHash(dailySeed('2026-11-20')));
  r.back();
  assert.equal(next.rules(), yesterdayRules);
});

test('with no storage at all the page still works, and says how long a kept world lasts', () => {
  const w = world({ storage: null });
  const r = w.mount();
  assert.equal(r.arrival.kind, 'untouched');
  w.hud.randomize(2);
  w.frame(r);
  r.keep();
  assert.equal(w.said.at(-1), 'kept | only until this tab closes');
  assert.equal(r.record.kept.length, 1);
  r.open(r.record.kept[0].id);
  r.back();
  w.frame(r);
  assert.equal(w.address.hash, rollHash(2));
});

test('while a render job owns the world nothing here moves it', () => {
  const w = world({ rolled: true, search: '?daily=0' });
  const r = w.mount();
  w.hud.randomize(1);
  w.frame(r);
  w.hud.busy = true;
  const hash = w.address.hash;
  r.today();
  r.back();
  r.forward();
  r.remember();
  assert.equal(w.address.hash, hash);
  assert.equal(w.loads.length, 0);
  assert.equal(stored(w.storage).left, null);
});

test('a world kept while the dice are still landing is the world that lands, once', () => {
  const w = world({ sweep: true });
  const r = w.mount();
  w.frame(r);
  w.hud.randomize(9);
  w.frame(r); // the first sheet has changed, five still show the opening
  r.keep();
  const early = stored(w.storage).kept[0];
  assert.notEqual(early.scene.planes[5].behaviorId, BEHAVIORS[(9 + 5) % BEHAVIORS.length].id, 'the copy at the press is mid-roll');
  // Pressing K again a moment later is the same world, not a second one.
  w.frame(r);
  r.keep();
  assert.equal(stored(w.storage).kept.length, 1);
  // The roll lands, then nothing changes for a while: the copy is taken again.
  w.app.camera = { ...w.app.camera, yaw: 2 }; // the camera drifted meanwhile
  for (let i = 0; i < 80; i++) w.frame(r, 0.05);
  const kept = stored(w.storage).kept;
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].scene.planes.map((p) => p.behaviorId), w.rules().split(','));
  assert.ok(sameWorld(kept[0].scene, w.app.getScene()));
  assert.notEqual(kept[0].scene.camera.yaw, 2, 'the view stays the one at the key press');
  // It is the world on screen: forgetting it works, and keeping it again adds nothing.
  r.keep();
  assert.equal(stored(w.storage).kept.length, 1);
  r.forget();
  assert.equal(stored(w.storage).kept.length, 0);
});

test('a world kept mid-roll and left before it lands is stored as it was on leaving, and can be forgotten at once', () => {
  const w = world({ sweep: true });
  const r = w.mount();
  w.frame(r);
  w.hud.randomize(9);
  w.frame(r);
  r.keep();
  r.forget(); // still landing: the world on screen is the one just kept
  assert.equal(stored(w.storage).kept.length, 0);
  r.keep();
  w.frame(r);
  w.frame(r); // three sheets have changed
  const onLeaving = w.rules();
  w.hud.randomize(10); // rolled away before it landed
  for (let i = 0; i < 80; i++) w.frame(r, 0.05);
  const kept = stored(w.storage).kept;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].scene.planes.map((p) => p.behaviorId).join(','), onLeaving);
});

test('when the browser refuses to store a kept world it still lasts until the tab closes', () => {
  // Storage that reads fine but takes no more writes, like a full one.
  const full = memoryStorage();
  const w = world({ storage: full });
  const r = w.mount();
  w.frame(r);
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  r.keep();
  assert.equal(w.said.at(-1), 'kept | only until this tab closes');
  // Later edits must not fall back to the stored record, which never got the kept world.
  r.today();
  w.frame(r);
  assert.equal(r.record.kept.length, 1);
  r.open(r.record.kept[0].id);
  assert.equal(w.rules(), OPENING.join(','));
});

test('stepping through worlds never changes the particle total or the brightness; a kept world brings its own', () => {
  const scene = sceneOf(OPENING);
  assert.equal(withParticleTotal(scene, 6000), scene, 'already that many: the same scene');
  assert.equal(withParticleTotal(scene, 0), scene);
  const tripled = withParticleTotal(scene, 18000);
  assert.deepEqual(tripled.planes.map((p) => p.particleCount), [3000, 3000, 3000, 3000, 3000, 3000]);
  assert.equal(scene.planes[0].particleCount, 1000, 'the stored scene is not edited');

  const w = world();
  const r = w.mount();
  w.frame(r);
  r.keep(); // the opening, at 6000 particles and brightness 1
  const id = stored(w.storage).kept[0].id;
  w.hud.randomize(5);
  w.frame(r);
  w.resize(4); // the person asks for four times the particles, and dims the light to match
  w.app.getScene().render.brightness = 0.25;
  w.frame(r);
  assert.equal(w.particles(), 24000);
  r.back(); // to the opening, which was stored at 6000
  w.frame(r);
  assert.equal(w.rules(), OPENING.join(','));
  assert.equal(w.particles(), 24000, 'undo is not a change of budget');
  assert.equal(w.loads.at(-1).render.brightness, 0.25);
  r.open(id); // kept: exactly as it was
  assert.equal(w.particles(), 6000);
  assert.equal(w.loads.at(-1).render.brightness, 1);
});

test('a streamed world is never replaced by a stored one', () => {
  const storage = memoryStorage();
  const before = world({ storage });
  const first = before.mount();
  before.frame(first);
  first.keep();
  before.hud.randomize(3);
  before.frame(first);
  first.remember();

  const w = world({ storage, search: '?world=7', streamed: true });
  const r = w.mount();
  assert.equal(r.arrival.kind, 'untouched');
  r.keep();
  assert.equal(w.said.at(-1), 'this world cannot be kept | it streams in as you fly');
  r.open(r.record.kept[0].id);
  assert.equal(w.said.at(-1), 'kept worlds cannot open here | this world streams in as you fly');
  r.back(); // the world left last time is a stored scene: not offered here
  assert.equal(w.said.at(-1), 'no earlier world');
  assert.equal(w.loads.length, 0);
  // The dice still work, and so does undoing them.
  w.hud.randomize(4);
  w.frame(r);
  w.hud.randomize(5);
  w.frame(r);
  r.back();
  assert.equal(w.address.hash, rollHash(4));
});
