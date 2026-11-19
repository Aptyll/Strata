// Recovery policy: when a lost GPU device restarts the page by itself, with how
// many particles, and that it can never do so in a loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_RESTART_GAP_MS, LOAD_BLAME_MS, MIN_RESTART_PARTICLES,
  RestartLog, fewer, planRestart, restartUrl, shortCount,
} from '../policy';

const base = { particles: 2_000_000, bootParticles: 2_000_000, sinceLoadChangeMs: 10 * 60_000, sinceRestartMs: null, mayAuto: true };

test('a loss long after boot restarts the page as it was', () => {
  assert.deepEqual(planRestart(base), { auto: true, particles: null, blameLoad: false, repeat: false });
});

test('a loss right after boot halves the opening count', () => {
  const plan = planRestart({ ...base, sinceLoadChangeMs: 3000 });
  assert.deepEqual(plan, { auto: true, particles: 1_000_000, blameLoad: true, repeat: false });
});

test('a loss right after raising the count goes back to the opening count, not below it', () => {
  const plan = planRestart({ ...base, particles: 64_000_000, sinceLoadChangeMs: LOAD_BLAME_MS - 1 });
  assert.deepEqual(plan, { auto: true, particles: null, blameLoad: true, repeat: false });
});

test('a second loss inside the gap never restarts by itself and offers fewer particles', () => {
  for (const sinceLoadChangeMs of [1000, 10 * 60_000]) {
    const plan = planRestart({ ...base, sinceLoadChangeMs, sinceRestartMs: AUTO_RESTART_GAP_MS - 1 });
    assert.equal(plan.auto, false);
    assert.equal(plan.repeat, true);
    assert.equal(plan.particles, 1_000_000);
  }
});

test('after the gap it may restart by itself again', () => {
  assert.equal(planRestart({ ...base, sinceRestartMs: AUTO_RESTART_GAP_MS }).auto, true);
});

test('nothing restarts by itself when it may not (no storage, or a job is running)', () => {
  const plan = planRestart({ ...base, mayAuto: false });
  assert.equal(plan.auto, false);
  assert.equal(plan.repeat, false, 'and it is not called a repeat');
});

test('fewer never goes below the floor', () => {
  assert.equal(fewer(64_000_000), 32_000_000);
  assert.equal(fewer(12_000), MIN_RESTART_PARTICLES);
  assert.equal(fewer(1), MIN_RESTART_PARTICLES);
});

test('restartUrl pins the count and keeps the rest of the address', () => {
  assert.equal(restartUrl('https://x.test/Strata/?theme=red#r=abc', 1_000_000), 'https://x.test/Strata/?theme=red&particles=1000000#r=abc');
  assert.equal(restartUrl('https://x.test/Strata/?particles=8000000', 4_000_000.4), 'https://x.test/Strata/?particles=4000000');
  assert.equal(restartUrl('https://x.test/Strata/?theme=red#r=abc', null), 'https://x.test/Strata/?theme=red#r=abc');
});

test('the restart log survives a reload and reports the time since', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  let now = 1_000_000;
  const log = new RestartLog(storage, () => now);
  assert.equal(log.sinceLast(), null);
  assert.equal(log.works(), true);
  assert.equal(store.size, 0, 'the probe leaves nothing behind');
  assert.equal(log.mark(), true);
  now += 5000;
  assert.equal(new RestartLog(storage, () => now).sinceLast(), 5000);
});

test('a blocked or missing storage is reported, not thrown', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
  for (const storage of [blocked, null]) {
    const log = new RestartLog(storage);
    assert.equal(log.sinceLast(), null);
    assert.equal(log.works(), false);
    assert.equal(log.mark(), false);
  }
});

test('shortCount reads like the HUD', () => {
  assert.equal(shortCount(64_000_000), '64M');
  assert.equal(shortCount(1_500_000), '1.5M');
  assert.equal(shortCount(62_500), '62.5K');
  assert.equal(shortCount(10_000), '10K');
  assert.equal(shortCount(999), '999');
  assert.equal(shortCount(2_000_000_000), '2B');
});
