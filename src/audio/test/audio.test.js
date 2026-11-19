// Pure checks for the soundtrack (no Web Audio needed). Run: npm test -- audio
import { test } from "node:test";
import assert from "node:assert/strict";
import { compose } from "../performance";
import { ladderScore, scoreFromTimeline } from "../timeline";
import { CHORDS, nextChord, VOICE_ENTRY } from "../harmony";
import { chordEnvelope, CHORD_FADE_IN, CHORD_FADE_OUT, CHORD_OUT_DELAY } from "../graph";
import { encodeWav } from "../wav";
import { measureLoudness } from "../loudness";
import { VOICES } from "../types";

test("the same score always composes the same performance", () => {
  const a = compose(ladderScore({ seconds: 20 }));
  const b = compose(ladderScore({ seconds: 20 }));
  assert.equal(a.frames, 20 * 60);
  assert.deepEqual(a.notes, b.notes);
  assert.deepEqual(a.segments, b.segments);
  for (let v = 0; v < VOICES; v++) assert.deepEqual(a.level(v), b.level(v));
  assert.deepEqual(a.cutoff(), b.cutoff());
  assert.ok(a.notes.length > 0, "a climb to a trillion should have glints and bells");
});

test("a different seed gives different glints", () => {
  const a = compose(ladderScore({ seconds: 20, seed: 1 }));
  const b = compose(ladderScore({ seconds: 20, seed: 2 }));
  assert.notDeepEqual(a.notes, b.notes);
});

test("a roll always moves to another chord", () => {
  for (let current = 0; current < CHORDS.length; current++) {
    for (let seed = 0; seed < 50; seed++) {
      const next = nextChord(current, seed * 2654435761);
      assert.notEqual(next, current);
      assert.ok(next >= 0 && next < CHORDS.length);
    }
  }
  const perf = compose(ladderScore({ seconds: 60 }));
  assert.equal(perf.segments.length, 4, "three rolls plus the opening chord");
});

test("voices enter with the count: one at a thousand, all near a trillion", () => {
  const at = (particles) => {
    const score = scoreFromTimeline({ fps: 30, duration: 1, particles: () => particles, camera: () => ({ yaw: 0, pitch: 0, distance: 1 }) });
    const perf = compose(score);
    return Array.from({ length: VOICES }, (_, v) => perf.level(v)[perf.frames - 1]);
  };
  const few = at(1e3);
  assert.ok(few[0] > 0.3);
  for (let v = 1; v < VOICES; v++) assert.equal(few[v], 0, `voice ${v} at 1e3`);
  const all = at(1e12);
  for (let v = 0; v < VOICES; v++) assert.ok(all[v] > 0.05, `voice ${v} at 1e12`);
  assert.equal(VOICE_ENTRY.length, VOICES);
});

test("a chord's fade out waits for its fade in", () => {
  const quick = chordEnvelope({ start: 10, chord: 1 }, { start: 10.5, chord: 2 }, false);
  assert.deepEqual(quick, [
    [10, 0],
    [10 + CHORD_FADE_IN, 1],
    [10 + CHORD_FADE_IN, 1],
    [10 + CHORD_FADE_IN + CHORD_FADE_OUT, 0],
  ]);
  const slow = chordEnvelope({ start: 0, chord: 0 }, { start: 30, chord: 1 }, true);
  assert.deepEqual(slow, [
    [0, 1],
    [30 + CHORD_OUT_DELAY, 1],
    [30 + CHORD_OUT_DELAY + CHORD_FADE_OUT, 0],
  ]);
});

test("WAV header and samples", () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, 0.25, -0.25, -1]);
  const check = async (bitDepth, header) => {
    const bytes = new Uint8Array(await encodeWav([left, right], { bitDepth, sampleRate: 48000 }).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    assert.equal(text(0, 4), "RIFF");
    assert.equal(text(8, 4), "WAVE");
    assert.equal(view.getUint32(4, true), bytes.length - 8);
    assert.equal(view.getUint16(22, true), 2);
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(view.getUint16(34, true), bitDepth);
    assert.equal(text(header - 8, 4), "data");
    assert.equal(view.getUint32(header - 4, true), 4 * 2 * (bitDepth / 8));
    return view;
  };
  return Promise.all([
    check(16, 44).then((view) => assert.ok(Math.abs(view.getInt16(44 + 4, true) - 16383) <= 1)),
    check(24, 44),
    check(32, 58).then((view) => assert.equal(view.getFloat32(58 + 8, true), 0.5)),
  ]);
});

test("loudness: a -20 dBFS 997 Hz sine in both channels is -20 LUFS", () => {
  const rate = 48000;
  const sine = new Float32Array(rate * 3);
  for (let i = 0; i < sine.length; i++) sine[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / rate);
  const { integrated, peak } = measureLoudness([sine, sine], rate);
  assert.ok(Math.abs(integrated + 20) < 0.1, `got ${integrated}`);
  assert.ok(Math.abs(peak + 20) < 0.01);
  assert.equal(measureLoudness([new Float32Array(rate), new Float32Array(rate)], rate).integrated, -Infinity);
});
