/**
 * Which colour range a recording gets when none is asked for. Live (realtime)
 * recordings must not read frames back on the CPU: that waits for the GPU in
 * the frame loop's own task, and docs/capture.md promises that a live
 * recording drops frames rather than stall the loop. Runs under `npm test`,
 * which picks this file up by name; a failing check throws.
 */
import { recordingRange } from './recorder';

const cases: [Parameters<typeof recordingRange>[0], 'limited' | 'full'][] = [
  [{}, 'limited'],
  [{ timing: 'fixed' }, 'limited'],
  [{ timing: 'realtime' }, 'full'],
  [{ timing: 'realtime', range: 'limited' }, 'limited'],
  [{ timing: 'fixed', range: 'full' }, 'full'],
];

for (const [opts, want] of cases) {
  const got = recordingRange(opts);
  if (got !== want) throw new Error(`recorder: range for ${JSON.stringify(opts)} is ${got}, expected ${want}`);
}
