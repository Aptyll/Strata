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
