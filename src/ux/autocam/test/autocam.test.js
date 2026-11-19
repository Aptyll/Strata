// Auto camera: plays a long tour over seeded worlds through the real CameraRig
// and checks the eye never passes through a sheet, never jumps, and stays finite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scatterLayout, scatterRadius } from '../../../world/layout';
import { CameraRig } from '../../camera/rig';
import { AutoCamDirector } from '../director';
import { sheetsFrom, segmentHitsSheet } from '../shots';

const DT = 1 / 60;

function playTour({ planes, seed, seconds }) {
  const descs = scatterLayout({ planes, totalParticles: planes * 1e6, behaviorIds: ['a', 'b', 'c', 'd'], seed });
  // Uneven light so interest scoring has something to choose between.
  const instances = descs.map((desc, i) => ({ desc, capacity: desc.particleCount * (1 + (i % 5)), activeCount: 0 }));
  const sheets = sheetsFrom(instances);
  const rig = new CameraRig({ initial: { target: [0, 0, 0], distance: 2.2 * scatterRadius(planes) } });
  rig.setAspect(16 / 9);
  rig.update(DT);
  const director = new AutoCamDirector({ seed });
  director.start(rig.getPose());
  const view = () => ({ sheets, fovY: rig.options.fovY, aspect: 16 / 9 });
  const kinds = {};
  let lastKind = null;
  let prevEye = rig.eye.slice();
  let crossings = 0;
  let maxStep = 0;
  for (let f = 0; f < seconds / DT; f++) {
    const pose = director.step(DT, view);
    assert.ok(pose && Number.isFinite(pose.distance) && pose.target.every(Number.isFinite) && pose.orientation.every(Number.isFinite), 'finite pose');
    rig.steer(pose, 1);
    rig.update(DT);
    const eye = rig.eye.slice();
    for (const s of sheets) if (segmentHitsSheet(prevEye, eye, s, 1)) crossings++;
    maxStep = Math.max(maxStep, Math.hypot(eye[0] - prevEye[0], eye[1] - prevEye[1], eye[2] - prevEye[2]) / rig.distance);
    prevEye = eye;
    if (director.kind !== lastKind) {
      lastKind = director.kind;
      kinds[lastKind] = (kinds[lastKind] ?? 0) + 1;
    }
  }
  return { kinds, crossings, maxStep };
}

const WORLDS = process.env.SEEDS ? process.env.SEEDS.split(',').map((x) => [32, Number(x)]) : [[32, 1], [32, 7], [64, 3], [12, 5], [128, 2]];
for (const [planes, seed] of WORLDS) {
  test(`tour over ${planes} sheets, seed ${seed}`, () => {
    const r = playTour({ planes, seed, seconds: 600 });
    console.log(`  ${planes} sheets seed ${seed}:`, JSON.stringify(r.kinds), 'crossings', r.crossings, 'max eye step / distance', r.maxStep.toFixed(4));
    assert.equal(r.crossings, 0, 'eye passed through a sheet');
    // A cut would move the eye by a large fraction of its distance in one frame.
    assert.ok(r.maxStep < 0.1, `eye jumped ${r.maxStep}`);
    assert.ok(Object.keys(r.kinds).length >= 3, 'tour has variety');
  });
}

test('the director names the sheet a shot frames, once it has arrived, and only for one-sheet shots', () => {
  const planes = 12;
  const descs = scatterLayout({ planes, totalParticles: planes * 1e6, behaviorIds: ['a', 'b', 'c', 'd'], seed: 5 });
  const sheets = sheetsFrom(descs.map((desc) => ({ desc, capacity: desc.particleCount, activeCount: 0 })));
  const keys = new Set(sheets.map((s) => s.key));
  const rig = new CameraRig({ initial: { target: [0, 0, 0], distance: 2.2 * scatterRadius(planes) } });
  rig.setAspect(16 / 9);
  rig.update(DT);
  const director = new AutoCamDirector({ seed: 5 });
  assert.equal(director.sheet, null, 'nothing is framed before the tour starts');
  director.start(rig.getPose());
  const view = () => ({ sheets, fovY: rig.options.fovY, aspect: 16 / 9 });
  const framed = new Set();
  let wideOrInsideNamed = 0;
  let shots = 0;
  let lastKind = null;
  for (let f = 0; f < 300 / DT; f++) {
    director.step(DT, view);
    if (director.kind !== lastKind) {
      lastKind = director.kind;
      shots++;
      // A new shot starts with a blend: the camera is still on its way, so nothing is framed yet.
      if (shots > 1) assert.equal(director.sheet, null, 'a sheet is named before the camera arrives');
    }
    const s = director.sheet;
    if (!s) continue;
    assert.ok(keys.has(s.key), 'the framed sheet is one of the world\'s sheets');
    if (director.kind === 'wide' || director.kind === 'inside') wideOrInsideNamed++;
    framed.add(s.key);
  }
  assert.equal(wideOrInsideNamed, 0, 'a wide or inside shot shows many sheets and names none');
  assert.ok(framed.size >= 3, `the tour framed ${framed.size} sheets in five minutes`);
  director.stop();
  assert.equal(director.sheet, null, 'nothing is framed after the tour stops');
});
